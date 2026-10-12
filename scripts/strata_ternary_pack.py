"""Build a reversible, mixed ternary expert candidate for Strata 0.1.43.

Only explicitly selected layers change. Original GGUFs, tokenizer, routers,
attention, PLE and unselected experts stay intact. This is a least-squares
PTQ1_0 experiment, not Bonsai's trained compression recipe. PTQ1_0 groups
are transcoded losslessly to Strata's native Q2_0 (2.25 bits/weight).
No activation rotation is used. Task quality must be tested separately.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import time
import numpy as np
from strata_ternary_codec import fit_ternary, ptq1_to_strata_q2, unpack_ptq1


def align32(n):
    return (n + 31) // 32 * 32


def make_header(tensors):
    """Expert-only GGUF sidecar. Tensor shapes use GGUF's innermost-first order."""
    result = bytearray(struct.pack('<IIQQ', 0x46554747, 3, len(tensors), 0))
    offsets, pos = {}, 0
    for tensor in tensors:
        name = tensor.name.encode('utf8')
        result += struct.pack('<Q', len(name)) + name
        result += struct.pack('<I', len(tensor.shape)) + struct.pack('<' + 'Q' * len(tensor.shape), *tensor.shape)
        result += struct.pack('<IQ', 42, pos)
        offsets[tensor.name] = pos
        pos = align32(pos + tensor.elements // 64 * 18)
    result += bytes(align32(len(result)) - len(result))
    return bytes(result), offsets, pos


class Traits(ctypes.Structure):
    _fields_ = [('name', ctypes.c_char_p), ('block', ctypes.c_int64), ('interleave', ctypes.c_int64),
                ('size', ctypes.c_size_t), ('quantized', ctypes.c_bool), ('to_float', ctypes.c_void_p), ('from_float', ctypes.c_void_p)]


def build(args):
    sys.path.insert(0, str(args.strata / 'tools'))
    from gguf_reader import GGUFFile
    source = GGUFFile(args.gguf)
    layers = sorted(set(int(item) for item in args.layers.split(',')))
    if not layers or any(layer < 0 or layer >= 48 for layer in layers):
        raise ValueError('Select explicit layer numbers between 0 and 47')
    wanted = [f'blk.{layer}.ffn_{role}_exps.weight' for layer in layers for role in ('gate', 'up', 'down')]
    by_name = {t.name: t for t in source.tensors}
    tensors = [by_name[name] for name in wanted]
    if any(len(t.shape) != 3 or t.shape[0] % 128 or t.shape[2] != 256 for t in tensors):
        raise ValueError('This experiment requires the 256-expert Coder layout')
    if args.output.exists():
        raise ValueError('Output already exists; use a new candidate name')
    # Strata resolves native expert sidecars next to --native. Never overwrite a shard.
    sidecar = args.gguf.parent / (args.output.name + '-experts.gguf')
    partial = sidecar.with_suffix('.gguf.partial')
    if sidecar.exists() or partial.exists():
        raise ValueError('Candidate sidecar already exists')
    header, offsets, payload = make_header(tensors)
    if shutil.disk_usage(sidecar.parent).free < len(header) + payload + 2 * 1024**3:
        raise ValueError('Not enough disk space with 2 GiB headroom')
    dll = (args.runtime / 'ggml-base.dll').resolve()
    with os.add_dll_directory(str(dll.parent)):
        lib = ctypes.CDLL(str(dll))
    lib.ggml_get_type_traits.restype = ctypes.POINTER(Traits)
    report = {'kind': 'experimental-mixed-ternary', 'host': __import__('socket').gethostname(),
              'layers': layers, 'source': str(args.gguf), 'sourceBytes': args.gguf.stat().st_size,
              'decoderSha256': hashlib.sha256(dll.read_bytes()).hexdigest(),
              'rotation': False, 'storedBitsPerWeight': 2.25, 'ptqGroup': 128,
              'taskQualityMeasured': False, 'defaultSelected': False, 'tensors': []}
    args.output.mkdir(parents=True)
    started = time.monotonic()
    with args.gguf.open('rb') as inp, partial.open('xb') as out:
        out.write(header)
        for tensor in tensors:
            trait = lib.ggml_get_type_traits(tensor.type_id).contents
            if not trait.name or trait.name.decode().upper() != tensor.type_name or not trait.to_float:
                raise ValueError('Native decoder does not match the source tensor')
            decode = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int64)(trait.to_float)
            inp.seek(source.data_start + tensor.offset)
            out.seek(len(header) + offsets[tensor.name])
            source_hash, target_hash = hashlib.sha256(), hashlib.sha256()
            error, energy, remaining = 0., 0., tensor.elements
            while remaining:
                count = min(256 * 4096, remaining)  # bounded ~4 MiB float buffers
                raw = inp.read(count // trait.block * trait.size)
                if len(raw) != count // trait.block * trait.size:
                    raise ValueError('Truncated source')
                source_hash.update(raw)
                values = np.empty(count, np.float32)
                decode(ctypes.create_string_buffer(raw), values.ctypes.data, count)
                ptq = fit_ternary(values)
                codes, scales = unpack_ptq1(ptq)
                rebuilt = (codes * scales.astype(np.float32)[:, None]).reshape(-1)
                error += float(np.square(values.astype(np.float64) - rebuilt).sum())
                energy += float(np.square(values.astype(np.float64)).sum())
                target = ptq1_to_strata_q2(ptq)
                out.write(target); target_hash.update(target)
                remaining -= count
            item = {'name': tensor.name, 'sourceType': tensor.type_name,
                    'sourceBytes': tensor.expected_bytes(), 'candidateBytes': tensor.elements // 64 * 18,
                    'sourceSha256': source_hash.hexdigest(), 'candidateSha256': target_hash.hexdigest(),
                    'relativeMSE': error / max(energy, 1e-30)}
            report['tensors'].append(item)
            print(json.dumps(item), flush=True)
        out.truncate(len(header) + payload)
    partial.replace(sidecar)
    check = GGUFFile(sidecar)
    assert len(check.tensors) == len(tensors) and check.data_start == len(header)
    # Copy only tiny metadata; share immutable dense weights via a hard link.
    os.link(args.pack / 'dense.bin', args.output / 'dense.bin')
    for name in ('index.txt', 'conversions.json'):
        shutil.copy2(args.pack / name, args.output / name)
    shutil.copytree(args.pack / 'tokenizer', args.output / 'tokenizer')
    lines, total = [], 0
    for line in (args.pack / 'native_experts.txt').read_text().splitlines():
        if not line or line.startswith('#'): continue
        parts = line.split(); layer = int(parts[0]); blob = int(parts[4])
        parts[3] = str(total)
        if layer in layers:
            selected = [by_name[f'blk.{layer}.ffn_{r}_exps.weight'] for r in ('gate','up','down')]
            per = [t.elements // t.shape[2] // 64 * 18 for t in selected]
            blob = sum(per)
            parts = [str(layer), '42', '42', str(total), str(blob),
                     *[str(len(header) + offsets[t.name]) for t in selected], sidecar.name]
        total += blob * 256
        lines.append(' '.join(parts))
    if len(lines) != 48: raise ValueError('Expected all 48 source layers')
    (args.output / 'native_experts.txt').write_text(f'# strata native experts v3: experimental mixed ternary (n_expert 256, total {total})\n' + '\n'.join(lines) + '\n', encoding='utf8')
    report.update(sidecar=str(sidecar), expertArenaBytes=total, elapsedSeconds=time.monotonic()-started,
                  savedWeightBytes=sum(t['sourceBytes']-t['candidateBytes'] for t in report['tensors']))
    (args.output / 'ternary-experiment.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('strata','gguf','pack','runtime','output'):
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--layers', required=True)
    print(json.dumps(build(parser.parse_args()), indent=2))

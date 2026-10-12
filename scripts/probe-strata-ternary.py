"""Bounded real-weight probe; never overwrites or labels a model deployment.

Samples the immutable Coder GGUF by HTTP ranges. Compare group-128 ternary
with/without a paired Hadamard transform against the existing quantized
weights. Reconstruction and random-projection errors are NOT task scores.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.request
import numpy as np
from strata_ternary_codec import fit_ternary, hadamard, unpack_ptq1, ptq1_to_strata_q2

URL = ('https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/'
       'resolve/5348543e0147355ac9cbcb031184a3546350988e/'
       'IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf')


def fetch_range(url, start, size):
    request = urllib.request.Request(url + '?lumaflow_range=' + str(start), headers={'Range': f'bytes={start}-{start+size-1}'})
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {start}-{start+size-1}/'):
            raise ValueError('Server ignored range request; full download refused')
        raw = response.read(size + 1)
    if len(raw) != size: raise ValueError('Incomplete range response')
    return raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--strata', type=Path, required=True)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(args.strata / 'tools'))
    from gguf_reader import GGUFFile
    header = args.output / 'coder-header.gguf'
    if not header.exists(): header.write_bytes(fetch_range(URL, 0, 16 * 1024 * 1024))
    model = GGUFFile(header)
    dll = args.runtime / 'ggml-base.dll'
    with os.add_dll_directory(str(dll.resolve().parent)):
        lib = ctypes.CDLL(str(dll.resolve()))
    class Traits(ctypes.Structure):
        _fields_ = [('name', ctypes.c_char_p), ('block', ctypes.c_int64), ('interleave', ctypes.c_int64),
                    ('size', ctypes.c_size_t), ('quantized', ctypes.c_bool), ('to_float', ctypes.c_void_p), ('from_float', ctypes.c_void_p)]
    lib.ggml_get_type_traits.restype = ctypes.POINTER(Traits)
    report = {'source': URL, 'headerSha256': hashlib.sha256(header.read_bytes()).hexdigest(),
              'runtimeSha256': hashlib.sha256(dll.read_bytes()).hexdigest(), 'samples': [],
              'taskQualityMeasured': False, 'deployed': False,
              'scope': 'weight reconstruction vs already quantized Coder; no BF16 baseline or calibration activations'}
    for layer in (0, 23, 47):
        for role in ('gate', 'down'):
            tensor = next(t for t in model.tensors if t.name == f'blk.{layer}.ffn_{role}_exps.weight')
            trait = lib.ggml_get_type_traits(tensor.type_id).contents
            if trait.name.decode().upper() != tensor.type_name or not trait.to_float:
                raise ValueError('Oracle type mismatch')
            rows, width = 64, tensor.shape[0]
            size = rows * width // trait.block * trait.size
            # Different expert positions, fixed and reproducible.
            expert = {0: 0, 23: 127, 47: 255}[layer]
            offset = model.data_start + tensor.offset + expert * tensor.expected_bytes() // tensor.shape[2]
            cache = args.output / f'layer-{layer}-{role}.bin'
            if not cache.exists(): cache.write_bytes(fetch_range(URL, offset, size))
            raw = cache.read_bytes()
            if len(raw) != size: raise ValueError('Sample size mismatch')
            values = np.empty((rows, width), np.float32)
            buf = ctypes.create_string_buffer(raw)
            decode = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int64)(trait.to_float)
            decode(buf, values.ctypes.data, values.size)
            candidates = []
            for rotation in (0, 128, 1024):
                if rotation and width % rotation: continue
                working = hadamard(values, rotation) if rotation else values
                compressed = fit_ternary(working)
                codes, scales = unpack_ptq1(compressed)
                rebuilt = (codes * scales.astype(np.float32)[:, None]).reshape(values.shape)
                if rotation: rebuilt = hadamard(rebuilt, rotation)
                mse = float(np.square(rebuilt.astype(np.float64)-values).sum() / max(np.square(values.astype(np.float64)).sum(), 1e-30))
                candidates.append({'rotationBlock': rotation, 'relativeMSE': mse, 'ptqBytes': len(compressed),
                                   'strataQ2Bytes': len(ptq1_to_strata_q2(compressed)),
                                   'requiresRuntimeActivationTransform': bool(rotation)})
            report['samples'].append({'tensor': tensor.name, 'expert': expert, 'shape': list(values.shape),
                                      'sourceType': tensor.type_name, 'offset': offset, 'sourceBytes': size,
                                      'sha256': hashlib.sha256(raw).hexdigest(), 'candidates': candidates})
            (args.output / 'probe.json').write_text(json.dumps(report, indent=2), encoding='utf8')
            print(json.dumps(report['samples'][-1]), flush=True)
            time.sleep(.25)


if __name__ == '__main__': main()

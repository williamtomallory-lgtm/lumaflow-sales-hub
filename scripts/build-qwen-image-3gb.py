"""Build a CPU-streamed, full-architecture low-bit Qwen-Image-2.1 checkpoint.

This builder deliberately does not import torch or CUDA.  It reads the official
safetensors headers, seeks one source tensor in <=4 MiB chunks, and writes one
small safetensors file per source tensor.  The resulting files are a custom
LumaFlow format; they are not a Transformers/Diffusers checkpoint until the
matching runtime decodes them.

Quantization protocol (also written in LOCAL_IMAGE_MODEL.json):

* Flatten each tensor in C order and split it into groups of 128.  Only the
  final group is zero padded.
* 1 bit: code 0 decodes to -scale and code 1 to +scale.  The scale is the
  mean absolute value of the logical (unpadded) group.
* 2 bit: codes 0, 1, 2, 3 decode to -3*scale, -scale, +scale, +3*scale;
  scale is max(abs(group))/3.  The nearest of those four levels is selected.
* 4 bit: codes 0..15 decode to -15,-13,...,-1,+1,...,+13,+15 times
  ``scale``, where scale is max(abs(group))/15.  The nearest odd level is
  selected.
* Packed codes are little endian within each byte (one code per bit for 1 bit,
  four two-bit codes for 2 bit, and low/high nibbles for 4 bit).  Scales are
  float16.
* Scalar/1-D tensors and high-dimensional tensors that are not named
  ``*.weight`` are retained as float32 under the ``weight`` key.  This keeps
  VAE ``*.gamma`` normalization parameters out of the convolution quantizer.

All original tensor names, shapes, and layers are retained in the manifest.
The aggressive bit widths are intentional to meet the <=3,000,000,000 byte
weight budget; quality is not validated by this script.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import numpy as np
from safetensors.numpy import save_file


SOURCE = "Qwen/Qwen-Image-2.1"
REVISION = "790c92633540aa0cb11d9abf19eb46d861714758"
GROUP_SIZE = 128
MAX_SOURCE_READ_BYTES = 4 * 1024 * 1024
MAX_WEIGHT_BYTES = 3_000_000_000
FORMAT = "lumaflow-qwen-image-3gb-v2"

_ITEMSIZE = {
    "BF16": 2,
    "F16": 2,
    "F32": 4,
    "F64": 8,
    "I8": 1,
    "U8": 1,
    "I16": 2,
    "U16": 2,
    "I32": 4,
    "U32": 4,
    "I64": 8,
    "U64": 8,
    "BOOL": 1,
}


@dataclass(frozen=True)
class SourceTensor:
    component: str
    name: str
    path: Path
    data_offset: int
    dtype: str
    shape: tuple[int, ...]
    nbytes: int

    @property
    def elements(self) -> int:
        return math.prod(self.shape) if self.shape else 1


def read_safetensors_header(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        raw_size = handle.read(8)
        if len(raw_size) != 8:
            raise ValueError(f"Truncated safetensors header: {path}")
        header_size = struct.unpack("<Q", raw_size)[0]
        if header_size > 128 * 1024 * 1024:
            raise ValueError(f"Unreasonable safetensors header: {path} ({header_size})")
        raw_header = handle.read(header_size)
        if len(raw_header) != header_size:
            raise ValueError(f"Truncated safetensors header body: {path}")
    header = json.loads(raw_header)
    if not isinstance(header, dict):
        raise ValueError(f"Invalid safetensors header: {path}")
    return header


def source_files(component_dir: Path) -> list[Path]:
    index_files = sorted(component_dir.glob("*.safetensors.index.json"))
    if index_files:
        index = json.loads(index_files[0].read_text(encoding="utf-8"))
        mapped = index.get("weight_map")
        if not isinstance(mapped, dict):
            raise ValueError(f"Missing weight_map in {index_files[0]}")
        return [component_dir / name for name in sorted(set(mapped.values()))]
    return sorted(component_dir.glob("*.safetensors"))


def iter_source_tensors(source_dir: Path, component: str) -> Iterator[SourceTensor]:
    component_dir = source_dir / component
    if not component_dir.is_dir():
        raise FileNotFoundError(f"Missing source component: {component_dir}")
    for path in source_files(component_dir):
        header = read_safetensors_header(path)
        with path.open("rb") as handle:
            header_bytes = 8 + struct.unpack("<Q", handle.read(8))[0]
        for name, info in header.items():
            if name == "__metadata__":
                continue
            if not isinstance(info, dict) or "data_offsets" not in info:
                raise ValueError(f"Invalid tensor entry {name} in {path}")
            dtype = str(info["dtype"])
            shape = tuple(int(value) for value in info["shape"])
            start, end = (int(value) for value in info["data_offsets"])
            if dtype not in _ITEMSIZE:
                raise ValueError(f"Unsupported source dtype {dtype} for {component}/{name}")
            expected = (math.prod(shape) if shape else 1) * _ITEMSIZE[dtype]
            if end - start != expected:
                raise ValueError(f"Byte count mismatch for {component}/{name}: header={end-start}, expected={expected}")
            yield SourceTensor(component, name, path, header_bytes + start, dtype, shape, end - start)


def read_values(source: SourceTensor, start: int, count: int, handle) -> np.ndarray:
    """Read at most the caller's chunk from a source tensor as float32."""
    itemsize = _ITEMSIZE[source.dtype]
    handle.seek(source.data_offset + start * itemsize)
    raw = handle.read(count * itemsize)
    if len(raw) != count * itemsize:
        raise OSError(f"Short read for {source.component}/{source.name}: {len(raw)} != {count * itemsize}")
    if source.dtype == "BF16":
        # NumPy has no portable bfloat16 dtype.  Expand the bits without torch.
        words = np.frombuffer(raw, dtype="<u2", count=count)
        expanded = (words.astype(np.uint32) << 16).view("<f4")
        return expanded.copy()
    dtype = {
        "F16": "<f2",
        "F32": "<f4",
        "F64": "<f8",
        "I8": "<i1",
        "U8": "<u1",
        "I16": "<i2",
        "U16": "<u2",
        "I32": "<i4",
        "U32": "<u4",
        "I64": "<i8",
        "U64": "<u8",
        "BOOL": "?",
    }[source.dtype]
    return np.asarray(np.frombuffer(raw, dtype=dtype, count=count), dtype=np.float32).copy()


def quantization_bits(component: str, name: str, shape: tuple[int, ...]) -> int:
    if len(shape) <= 1:
        return 0
    # The source contains VAE normalization tensors such as ``norm.gamma``
    # with four dimensions.  They are not Linear/Embedding/Conv weights and
    # must remain exact float32 tensors.
    if not name.endswith(".weight"):
        return 0
    # Qwen's visual positional table is stored as ``*.pos_embed.weight`` but
    # is a learned positional parameter rather than a Linear/Embedding/Conv
    # weight.  Keep this unknown high-dimensional parameter exact.
    if name.endswith(".pos_embed.weight"):
        return 0
    if component == "transformer":
        # Keep the repeated transformer blocks at their previous 1-bit size.
        # The smaller non-block input/output/modulation matrices are upgraded
        # to 4-bit because they are disproportionately sensitive to sign-only
        # weights (modulation.1, norm_out.linear, proj_out, txt_in, and time
        # embeddings are all covered by this branch).
        return 1 if name.startswith("transformer_blocks.") else 4
    if component == "vae":
        return 4
    if component == "text_encoder":
        if any(f".mlp.{part}_proj.weight" in name for part in ("gate", "up", "down")):
            return 1
        return 2
    raise ValueError(f"Unknown component: {component}")


def quantized_data_bytes(elements: int, bits: int) -> int:
    groups = (elements + GROUP_SIZE - 1) // GROUP_SIZE
    if bits == 1:
        packed_per_group = GROUP_SIZE // 8
    elif bits == 2:
        packed_per_group = GROUP_SIZE // 4
    elif bits == 4:
        packed_per_group = GROUP_SIZE // 2
    else:
        raise ValueError(f"Unsupported quantization bits: {bits}")
    return groups * (packed_per_group + 2)


def planned_output_bytes(source: SourceTensor, bits: int) -> int:
    if bits == 0:
        return source.elements * 4
    return quantized_data_bytes(source.elements, bits)


def audit_plan(source_dir: Path) -> tuple[dict[str, list[SourceTensor]], dict[str, Any]]:
    sources: dict[str, list[SourceTensor]] = {}
    components: dict[str, Any] = {}
    total_source = 0
    total_output = 0
    for component in ("text_encoder", "transformer", "vae"):
        entries = list(iter_source_tensors(source_dir, component))
        if not entries:
            raise ValueError(f"No source tensors found for {component}")
        sources[component] = entries
        component_source = sum(entry.nbytes for entry in entries)
        component_output = 0
        counts: dict[str, int] = {}
        fallback_float_bytes = 0
        fallback_float_count = 0
        for entry in entries:
            bits = quantization_bits(component, entry.name, entry.shape)
            component_output += planned_output_bytes(entry, bits)
            counts[str(bits)] = counts.get(str(bits), 0) + 1
            if bits == 0:
                fallback_float_bytes += entry.elements * 4
                fallback_float_count += 1
        total_source += component_source
        total_output += component_output
        components[component] = {
            "tensor_count": len(entries),
            "source_bytes": component_source,
            "planned_weight_bytes": component_output,
            "bits_tensor_counts": counts,
            "float32_fallback_tensor_count": fallback_float_count,
            "float32_fallback_weight_bytes": fallback_float_bytes,
        }
    plan = {
        "source_bytes": total_source,
        "planned_weight_bytes": total_output,
        "limit_bytes": MAX_WEIGHT_BYTES,
        "headroom_bytes": MAX_WEIGHT_BYTES - total_output,
        "components": components,
    }
    if total_output >= MAX_WEIGHT_BYTES:
        raise ValueError(f"Planned weights exceed 3GB: {total_output} bytes")
    return sources, plan


def pack_codes(codes: np.ndarray, bits: int) -> np.ndarray:
    if bits == 1:
        return np.packbits(codes.astype(np.uint8), bitorder="little")
    if bits == 2:
        values = codes.astype(np.uint8, copy=False).reshape(-1, 4)
        return values[:, 0] | (values[:, 1] << 2) | (values[:, 2] << 4) | (values[:, 3] << 6)
    if bits == 4:
        values = codes.astype(np.uint8, copy=False).reshape(-1, 2)
        return values[:, 0] | (values[:, 1] << 4)
    raise ValueError(f"Unsupported quantization bits: {bits}")


def convert_quantized(source: SourceTensor, bits: int, output_path: Path) -> dict[str, Any]:
    elements = source.elements
    group_count = (elements + GROUP_SIZE - 1) // GROUP_SIZE
    packed_per_group = {1: 16, 2: 32, 4: 64}[bits]
    packed = np.empty(group_count * packed_per_group, dtype=np.uint8)
    scales = np.empty(group_count, dtype=np.float16)
    itemsize = _ITEMSIZE[source.dtype]
    chunk_elements = max(GROUP_SIZE, (MAX_SOURCE_READ_BYTES // itemsize) // GROUP_SIZE * GROUP_SIZE)
    group_cursor = 0
    with source.path.open("rb") as handle:
        for start in range(0, elements, chunk_elements):
            count = min(chunk_elements, elements - start)
            values = read_values(source, start, count, handle)
            group_count_chunk = (count + GROUP_SIZE - 1) // GROUP_SIZE
            padded_count = group_count_chunk * GROUP_SIZE
            padded = np.zeros(padded_count, dtype=np.float32)
            padded[:count] = values
            groups = padded.reshape(group_count_chunk, GROUP_SIZE)
            logical_counts = np.full(group_count_chunk, GROUP_SIZE, dtype=np.float32)
            if count % GROUP_SIZE:
                logical_counts[-1] = count % GROUP_SIZE
            abs_groups = np.abs(groups)
            if bits == 1:
                scales_chunk = abs_groups.sum(axis=1, dtype=np.float32) / logical_counts
                codes = (groups >= 0).astype(np.uint8).reshape(-1)
            elif bits == 2:
                scales_chunk = abs_groups.max(axis=1).astype(np.float32) / 3.0
                magnitude = abs_groups.reshape(-1)
                negative = groups.reshape(-1) < 0
                large = magnitude >= (scales_chunk.repeat(GROUP_SIZE) * 2.0)
                # 0/1/2/3 -> -3/-1/+1/+3.  A zero-scale group is encoded as
                # code 2; its decoded value is still exactly zero.
                codes = np.where(negative, np.where(large, 0, 1), np.where(large, 3, 2)).astype(np.uint8)
            else:
                scales_chunk = abs_groups.max(axis=1).astype(np.float32) / 15.0
                magnitude = abs_groups.reshape(-1)
                scale_values = scales_chunk.repeat(GROUP_SIZE)
                normalized = np.divide(magnitude, scale_values, out=np.zeros_like(magnitude), where=scale_values > 0)
                # Odd magnitudes 1,3,...,15 are represented by indices 0..7.
                # Ties at an even magnitude choose the lower odd level.
                odd_magnitude = np.clip(2.0 * np.floor(normalized / 2.0) + 1.0, 1.0, 15.0).astype(np.uint8)
                odd_index = (odd_magnitude - 1) // 2
                negative = groups.reshape(-1) < 0
                codes = np.where(negative, 7 - odd_index, 8 + odd_index).astype(np.uint8)
            if count % GROUP_SIZE:
                codes[count:] = 0
            packed_chunk = pack_codes(codes, bits)
            packed_start = group_cursor * packed_per_group
            packed[packed_start : packed_start + packed_chunk.size] = packed_chunk
            scales[group_cursor : group_cursor + group_count_chunk] = scales_chunk.astype(np.float16)
            group_cursor += group_count_chunk
            del values, padded, groups, abs_groups, scales_chunk, codes, packed_chunk
    if group_cursor != group_count:
        raise AssertionError(f"Group count mismatch for {source.name}: {group_cursor} != {group_count}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    save_file(
        {"packed": packed, "scales": scales},
        str(output_path),
        metadata={
            "format": FORMAT,
            "tensor_name": source.name,
            "bits": str(bits),
            "group_size": str(GROUP_SIZE),
            "packed_bit_order": "little",
            "bits_4_levels": "codes 0..15 -> -15,-13,-11,-9,-7,-5,-3,-1,+1,+3,+5,+7,+9,+11,+13,+15",
            "scale_dtype": "F16",
        },
    )
    size = output_path.stat().st_size
    del packed, scales
    return {
        "file": output_path.name,
        "shape": list(source.shape),
        "bits": bits,
        "group_size": GROUP_SIZE,
        "dtype": source.dtype,
        "groups": group_count,
        "packed_elements": group_count * packed_per_group,
        "logical_elements": elements,
        "packed_key": "packed",
        "scale_key": "scales",
        "bytes": size,
    }


def convert_float(source: SourceTensor, output_path: Path) -> dict[str, Any]:
    elements = source.elements
    output = np.empty(elements, dtype=np.float32)
    itemsize = _ITEMSIZE[source.dtype]
    chunk_elements = max(1, MAX_SOURCE_READ_BYTES // itemsize)
    with source.path.open("rb") as handle:
        for start in range(0, elements, chunk_elements):
            count = min(chunk_elements, elements - start)
            output[start : start + count] = read_values(source, start, count, handle)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    save_file(
        {"weight": output.reshape(source.shape)},
        str(output_path),
        metadata={
            "format": FORMAT,
            "tensor_name": source.name,
            "bits": "0",
            "dtype": "F32",
        },
    )
    size = output_path.stat().st_size
    del output
    return {
        "file": output_path.name,
        "shape": list(source.shape),
        "bits": 0,
        "group_size": 0,
        "dtype": source.dtype,
        "groups": 0,
        "logical_elements": elements,
        "weight_key": "weight",
        "bytes": size,
    }


def copy_component_metadata(source_dir: Path, output_dir: Path) -> None:
    for component in ("text_encoder", "transformer", "vae"):
        src = source_dir / component
        dst = output_dir / component
        dst.mkdir(parents=True, exist_ok=True)
        for path in src.iterdir():
            if path.is_file() and path.suffix not in {".safetensors", ".json"}:
                # Keep component licenses/README files when present.
                shutil.copy2(path, dst / path.name)
            elif path.is_file() and path.name in {"config.json", "generation_config.json"}:
                shutil.copy2(path, dst / path.name)
    for name in ("processor", "scheduler"):
        src = source_dir / name
        if src.is_dir():
            shutil.copytree(src, output_dir / name, dirs_exist_ok=True)
    for name in ("model_index.json", "LICENSE", "README.md"):
        src = source_dir / name
        if src.is_file():
            shutil.copy2(src, output_dir / name)


def build(source_dir: Path, output_dir: Path, clean: bool) -> dict[str, Any]:
    sources, plan = audit_plan(source_dir)
    print(json.dumps({"audit": plan}, indent=2), flush=True)
    if plan["planned_weight_bytes"] >= MAX_WEIGHT_BYTES:
        raise ValueError("The exact planned data does not fit the 3GB weight limit")
    if clean and output_dir.exists():
        for path in output_dir.iterdir():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    output_dir.mkdir(parents=True, exist_ok=True)
    copy_component_metadata(source_dir, output_dir)
    manifest_components: dict[str, Any] = {}
    started = time.monotonic()
    tensor_number = 0
    for component, entries in sources.items():
        component_manifest: dict[str, Any] = {}
        for entry in entries:
            tensor_number += 1
            bits = quantization_bits(component, entry.name, entry.shape)
            filename = f"tensor-{tensor_number:04d}.safetensors"
            target = output_dir / component / filename
            print(f"[{tensor_number}/{sum(len(v) for v in sources.values())}] {component}/{entry.name} bits={bits}", flush=True)
            if bits:
                record = convert_quantized(entry, bits, target)
            else:
                record = convert_float(entry, target)
            component_manifest[entry.name] = record
        manifest_components[component] = {"tensors": component_manifest}
    weights_bytes = sum(path.stat().st_size for path in output_dir.rglob("*.safetensors"))
    if weights_bytes >= MAX_WEIGHT_BYTES:
        raise ValueError(f"Built weights exceed 3GB: {weights_bytes} bytes")
    manifest = {
        "source": SOURCE,
        "revision": REVISION,
        "format": FORMAT,
        "group_size": GROUP_SIZE,
        "weights_bytes": weights_bytes,
        "weight_limit_bytes": MAX_WEIGHT_BYTES,
        "quality_validated": False,
        "architecture": "Qwen-Image-2.1 full tensor name/shape set; no layer pruning",
        "decode": {
            "flatten_order": "C",
            "final_group_padding": "zero; decode then truncate to logical_elements",
            "bits_1": "code 0=-scale, code 1=+scale; scale=mean(abs(logical group))",
            "bits_2": "codes 0/1/2/3=-3/-1/+1/+3 times scale; scale=max(abs(logical group))/3",
            "bits_4": "codes 0..15=-15,-13,-11,-9,-7,-5,-3,-1,+1,+3,+5,+7,+9,+11,+13,+15 times scale; scale=max(abs(logical group))/15",
            "packed_bit_order": "little",
            "scale_dtype": "float16",
            "unquantized_key": "weight (float32)",
        },
        "planned_audit": plan,
        "components": manifest_components,
        "built_seconds": round(time.monotonic() - started, 3),
    }
    (output_dir / "LOCAL_IMAGE_MODEL.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(output_dir / "LOCAL_IMAGE_MODEL.json"), "weights_bytes": weights_bytes, "elapsed_seconds": manifest["built_seconds"]}, ensure_ascii=False), flush=True)
    return manifest


def swap_staged_output(staging_dir: Path, output_dir: Path) -> Path | None:
    """Publish a complete directory without exposing half-written tensors.

    Windows cannot replace a non-empty directory in one ``os.replace`` call.
    Move the old complete directory aside, then rename the complete staging
    directory into place.  If the second move fails, restore the old directory.
    The previous directory is intentionally retained for rollback and cleanup
    by the owning runtime after it has no active readers.
    """
    previous: Path | None = None
    if output_dir.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        previous = output_dir.with_name(f"{output_dir.name}.previous-{stamp}-{os.getpid()}")
        output_dir.rename(previous)
    try:
        staging_dir.rename(output_dir)
    except Exception:
        if previous is not None and not output_dir.exists():
            previous.rename(output_dir)
        raise
    return previous


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path(".local-data/models/Qwen-Image-2.1-BF16"))
    parser.add_argument("--output-dir", type=Path, default=Path(".local-data/models/Qwen-Image-2.1-3GB"))
    parser.add_argument("--audit-only", action="store_true", help="Only print exact planned bytes; do not write output")
    parser.add_argument("--no-clean", action="store_true", help="Keep existing output files before writing")
    parser.add_argument("--no-atomic-swap", action="store_true", help="Write directly to output (unsafe while the runtime is serving requests)")
    args = parser.parse_args()
    source_dir = args.source_dir.resolve()
    output_dir = args.output_dir.resolve()
    if args.audit_only:
        _, plan = audit_plan(source_dir)
        print(json.dumps(plan, indent=2, ensure_ascii=False))
        return
    if args.no_atomic_swap:
        build(source_dir, output_dir, clean=not args.no_clean)
        return
    staging_dir = output_dir.with_name(f"{output_dir.name}.staging-{os.getpid()}")
    if staging_dir.exists():
        raise FileExistsError(f"Refusing to reuse existing staging directory: {staging_dir}")
    try:
        build(source_dir, staging_dir, clean=True)
        previous = swap_staged_output(staging_dir, output_dir)
        print(json.dumps({"published": str(output_dir), "previous": str(previous) if previous else None}, ensure_ascii=False), flush=True)
    except Exception:
        # Keep a failed staging directory for inspection; the live output was
        # untouched unless the final directory swap had already begun.
        raise


if __name__ == "__main__":
    main()

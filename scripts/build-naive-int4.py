"""Build an experimental full-depth, one-expert INT4 Naive checkpoint.

The builder reads only safetensors headers during ``--audit-only``.  A real build
uses HTTP range requests to fetch the dense tensors and expert 0 from each layer;
it never downloads the unused 255 experts or the 315 GB checkpoint as a whole.

This is an architecture prune plus post-training quantization.  It keeps all 48
decoder layers, keeps one original routed expert in every MoE layer, changes the
router to a deterministic one-expert route, and stores matrix weights as packed
signed INT4 with per-row 128-value scales.  It is an experimental artifact and
has no quality claim.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import struct
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import BinaryIO

import requests
import torch
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

MODEL_ID = "NaiveAI/Naive-N0.5-Flash-FP8"
MODEL_API = f"https://huggingface.co/api/models/{MODEL_ID}"
SHARD_COUNT = 49
GROUP_SIZE = 128
ROW_CHUNK = 1024
DEFAULT_CONTEXT = 8192
INT4_FORMAT = "naive-int4-v1"

SMALL_FILES = (
    "config.json",
    "configuration_naive_n05_flash.py",
    "modeling_naive_n05_flash.py",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "chat_template.jinja",
    "generation_config.json",
    "LICENSE",
)


@dataclass(frozen=True)
class SourceTensor:
    shard: int
    name: str
    dtype: str
    shape: tuple[int, ...]
    start: int
    end: int
    data_base: int

    @property
    def size(self) -> int:
        return self.end - self.start

    @property
    def elements(self) -> int:
        return math.prod(self.shape)


@dataclass(frozen=True)
class EncodedTensor:
    logical_name: str
    source: SourceTensor
    kind: str
    shape: tuple[int, ...]
    scale_source: SourceTensor | None = None

    @property
    def rows(self) -> int:
        if len(self.shape) != 2:
            raise ValueError(f"INT4 tensor must be 2-D: {self.logical_name} {self.shape}")
        return self.shape[0]

    @property
    def cols(self) -> int:
        if len(self.shape) != 2:
            raise ValueError(f"INT4 tensor must be 2-D: {self.logical_name} {self.shape}")
        return self.shape[1]

    @property
    def packed_cols(self) -> int:
        return (self.cols + 1) // 2

    @property
    def groups(self) -> int:
        return (self.cols + GROUP_SIZE - 1) // GROUP_SIZE

    @property
    def payload_bytes(self) -> int:
        if self.kind == "int4":
            return self.rows * self.packed_cols + self.rows * self.groups * 2
        return self.source.size


def http_client() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=6,
        backoff_factor=1.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def range_bytes(session: requests.Session, url: str, start: int, end: int) -> bytes:
    if end < start:
        return b""
    response = session.get(
        url,
        headers={"Range": f"bytes={start}-{end}"},
        timeout=(20, 180),
    )
    response.raise_for_status()
    expected = end - start + 1
    # Refuse a server that ignores Range.  Accepting a 200 here could silently
    # download one 6-13 GB shard and violate the builder's safety boundary.
    if response.status_code != 206 or len(response.content) != expected:
        raise RuntimeError(
            f"Range request did not return exactly {expected} bytes "
            f"(status={response.status_code}, got={len(response.content)}): {url}"
        )
    return response.content


def shard_url(revision: str, shard: int) -> str:
    return (
        f"https://huggingface.co/{MODEL_ID}/resolve/{revision}/"
        f"model-{shard:05d}-of-{SHARD_COUNT:05d}.safetensors"
    )


def read_header(session: requests.Session, revision: str, shard: int) -> dict[str, SourceTensor]:
    url = shard_url(revision, shard)
    header_length = struct.unpack("<Q", range_bytes(session, url, 0, 7))[0]
    if not 0 < header_length < 5_000_000:
        raise RuntimeError(f"Unsafe safetensors header length in shard {shard}: {header_length}")
    header = json.loads(range_bytes(session, url, 8, header_length + 7))
    return {
        name: SourceTensor(
            shard=shard,
            name=name,
            dtype=info["dtype"],
            shape=tuple(info["shape"]),
            start=info["data_offsets"][0],
            end=info["data_offsets"][1],
            data_base=8 + header_length,
        )
        for name, info in header.items()
        if name != "__metadata__"
    }


def tensor_bytes(session: requests.Session, revision: str, tensor: SourceTensor) -> bytes:
    start = tensor.data_base + tensor.start
    return range_bytes(session, shard_url(revision, tensor.shard), start, start + tensor.size - 1)


def tensor_rows(
    session: requests.Session,
    revision: str,
    tensor: SourceTensor,
    row_start: int,
    row_end: int,
) -> bytes:
    if len(tensor.shape) != 2:
        raise ValueError(f"Expected matrix tensor for row read: {tensor.name} {tensor.shape}")
    dtype_bytes = {"BF16": 2, "F16": 2, "F32": 4, "F8_E4M3": 1}.get(tensor.dtype)
    if dtype_bytes is None:
        raise RuntimeError(f"Unsupported source dtype {tensor.dtype} for {tensor.name}")
    row_bytes = tensor.shape[1] * dtype_bytes
    start = tensor.data_base + tensor.start + row_start * row_bytes
    end = tensor.data_base + tensor.start + row_end * row_bytes - 1
    return range_bytes(session, shard_url(revision, tensor.shard), start, end)


def dtype_tensor(raw: bytes, dtype: str, shape: tuple[int, ...]) -> torch.Tensor:
    mapping = {
        "BF16": torch.bfloat16,
        "F16": torch.float16,
        "F32": torch.float32,
        "F8_E4M3": torch.float8_e4m3fn,
    }
    if dtype not in mapping:
        raise RuntimeError(f"Unsupported source dtype {dtype}")
    return torch.frombuffer(bytearray(raw), dtype=mapping[dtype]).reshape(shape)


def dequant_rows(
    session: requests.Session,
    revision: str,
    tensor: SourceTensor,
    scale_source: SourceTensor | None,
    row_start: int,
    row_end: int,
) -> torch.Tensor:
    raw = tensor_rows(session, revision, tensor, row_start, row_end)
    values = dtype_tensor(raw, tensor.dtype, (row_end - row_start, tensor.shape[1]))
    if tensor.dtype != "F8_E4M3":
        return values.float()
    if scale_source is None or scale_source.dtype != "F32":
        raise RuntimeError(f"FP8 tensor has no F32 scale_inv: {tensor.name}")
    scale_raw = tensor_bytes(session, revision, scale_source)
    scales = dtype_tensor(scale_raw, scale_source.dtype, scale_source.shape).float()
    if scales.shape != (
        math.ceil(tensor.shape[0] / GROUP_SIZE),
        math.ceil(tensor.shape[1] / GROUP_SIZE),
    ):
        raise RuntimeError(
            f"Unexpected scale shape for {tensor.name}: {tuple(scales.shape)} "
            f"versus {tensor.shape}"
        )
    scales = scales[row_start // GROUP_SIZE : math.ceil(row_end / GROUP_SIZE)]
    scales = scales.repeat_interleave(GROUP_SIZE, 0).repeat_interleave(GROUP_SIZE, 1)
    scales = scales[row_start % GROUP_SIZE : row_start % GROUP_SIZE + (row_end - row_start)]
    scales = scales[:, : tensor.shape[1]]
    return values.float() * scales


def quantize_rows(values: torch.Tensor) -> tuple[bytes, bytes]:
    rows, cols = values.shape
    groups = math.ceil(cols / GROUP_SIZE)
    padded_cols = groups * GROUP_SIZE
    if padded_cols != cols:
        values = torch.nn.functional.pad(values, (0, padded_cols - cols))
    chunks = values.reshape(rows, groups, GROUP_SIZE)
    scales = chunks.abs().amax(dim=-1).clamp_min(1e-8) / 7.0
    q = torch.round(chunks / scales.unsqueeze(-1)).clamp(-8, 7).to(torch.int16) + 8
    q = q.reshape(rows, padded_cols)[:, :cols].to(torch.uint8)
    if q.shape[1] % 2:
        q = torch.nn.functional.pad(q, (0, 1))
    packed = q[:, 0::2] | (q[:, 1::2] << 4)
    return packed.contiguous().numpy().tobytes(), scales.to(torch.float16).contiguous().numpy().tobytes()


def quantize_source(
    session: requests.Session,
    revision: str,
    encoded: EncodedTensor,
    target: BinaryIO,
) -> None:
    scale_bytes = BytesIO()
    for row_start in range(0, encoded.rows, ROW_CHUNK):
        row_end = min(encoded.rows, row_start + ROW_CHUNK)
        values = dequant_rows(
            session,
            revision,
            encoded.source,
            encoded.scale_source,
            row_start,
            row_end,
        )
        packed, scales = quantize_rows(values)
        target.write(packed)
        scale_bytes.write(scales)
        del values
    target.write(scale_bytes.getvalue())


def stream_source(session: requests.Session, revision: str, tensor: SourceTensor, target: BinaryIO) -> None:
    start = tensor.data_base + tensor.start
    end = start + tensor.size - 1
    with session.get(
        shard_url(revision, tensor.shard),
        headers={"Range": f"bytes={start}-{end}"},
        stream=True,
        timeout=(20, 180),
    ) as response:
        response.raise_for_status()
        if response.status_code != 206:
            raise RuntimeError(f"Server ignored Range for {tensor.name}")
        copied = 0
        for chunk in response.iter_content(chunk_size=4 * 1024 * 1024):
            target.write(chunk)
            copied += len(chunk)
        if copied != tensor.size:
            raise RuntimeError(f"Incomplete tensor {tensor.name}: {copied} of {tensor.size}")


def source_revision(session: requests.Session) -> str:
    response = session.get(MODEL_API, timeout=(20, 60))
    response.raise_for_status()
    revision = response.json().get("sha")
    if not revision:
        raise RuntimeError("Hugging Face model API returned no immutable revision")
    return revision


def should_skip(name: str) -> bool:
    if name.endswith("_scale_inv"):
        return True
    if ".mlp.experts." in name and ".mlp.experts.0." not in name:
        return True
    # The router is replaced by the one-expert runtime.  Keeping its 256-way
    # weights would be useless and would undermine the size estimate.
    if ".mlp.gate." in name:
        return True
    return False


def build_specs(headers: dict[int, dict[str, SourceTensor]]) -> list[EncodedTensor]:
    all_tensors: dict[str, SourceTensor] = {}
    for shard in sorted(headers):
        for name, tensor in headers[shard].items():
            if name in all_tensors:
                raise RuntimeError(f"Duplicate source tensor: {name}")
            all_tensors[name] = tensor

    expert0 = [
        name
        for name in all_tensors
        if ".mlp.experts.0." in name and name.endswith(".weight")
    ]
    if not expert0:
        raise RuntimeError("Could not find expert 0 tensors in the official checkpoint")

    specs: list[EncodedTensor] = []
    for name in sorted(all_tensors):
        if should_skip(name):
            continue
        tensor = all_tensors[name]
        if len(tensor.shape) == 2:
            scale_source = all_tensors.get(name + "_scale_inv")
            if tensor.dtype == "F8_E4M3" and scale_source is None:
                raise RuntimeError(f"Missing scale_inv for FP8 matrix {name}")
            if tensor.dtype not in {"BF16", "F16", "F32", "F8_E4M3"}:
                raise RuntimeError(f"Unsupported matrix dtype {tensor.dtype}: {name}")
            specs.append(EncodedTensor(name, tensor, "int4", tensor.shape, scale_source))
        else:
            if tensor.dtype not in {"BF16", "F16", "F32"}:
                raise RuntimeError(f"Unsupported non-matrix dtype {tensor.dtype}: {name}")
            specs.append(EncodedTensor(name, tensor, "float", tensor.shape))
    return specs


def logical_group(name: str) -> int:
    match = re.match(r"model\.layers\.(\d+)\.", name)
    if match:
        return int(match.group(1)) + 1
    if name.startswith("model.embed_tokens."):
        return 0
    return SHARD_COUNT


def output_entries(spec: EncodedTensor) -> list[dict[str, object]]:
    if spec.kind == "int4":
        return [
            {
                "key": spec.logical_name + ".__qweight__",
                "dtype": "U8",
                "shape": [spec.rows, spec.packed_cols],
                "bytes": spec.rows * spec.packed_cols,
            },
            {
                "key": spec.logical_name + ".__scale__",
                "dtype": "F16",
                "shape": [spec.rows, spec.groups],
                "bytes": spec.rows * spec.groups * 2,
            },
        ]
    return [
        {
            "key": spec.logical_name,
            "dtype": spec.source.dtype,
            "shape": list(spec.shape),
            "bytes": spec.source.size,
        }
    ]


def write_safetensors_shard(
    session: requests.Session,
    revision: str,
    specs: list[EncodedTensor],
    path: Path,
) -> tuple[dict[str, str], int]:
    entries = [entry for spec in specs for entry in output_entries(spec)]
    position = 0
    header: dict[str, object] = {"__metadata__": {"format": INT4_FORMAT}}
    for entry in entries:
        size = int(entry["bytes"])
        header[str(entry["key"])] = {
            "dtype": entry["dtype"],
            "shape": entry["shape"],
            "data_offsets": [position, position + size],
        }
        position += size
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    header_bytes += b" " * (-len(header_bytes) % 8)
    temporary = path.with_suffix(path.suffix + ".part")
    with temporary.open("wb") as target:
        target.write(struct.pack("<Q", len(header_bytes)))
        target.write(header_bytes)
        for spec in specs:
            if spec.kind == "int4":
                quantize_source(session, revision, spec, target)
            else:
                stream_source(session, revision, spec.source, target)
    os.replace(temporary, path)
    return {str(entry["key"]): path.name for entry in entries}, position


def download_small_files(session: requests.Session, revision: str, folder: Path) -> None:
    for filename in SMALL_FILES:
        response = session.get(
            f"https://huggingface.co/{MODEL_ID}/resolve/{revision}/{filename}",
            timeout=(20, 120),
        )
        response.raise_for_status()
        (folder / filename).write_bytes(response.content)

    config_path = folder / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    # The artifact is loaded through the ordinary custom-code path.  If a
    # future upstream config grows a quantization_config field, leaving it in
    # place could make Transformers select an unrelated FP8 loader before the
    # runner replaces the matrix modules.
    config.pop("quantization_config", None)
    config["n_routed_experts"] = 1
    config["num_experts_per_tok"] = 1
    config["max_position_embeddings"] = min(
        int(config.get("max_position_embeddings", DEFAULT_CONTEXT)), DEFAULT_CONTEXT
    )
    config["naive_int4_format"] = {
        "format": INT4_FORMAT,
        "group_size": GROUP_SIZE,
        "experts_kept": [0],
    }
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

    model_path = folder / "modeling_naive_n05_flash.py"
    model_code = model_path.read_text(encoding="utf-8")
    original = "        _, topk_weights, topk_indices = self.gate(states)\n"
    replacement = (
        "        if self.gate.num_experts == 1:\n"
        "            token_count = states.numel() // states.shape[-1]\n"
        "            topk_weights = states.new_ones((token_count, 1))\n"
        "            topk_indices = torch.zeros((token_count, 1), dtype=torch.long, device=states.device)\n"
        "        else:\n"
        "            _, topk_weights, topk_indices = self.gate(states)\n"
    )
    if original in model_code and "if self.gate.num_experts == 1" not in model_code:
        model_code = model_code.replace(original, replacement, 1)
    elif "if self.gate.num_experts == 1" not in model_code:
        raise RuntimeError("Upstream router code changed; refusing an unreviewed patch")
    model_path.write_text(model_code, encoding="utf-8")


def estimate(specs: list[EncodedTensor]) -> tuple[int, int, int]:
    output_bytes = sum(spec.payload_bytes for spec in specs)
    source_bytes = sum(spec.source.size + (spec.scale_source.size if spec.scale_source else 0) for spec in specs)
    matrix_count = sum(spec.kind == "int4" for spec in specs)
    return output_bytes, source_bytes, matrix_count


def build(args: argparse.Namespace) -> None:
    session = http_client()
    revision = args.revision or source_revision(session)
    headers = {shard: read_header(session, revision, shard) for shard in range(1, SHARD_COUNT + 1)}
    specs = build_specs(headers)
    output_bytes, source_bytes_total, matrix_count = estimate(specs)
    print(f"Source revision: {revision}", flush=True)
    print(f"Selected logical tensors: {len(specs)} ({matrix_count} INT4 matrices)", flush=True)
    print(f"Estimated selected source bytes: {source_bytes_total:,} ({source_bytes_total / 1e9:.3f} GB)", flush=True)
    print(f"Estimated packed weight bytes: {output_bytes:,} ({output_bytes / 1e9:.3f} GB)", flush=True)
    if not 3_000_000_000 <= output_bytes <= 5_000_000_000:
        raise RuntimeError("Full-depth one-expert INT4 estimate is outside the requested 3-5 GB range")
    if args.audit_only:
        return

    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    if any(folder.iterdir()) and not args.resume:
        raise RuntimeError(f"Output folder is not empty; use --resume to continue: {folder}")

    download_small_files(session, revision, folder)
    weight_map: dict[str, str] = {}
    logical_map: dict[str, dict[str, object]] = {}
    total_written = 0
    for group in range(0, SHARD_COUNT + 1):
        group_specs = [spec for spec in specs if logical_group(spec.logical_name) == group]
        if not group_specs:
            continue
        filename = f"model-{group:05d}-of-{SHARD_COUNT + 1:05d}.safetensors"
        path = folder / filename
        if path.exists() and args.resume:
            print(f"Reusing {filename}", flush=True)
            with path.open("rb") as existing:
                header_size = struct.unpack("<Q", existing.read(8))[0]
                header = json.loads(existing.read(header_size))
            written = max(
                int(info["data_offsets"][1]) for key, info in header.items() if key != "__metadata__"
            )
            shard_map = {key: filename for key in header if key != "__metadata__"}
        else:
            print(f"Building {filename} ({sum(spec.payload_bytes for spec in group_specs) / 1e6:.1f} MB)", flush=True)
            shard_map, written = write_safetensors_shard(session, revision, group_specs, path)
        for key, shard_name in shard_map.items():
            if key in weight_map:
                raise RuntimeError(f"Duplicate output tensor: {key}")
            weight_map[key] = shard_name
        for spec in group_specs:
            if spec.kind == "int4":
                logical_map[spec.logical_name] = {
                    "kind": "int4",
                    "qweight": spec.logical_name + ".__qweight__",
                    "scale": spec.logical_name + ".__scale__",
                    "shape": list(spec.shape),
                    "group_size": GROUP_SIZE,
                    "source_dtype": spec.source.dtype,
                }
            else:
                logical_map[spec.logical_name] = {
                    "kind": "float",
                    "tensor": spec.logical_name,
                    "shape": list(spec.shape),
                    "dtype": spec.source.dtype,
                }
        total_written += written

    (folder / "model.safetensors.index.json").write_text(
        json.dumps({"metadata": {"total_size": total_written}, "weight_map": weight_map}, indent=2) + "\n",
        encoding="utf-8",
    )
    (folder / "NAIVE_INT4.json").write_text(
        json.dumps(
            {
                "format": INT4_FORMAT,
                "source": MODEL_ID,
                "revision": revision,
                "layers": 48,
                "experts_kept": [0],
                "group_size": GROUP_SIZE,
                "weight_bytes": total_written,
                "quality_validated": False,
                "logical_tensors": logical_map,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Built {folder}; {total_written:,} bytes ({total_written / 1e9:.3f} GB)", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(".local-data/models/Naive-N0.5-Flash-int4-48L-1E"),
    )
    parser.add_argument("--revision", help="Immutable HF commit SHA; defaults to the current model SHA")
    parser.add_argument("--audit-only", action="store_true", help="Read only 49 safetensors headers")
    parser.add_argument("--resume", action="store_true", help="Reuse completed output shards")
    build(parser.parse_args())


if __name__ == "__main__":
    main()

"""Build an experimental 3-5 GB pruned checkpoint from Naive's official FP8 weights.

This keeps the original embedding, output head, and first six decoder layers. Each
MoE layer retains only expert 0. It is a severe, untrained architecture prune and
must not be presented as a quality-preserving quantization.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
from dataclasses import dataclass
from pathlib import Path

import requests
import torch
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

MODEL_ID = "NaiveAI/Naive-N0.5-Flash-FP8"
MODEL_API = f"https://huggingface.co/api/models/{MODEL_ID}"
BLOCK_SIZE = 128
OUTPUT_SHARDS = (1, 2, 3, 4, 5, 6, 49)
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


@dataclass(frozen=True)
class OutputTensor:
    name: str
    dtype: str
    shape: tuple[int, ...]
    source: SourceTensor | None = None
    operation: str = "copy"

    @property
    def size(self) -> int:
        elements = 1
        for dimension in self.shape:
            elements *= dimension
        return elements * {"BF16": 2, "F32": 4}[self.dtype]


def client() -> requests.Session:
    session = requests.Session()
    retry = Retry(total=5, backoff_factor=1, status_forcelist=(429, 500, 502, 503, 504))
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def range_bytes(session: requests.Session, url: str, start: int, end: int) -> bytes:
    response = session.get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=(20, 120))
    response.raise_for_status()
    expected = end - start + 1
    if response.status_code != 206 or len(response.content) != expected:
        raise RuntimeError(f"Range request did not return exactly {expected} bytes: {url}")
    return response.content


def shard_url(revision: str, shard: int) -> str:
    return f"https://huggingface.co/{MODEL_ID}/resolve/{revision}/model-{shard:05d}-of-00049.safetensors"


def read_header(session: requests.Session, revision: str, shard: int) -> dict[str, SourceTensor]:
    url = shard_url(revision, shard)
    header_length = struct.unpack("<Q", range_bytes(session, url, 0, 7))[0]
    if not 0 < header_length < 5_000_000:
        raise RuntimeError(f"Unsafe safetensors header length in shard {shard}: {header_length}")
    header = json.loads(range_bytes(session, url, 8, header_length + 7))
    return {
        name: SourceTensor(
            shard,
            name,
            info["dtype"],
            tuple(info["shape"]),
            info["data_offsets"][0],
            info["data_offsets"][1],
            8 + header_length,
        )
        for name, info in header.items()
        if name != "__metadata__"
    }


def source_bytes(session: requests.Session, revision: str, tensor: SourceTensor) -> bytes:
    start = tensor.data_base + tensor.start
    return range_bytes(session, shard_url(revision, tensor.shard), start, start + tensor.size - 1)


def stream_source(session: requests.Session, revision: str, tensor: SourceTensor, output) -> None:
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
            raise RuntimeError(f"Server ignored range request for {tensor.name}")
        copied = 0
        for chunk in response.iter_content(chunk_size=4 * 1024 * 1024):
            output.write(chunk)
            copied += len(chunk)
        if copied != tensor.size:
            raise RuntimeError(f"Incomplete tensor {tensor.name}: {copied} of {tensor.size} bytes")


def expert_bf16(session: requests.Session, revision: str, weights: SourceTensor, scales: SourceTensor) -> bytes:
    if weights.dtype != "F8_E4M3" or scales.dtype != "F32":
        raise RuntimeError(f"Unexpected FP8 expert tensors: {weights.name}")
    if any(d % BLOCK_SIZE for d in weights.shape):
        raise RuntimeError(f"Unexpected block shape: {weights.name}")
    raw_weights = source_bytes(session, revision, weights)
    raw_scales = source_bytes(session, revision, scales)
    weight = torch.frombuffer(bytearray(raw_weights), dtype=torch.float8_e4m3fn).reshape(weights.shape).float()
    scale = torch.frombuffer(bytearray(raw_scales), dtype=torch.float32).reshape(scales.shape)
    if scale.shape != (weights.shape[0] // BLOCK_SIZE, weights.shape[1] // BLOCK_SIZE):
        raise RuntimeError(f"Mismatched FP8 scales: {weights.name}")
    scale = scale.repeat_interleave(BLOCK_SIZE, 0).repeat_interleave(BLOCK_SIZE, 1)
    return (weight * scale).to(torch.bfloat16).view(torch.int16).numpy().tobytes()


def output_specs(shard: int, tensors: dict[str, SourceTensor]) -> list[OutputTensor]:
    result = []
    for name, tensor in tensors.items():
        if ".mlp.experts." in name or name.endswith(".mlp.gate.weight") or name.endswith(".mlp.gate.e_score_correction_bias"):
            continue
        if tensor.dtype != "BF16":
            raise RuntimeError(f"Unrecognized dense dtype for {name}: {tensor.dtype}")
        result.append(OutputTensor(name, tensor.dtype, tensor.shape, tensor))
    if 2 <= shard <= 6:
        prefix = f"model.layers.{shard - 1}.mlp"
        result.extend(
            (
                OutputTensor(f"{prefix}.experts.gate_up_proj", "BF16", (1, 4096, 4096), operation="gate_up"),
                OutputTensor(f"{prefix}.experts.down_proj", "BF16", (1, 4096, 2048), operation="down"),
                OutputTensor(f"{prefix}.gate.weight", "BF16", (1, 4096), operation="gate"),
                OutputTensor(f"{prefix}.gate.e_score_correction_bias", "BF16", (1,), operation="bias"),
            )
        )
    return sorted(result, key=lambda tensor: tensor.name)


def write_special(session: requests.Session, revision: str, output: OutputTensor, sources: dict[str, SourceTensor], target) -> None:
    prefix = output.name.split(".mlp.")[0] + ".mlp"
    if output.operation in ("gate", "bias"):
        source = sources[f"{prefix}.gate." + ("weight" if output.operation == "gate" else "e_score_correction_bias")]
        raw = source_bytes(session, revision, source)
        values = torch.frombuffer(bytearray(raw), dtype=torch.float32)
        values = values[:4096] if output.operation == "gate" else values[:1]
        target.write(values.to(torch.bfloat16).view(torch.int16).numpy().tobytes())
        return
    projections = ("gate_proj", "up_proj") if output.operation == "gate_up" else ("down_proj",)
    for projection in projections:
        base = f"{prefix}.experts.0.{projection}.weight"
        target.write(expert_bf16(session, revision, sources[base], sources[base + "_scale_inv"]))


def write_shard(
    session: requests.Session,
    revision: str,
    sources: dict[str, SourceTensor],
    specs: list[OutputTensor],
    path: Path,
) -> None:
    header: dict[str, object] = {"__metadata__": {"format": "pt"}}
    position = 0
    for spec in specs:
        header[spec.name] = {"dtype": spec.dtype, "shape": spec.shape, "data_offsets": [position, position + spec.size]}
        position += spec.size
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    header_bytes += b" " * (-len(header_bytes) % 8)
    temporary = path.with_suffix(path.suffix + ".part")
    with temporary.open("wb") as output:
        output.write(struct.pack("<Q", len(header_bytes)))
        output.write(header_bytes)
        for spec in specs:
            before = output.tell()
            if spec.operation == "copy":
                assert spec.source is not None
                stream_source(session, revision, spec.source, output)
            else:
                write_special(session, revision, spec, sources, output)
            if output.tell() - before != spec.size:
                raise RuntimeError(f"Wrong output size for {spec.name}")
    os.replace(temporary, path)


def verify_existing_shard(path: Path, specs: list[OutputTensor]) -> None:
    with path.open("rb") as source:
        raw_length = source.read(8)
        if len(raw_length) != 8:
            raise RuntimeError(f"Incomplete existing shard: {path}")
        header_length = struct.unpack("<Q", raw_length)[0]
        if not 0 < header_length < 5_000_000:
            raise RuntimeError(f"Invalid existing shard header: {path}")
        header = json.loads(source.read(header_length))
    expected = {item.name: {"dtype": item.dtype, "shape": list(item.shape)} for item in specs}
    actual = {
        name: {"dtype": info["dtype"], "shape": info["shape"]}
        for name, info in header.items()
        if name != "__metadata__"
    }
    expected_bytes = 8 + header_length + sum(item.size for item in specs)
    if actual != expected or path.stat().st_size != expected_bytes:
        raise RuntimeError(f"Existing shard does not match requested checkpoint: {path}")


def download_small_files(session: requests.Session, revision: str, folder: Path) -> dict:
    for filename in SMALL_FILES:
        response = session.get(f"https://huggingface.co/{MODEL_ID}/resolve/{revision}/{filename}", timeout=60)
        response.raise_for_status()
        (folder / filename).write_bytes(response.content)
    model_path = folder / "modeling_naive_n05_flash.py"
    model_code = model_path.read_text(encoding="utf-8")
    original_router = "        _, topk_weights, topk_indices = self.gate(states)\n"
    one_expert_router = (
        "        if self.gate.num_experts == 1:\n"
        "            token_count = states.numel() // states.shape[-1]\n"
        "            topk_weights = states.new_ones((token_count, 1))\n"
        "            topk_indices = torch.zeros((token_count, 1), dtype=torch.long, device=states.device)\n"
        "        else:\n"
        "            _, topk_weights, topk_indices = self.gate(states)\n"
    )
    if model_code.count(original_router) != 1:
        raise RuntimeError("Upstream router code changed; refusing to patch it blindly")
    model_path.write_text(model_code.replace(original_router, one_expert_router), encoding="utf-8")
    config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
    config["num_hidden_layers"] = 6
    config["hybrid_layer_pattern"] = config["hybrid_layer_pattern"][:6]
    config["moe_layer_freq"] = config["moe_layer_freq"][:6]
    config["n_routed_experts"] = 1
    config["num_experts_per_tok"] = 1
    config["max_position_embeddings"] = 8192
    config.pop("quantization_config", None)
    (folder / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".local-data/models/Naive-N0.5-Flash-pruned-6L-1E"))
    parser.add_argument("--audit-only", action="store_true", help="Read official tensor headers; download no weight data")
    args = parser.parse_args()
    session = client()
    response = session.get(MODEL_API, timeout=30)
    response.raise_for_status()
    revision = response.json()["sha"]
    metadata = {shard: read_header(session, revision, shard) for shard in OUTPUT_SHARDS}
    specs = {shard: output_specs(shard, metadata[shard]) for shard in OUTPUT_SHARDS}
    expected_size = sum(tensor.size for group in specs.values() for tensor in group)
    print(f"Source revision: {revision}", flush=True)
    print(f"Expected weight data: {expected_size:,} bytes ({expected_size / 1e9:.3f} GB)", flush=True)
    if not 3_000_000_000 <= expected_size <= 5_000_000_000:
        raise RuntimeError("Pruned checkpoint would miss the requested 3-5 GB size")
    if args.audit_only:
        return
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    pruning_path = folder / "PRUNING.json"
    if pruning_path.exists() and json.loads(pruning_path.read_text(encoding="utf-8"))["revision"] != revision:
        raise RuntimeError("Existing output uses a different source revision; choose another output folder")
    weight_map: dict[str, str] = {}
    for number, shard in enumerate(OUTPUT_SHARDS, 1):
        filename = f"model-{number:05d}-of-00007.safetensors"
        path = folder / filename
        if path.exists():
            verify_existing_shard(path, specs[shard])
        else:
            print(f"Building {filename} ({sum(item.size for item in specs[shard]) / 1e6:.1f} MB)", flush=True)
            write_shard(session, revision, metadata[shard], specs[shard], path)
        for item in specs[shard]:
            if item.name in weight_map:
                raise RuntimeError(f"Duplicate tensor name: {item.name}")
            weight_map[item.name] = filename
    download_small_files(session, revision, folder)
    index = {"metadata": {"total_size": expected_size}, "weight_map": weight_map}
    (folder / "model.safetensors.index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    (folder / "PRUNING.json").write_text(
        json.dumps({"source": MODEL_ID, "revision": revision, "kept_layers": list(range(6)), "kept_experts": [0], "router_adapted_for_single_expert": True, "quality_validated": False}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Built {folder}; {len(weight_map)} tensors; {expected_size / 1e9:.3f} GB", flush=True)


if __name__ == "__main__":
    main()

"""Run the experimental ``build-naive-int4.py`` checkpoint.

The checkpoint stores matrix weights as CPU-resident packed INT4.  This runner
dequantizes one output-row block at a time before each matrix multiply, which
keeps the 3-5 GB artifact usable on an 8 GB GPU at the cost of very low speed.
It is a correctness/prototype runner, not a production inference engine.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from accelerate import init_empty_weights
from safetensors import safe_open
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

GROUP_SIZE = 128
INT4_FORMAT = "naive-int4-v1"


class TensorStore:
    """Lazy reader for the per-layer safetensors files emitted by the builder."""

    def __init__(self, folder: Path, manifest: dict):
        self.folder = folder
        self.manifest = manifest
        self.weight_map = json.loads((folder / "model.safetensors.index.json").read_text())[
            "weight_map"
        ]
        self.handles: dict[str, object] = {}
        self.gpu_tensors: dict[str, torch.Tensor] = {}

    def cache_packed_weights(self, device: torch.device) -> None:
        """Keep only packed INT4 and scales on GPU, never full dense weights."""
        for entry in self.manifest["logical_tensors"].values():
            if entry["kind"] != "int4":
                continue
            for key in (entry["qweight"], entry["scale"]):
                self.gpu_tensors[key] = self.handle_for_key(key).get_tensor(key).to(device)
        self.close_mappings()

    def entry(self, logical: str) -> dict:
        try:
            return self.manifest["logical_tensors"][logical]
        except KeyError as exc:
            raise KeyError(f"Tensor missing from NAIVE_INT4.json: {logical}") from exc

    def handle_for_key(self, key: str):
        filename = self.weight_map[key]
        if filename not in self.handles:
            self.handles[filename] = safe_open(
                str(self.folder / filename), framework="pt", device="cpu"
            )
        return self.handles[filename]

    def float_tensor(self, logical: str) -> torch.Tensor:
        entry = self.entry(logical)
        if entry["kind"] != "float":
            raise TypeError(f"Expected float tensor: {logical}")
        key = entry["tensor"]
        return self.handle_for_key(key).get_tensor(key)

    def int4_rows(self, logical: str, row_start: int, row_end: int) -> tuple[torch.Tensor, torch.Tensor]:
        entry = self.entry(logical)
        if entry["kind"] != "int4":
            raise TypeError(f"Expected INT4 tensor: {logical}")
        qkey = entry["qweight"]
        skey = entry["scale"]
        qslice = self.gpu_tensors[qkey][row_start:row_end] if qkey in self.gpu_tensors else self.handle_for_key(qkey).get_slice(qkey)[row_start:row_end]
        sslice = self.gpu_tensors[skey][row_start:row_end] if skey in self.gpu_tensors else self.handle_for_key(skey).get_slice(skey)[row_start:row_end]
        return qslice.contiguous(), sslice.contiguous()

    def close_mappings(self) -> None:
        # safe_open handles are context managers, but closing them explicitly
        # releases Windows file mappings before the process exits.
        for handle in self.handles.values():
            close = getattr(handle, "__exit__", None)
            if close is not None:
                close(None, None, None)
        self.handles.clear()

    def close(self) -> None:
        self.close_mappings()
        self.gpu_tensors.clear()


def unpack_rows(
    packed: torch.Tensor,
    scales: torch.Tensor,
    columns: int,
    device: torch.device,
    dtype: torch.dtype,
) -> torch.Tensor:
    packed = packed.to(device=device, non_blocking=True)
    values = torch.empty((packed.shape[0], packed.shape[1] * 2), device=device, dtype=torch.uint8)
    values[:, 0::2] = packed & 0x0F
    values[:, 1::2] = (packed >> 4) & 0x0F
    values = values.to(torch.float32).sub_(8.0).reshape(packed.shape[0], -1, GROUP_SIZE)
    scales = scales.to(device=device, dtype=torch.float32, non_blocking=True)
    return (values * scales.unsqueeze(-1)).reshape(packed.shape[0], -1)[:, :columns].to(dtype)


class PackedLinear(nn.Module):
    """A CPU packed INT4 matrix with blockwise row streaming."""

    def __init__(self, store: TensorStore, logical: str, device: torch.device, row_block: int):
        super().__init__()
        entry = store.entry(logical)
        if entry["kind"] != "int4":
            raise TypeError(f"PackedLinear requires INT4 tensor: {logical}")
        self.store = store
        self.logical = logical
        self.out_features, self.in_features = entry["shape"]
        self.row_block = row_block
        self.compute_device = device

    def forward(self, hidden: torch.Tensor) -> torch.Tensor:
        original_shape = hidden.shape
        flattened = hidden.reshape(-1, self.in_features)
        output = torch.empty(
            (flattened.shape[0], self.out_features),
            device=flattened.device,
            dtype=flattened.dtype,
        )
        for row_start in range(0, self.out_features, self.row_block):
            row_end = min(self.out_features, row_start + self.row_block)
            packed, scales = self.store.int4_rows(self.logical, row_start, row_end)
            weight = unpack_rows(
                packed,
                scales,
                self.in_features,
                flattened.device,
                flattened.dtype,
            )
            output[:, row_start:row_end] = F.linear(flattened, weight)
        return output.reshape(*original_shape[:-1], self.out_features)


class PackedEmbedding(nn.Module):
    """INT4 embedding lookup that fetches only requested rows from CPU."""

    def __init__(self, store: TensorStore, logical: str, device: torch.device):
        super().__init__()
        entry = store.entry(logical)
        if entry["kind"] != "int4":
            raise TypeError(f"PackedEmbedding requires INT4 tensor: {logical}")
        self.store = store
        self.logical = logical
        self.num_embeddings, self.embedding_dim = entry["shape"]
        self.compute_device = device

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        flat_ids = input_ids.reshape(-1).to(device="cpu")
        unique_ids, inverse = torch.unique(flat_ids, sorted=False, return_inverse=True)
        rows: list[torch.Tensor] = []
        for token_id in unique_ids.tolist():
            packed, scales = self.store.int4_rows(self.logical, token_id, token_id + 1)
            rows.append(
                unpack_rows(
                    packed,
                    scales,
                    self.embedding_dim,
                    input_ids.device,
                    torch.bfloat16,
                )[0]
            )
        table = torch.stack(rows, dim=0)
        return table[inverse.to(device=input_ids.device)].reshape(*input_ids.shape, self.embedding_dim)


class OneExpertExperts(nn.Module):
    """The original expert-0 MLP, with its three matrices read as INT4."""

    def __init__(self, store: TensorStore, layer_index: int, device: torch.device, row_block: int):
        super().__init__()
        prefix = f"model.layers.{layer_index}.mlp.experts.0"
        self.gate_proj = PackedLinear(store, prefix + ".gate_proj.weight", device, row_block)
        self.up_proj = PackedLinear(store, prefix + ".up_proj.weight", device, row_block)
        self.down_proj = PackedLinear(store, prefix + ".down_proj.weight", device, row_block)
        self.num_experts = 1

    def forward(
        self,
        hidden_states: torch.Tensor,
        top_k_index: torch.Tensor | None = None,
        top_k_weights: torch.Tensor | None = None,
    ) -> torch.Tensor:
        gate = self.gate_proj(hidden_states)
        up = self.up_proj(hidden_states)
        return self.down_proj(F.silu(gate) * up)


class OneExpertGate(nn.Module):
    """Router placeholder required by the official MoE wrapper."""

    def __init__(self):
        super().__init__()
        self.num_experts = 1

    def forward(self, hidden_states: torch.Tensor):  # pragma: no cover - one-expert path bypasses this
        token_count = hidden_states.numel() // hidden_states.shape[-1]
        weights = hidden_states.new_ones((token_count, 1))
        indices = torch.zeros((token_count, 1), dtype=torch.long, device=hidden_states.device)
        return hidden_states.new_zeros((token_count, 1)), weights, indices


def replace_child(parent: nn.Module, name: str, child: nn.Module) -> None:
    setattr(parent, name, child)


def module_parent(root: nn.Module, dotted: str) -> tuple[nn.Module, str]:
    parts = dotted.split(".")
    parent = root
    for part in parts[:-1]:
        parent = getattr(parent, part)
    return parent, parts[-1]


def replace_heavy_modules(
    model: nn.Module,
    store: TensorStore,
    device: torch.device,
    row_block: int,
) -> None:
    # Replace routed expert stacks and routers first, so their meta parameters
    # never get materialized as dense tensors.
    for name, module in list(model.named_modules()):
        if module.__class__.__name__ == "DeepseekV3Experts":
            parent, child_name = module_parent(model, name)
            layer_match = name.split(".")
            layer_index = int(layer_match[layer_match.index("layers") + 1])
            replace_child(parent, child_name, OneExpertExperts(store, layer_index, device, row_block))
        elif module.__class__.__name__ == "DeepseekV3TopkRouter":
            parent, child_name = module_parent(model, name)
            replace_child(parent, child_name, OneExpertGate())

    # The snapshot is taken after expert replacement, so nested dense expert
    # parameters cannot accidentally be visited.
    for name, module in list(model.named_modules()):
        if isinstance(module, nn.Embedding):
            parent, child_name = module_parent(model, name)
            replace_child(parent, child_name, PackedEmbedding(store, name + ".weight", device))
        elif isinstance(module, nn.Linear):
            parent, child_name = module_parent(model, name)
            replace_child(parent, child_name, PackedLinear(store, name + ".weight", device, row_block))


def set_parameter(root: nn.Module, dotted: str, value: torch.Tensor, device: torch.device) -> None:
    parent, name = module_parent(root, dotted)
    current = getattr(parent, name)
    tensor = value.to(device=device)
    if isinstance(current, nn.Parameter):
        setattr(parent, name, nn.Parameter(tensor, requires_grad=False))
    else:
        setattr(parent, name, tensor)


def materialize_float_parameters(model: nn.Module, store: TensorStore, device: torch.device) -> None:
    missing: list[str] = []
    for name, parameter in list(model.named_parameters()):
        try:
            entry = store.entry(name)
        except KeyError:
            if parameter.device.type == "meta":
                missing.append(name)
            continue
        if entry["kind"] != "float":
            raise RuntimeError(f"A model parameter was left unquantized but is not float: {name}")
        set_parameter(model, name, store.float_tensor(name), device)
    for name, buffer in list(model.named_buffers()):
        try:
            entry = store.entry(name)
        except KeyError:
            if buffer.device.type == "meta":
                # The official model currently has no meta buffers under
                # init_empty_weights, but keep this guard explicit for upgrades.
                missing.append(name)
            continue
        if entry["kind"] != "float":
            raise RuntimeError(f"A model buffer was left unquantized but is not float: {name}")
        set_parameter(model, name, store.float_tensor(name), device)
    if missing:
        raise RuntimeError("Unmaterialized model tensors: " + ", ".join(missing[:12]))


def load_model(folder: Path, device: torch.device, row_block: int, gpu_weights: bool = False):
    metadata = json.loads((folder / "NAIVE_INT4.json").read_text(encoding="utf-8"))
    if metadata.get("format") != INT4_FORMAT:
        raise RuntimeError(f"Unsupported checkpoint format: {metadata.get('format')}")
    if metadata.get("experts_kept") != [0] or metadata.get("layers") != 48:
        raise RuntimeError("This runner expects the full-depth one-expert artifact")
    store = TensorStore(folder, metadata)
    config = AutoConfig.from_pretrained(folder, trust_remote_code=True)
    with init_empty_weights():
        model = AutoModelForCausalLM.from_config(config, trust_remote_code=True)
    replace_heavy_modules(model, store, device, row_block)
    # Only norms, sink biases and other small non-matrix parameters are left.
    # Keep initialized rotary buffers. to_empty() would overwrite inv_freq with
    # uninitialized memory and silently corrupt every layer's position encoding.
    materialize_float_parameters(model, store, device)
    for name, buffer in list(model.named_buffers()):
        if buffer.device.type != "meta":
            set_parameter(model, name, buffer, device)
    if gpu_weights:
        store.cache_packed_weights(device)
    model.eval().requires_grad_(False)
    return model, store


def choose_device(requested: str) -> torch.device:
    if requested == "cpu":
        return torch.device("cpu")
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("--device cuda requested but CUDA is unavailable")
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path(".local-data/models/Naive-N0.5-Flash-int4-48L-1E"),
    )
    parser.add_argument("--prompt", default="Say hello in one short sentence.")
    parser.add_argument("--max-new-tokens", type=int, default=8)
    parser.add_argument("--row-block", type=int, default=256)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--gpu-weights", action="store_true")
    args = parser.parse_args()
    if args.max_new_tokens < 1:
        raise SystemExit("--max-new-tokens must be positive")
    folder = args.model_dir.resolve()
    device = choose_device(args.device)
    print(f"Loading {folder} on {device}; INT4 row block={args.row_block}", flush=True)
    model, store = load_model(folder, device, args.row_block, args.gpu_weights)
    try:
        tokenizer = AutoTokenizer.from_pretrained(folder, trust_remote_code=True)
        inputs = tokenizer.apply_chat_template(
            [{"role": "user", "content": args.prompt}],
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        )
        inputs = {key: value.to(device) for key, value in inputs.items()}
        with torch.inference_mode():
            output = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
        prompt_length = inputs["input_ids"].shape[1]
        print(tokenizer.decode(output[0, prompt_length:], skip_special_tokens=True), flush=True)
    finally:
        store.close()


if __name__ == "__main__":
    main()

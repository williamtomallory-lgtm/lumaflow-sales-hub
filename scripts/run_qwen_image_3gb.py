"""Run the original Qwen image architecture with the project's 1/2/4-bit weights.

This is an extreme, lossy experimental checkpoint. It has no quality-retention
guarantee. Packed weights stay on CUDA; only the current matrix is expanded.
"""
from __future__ import annotations
import json
from pathlib import Path
import torch
import torch.nn.functional as F
from torch import nn


class PackedWeight:
    def __init__(self, packed, scales, info):
        self.packed = packed.to(device="cuda", dtype=torch.uint8)
        self.scales = scales.to(device="cuda", dtype=torch.float16)
        self.shape = tuple(info["shape"])
        self.bits = info["bits"]
        self.group = info["group_size"]
        self.per_byte = 8 // self.bits
        self.maximum = (1 << self.bits) - 1
        self.shifts = torch.arange(self.per_byte, dtype=torch.uint8, device="cuda") * self.bits

    def decode(self, first=0, last=None):
        length = 1
        for dimension in self.shape:
            length *= dimension
        last = length if last is None else last
        group_first, group_last = first // self.group, (last + self.group - 1) // self.group
        start, stop = group_first * self.group, group_last * self.group
        packed = self.packed[start // self.per_byte:stop // self.per_byte]
        codes = ((packed[:, None] >> self.shifts) & self.maximum).reshape(-1, self.group)
        values = (codes.float() * 2 - self.maximum) * self.scales[group_first:group_last, None]
        return values.reshape(-1)[first - start:last - start].to(torch.bfloat16)

    def rows(self, indices):
        columns = self.shape[1]
        locations = indices.reshape(-1, 1) * columns + torch.arange(columns, device="cuda")
        codes = (self.packed[locations // self.per_byte] >> ((locations % self.per_byte) * self.bits).to(torch.uint8)) & self.maximum
        return ((codes.float() * 2 - self.maximum) * self.scales[locations // self.group]).to(torch.bfloat16)


class PackedLinear(nn.Module):
    def __init__(self, weight, bias, row_block=1024):
        super().__init__()
        self.packed_weight = weight
        self.in_features = weight.shape[1]
        self.out_features = weight.shape[0]
        self.bias = bias
        self.row_block = row_block
        self.register_parameter("weight", nn.Parameter(torch.empty(weight.shape, device="meta", dtype=torch.bfloat16), requires_grad=False))

    def forward(self, inputs):
        # Decode small row groups, including the 152K-vocabulary output head.
        outputs = []
        for first in range(0, self.out_features, self.row_block):
            last = min(first + self.row_block, self.out_features)
            weight = self.packed_weight.decode(first * self.in_features, last * self.in_features).reshape(last - first, self.in_features)
            bias = self.bias[first:last] if self.bias is not None else None
            outputs.append(F.linear(inputs, weight, bias))
        return torch.cat(outputs, dim=-1)


class PackedEmbedding(nn.Module):
    def __init__(self, weight, padding_idx=None):
        super().__init__()
        self.packed_weight = weight
        self.num_embeddings, self.embedding_dim = weight.shape
        self.padding_idx = padding_idx
        self.register_parameter("weight", nn.Parameter(torch.empty(weight.shape, device="meta", dtype=torch.bfloat16), requires_grad=False))

    def forward(self, indices):
        return self.packed_weight.rows(indices).reshape(*indices.shape, self.embedding_dim)


def _module(model, name):
    parts = name.split(".")
    owner = model
    for part in parts[:-1]:
        owner = getattr(owner, part)
    return owner, parts[-1]


def load_component(folder: Path, component: str, should_stop=None):
    from accelerate import init_empty_weights
    from safetensors import safe_open
    from transformers import Qwen3VLConfig, Qwen3VLForConditionalGeneration
    from diffusers import QwenImage21Transformer2DModel, AutoencoderKLQwenImage21
    manifest = json.loads((folder / "LOCAL_IMAGE_MODEL.json").read_text(encoding="utf-8"))
    tensors = manifest["components"][component]["tensors"]
    source = folder / component
    with init_empty_weights():
        if component == "text_encoder":
            config = Qwen3VLConfig.from_pretrained(source, local_files_only=True)
            config._attn_implementation = "sdpa"
            model = Qwen3VLForConditionalGeneration(config)
        elif component == "transformer":
            cls = QwenImage21Transformer2DModel
            model = cls.from_config(cls.load_config(source))
        else:
            cls = AutoencoderKLQwenImage21
            model = cls.from_config(cls.load_config(source))
    packed = {}
    # Load small vectors first so replaced linear modules preserve their bias.
    for name, info in tensors.items():
        if should_stop and should_stop():
            raise InterruptedError("Image operation cancelled")
        if info["bits"]:
            continue
        with safe_open(str(source / info["file"]), framework="pt", device="cpu") as handle:
            value = handle.get_tensor("weight").to(device="cuda", dtype=torch.bfloat16)
        owner, key = _module(model, name)
        if key in owner._parameters:
            owner._parameters[key] = nn.Parameter(value, requires_grad=False)
        else:
            owner._buffers[key] = value
    for name, info in tensors.items():
        if should_stop and should_stop():
            raise InterruptedError("Image operation cancelled")
        if not info["bits"]:
            continue
        with safe_open(str(source / info["file"]), framework="pt", device="cpu") as handle:
            packed[name] = PackedWeight(handle.get_tensor("packed"), handle.get_tensor("scales"), info)
        owner, key = _module(model, name)
        if key != "weight":
            raise ValueError(f"Unsupported packed parameter: {name}")
        module_name = name.rsplit(".", 1)[0]
        parent, attribute = _module(model, module_name)
        if isinstance(owner, nn.Linear):
            setattr(parent, attribute, PackedLinear(packed[name], owner.bias))
        elif isinstance(owner, nn.Embedding):
            setattr(parent, attribute, PackedEmbedding(packed[name], owner.padding_idx))
        elif isinstance(owner, (nn.Conv1d, nn.Conv2d, nn.Conv3d)):
            # Keep the original causal-convolution subclass and its padding/cache
            # behavior. Materialize the weight just while that module executes.
            original = owner._parameters["weight"]
            def before(module, args, weight=packed[name]):
                module._parameters["weight"] = nn.Parameter(weight.decode().reshape(weight.shape), requires_grad=False)
            def after(module, args, result, empty=original):
                module._parameters["weight"] = empty
            owner.register_forward_pre_hook(before)
            owner.register_forward_hook(after, always_call=True)
        else:
            raise ValueError(f"Unsupported packed module: {module_name}: {type(owner).__name__}")
    # Preserve constructor-initialized RoPE constants: never use to_empty().
    for module in model.modules():
        for name, value in module._buffers.items():
            if value is not None and value.device.type != "meta":
                module._buffers[name] = value.to("cuda")
    missing = [name for name, parameter in model.named_parameters() if parameter.device.type == "meta" and name not in tensors]
    if missing:
        raise ValueError(f"Original model parameters were not loaded: {missing[:5]}")
    # Diffusers finds the execution device from the model's first parameter.
    model.register_parameter("_runtime_anchor", nn.Parameter(torch.empty(0, dtype=torch.bfloat16, device="cuda"), requires_grad=False))
    model.eval()
    print(f"{component}: packed original architecture; allocated_mib={torch.cuda.memory_allocated()/2**20:.0f}", flush=True)
    return model

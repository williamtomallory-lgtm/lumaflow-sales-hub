"""Build an NF4 local checkpoint from the exact official Qwen-Image-2.1 weights."""
from __future__ import annotations
import argparse
import gc
import json
import os
import shutil
import time
from pathlib import Path

SOURCE = "Qwen/Qwen-Image-2.1"
REVISION = "790c92633540aa0cb11d9abf19eb46d861714758"
os.environ["HF_DEACTIVATE_ASYNC_LOAD"] = "1"
os.environ["HF_ENABLE_PARALLEL_LOADING"] = "false"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=Path(".local-data/models/Qwen-Image-2.1-BF16"))
    parser.add_argument("--output-dir", type=Path, default=Path(".local-data/models/Qwen-Image-2.1-NF4"))
    parser.add_argument("--component", choices=("text_encoder", "transformer", "all"), default="all")
    args = parser.parse_args()
    import torch
    from qwen_image_loading import configure_windows_loading
    from transformers import Qwen3VLForConditionalGeneration, BitsAndBytesConfig as HFQuant
    from diffusers import QwenImage21Transformer2DModel, BitsAndBytesConfig as DiffQuant
    configure_windows_loading()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    components = ("text_encoder", "transformer") if args.component == "all" else (args.component,)
    for component in components:
        target = args.output_dir / component
        existing = json.loads((target / "config.json").read_text(encoding="utf-8")) if (target / "config.json").is_file() else {}
        head_quantized = component != "text_encoder" or existing.get("quantization_config", {}).get("llm_int8_skip_modules") == []
        if head_quantized and existing and list(target.glob("*.safetensors")):
            print(f"{component}: existing quantized checkpoint", flush=True)
            continue
        started = time.monotonic()
        cls, qcls = (Qwen3VLForConditionalGeneration, HFQuant) if component == "text_encoder" else (QwenImage21Transformer2DModel, DiffQuant)
        config = qcls(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16, llm_int8_skip_modules=[] if component == "text_encoder" else None)
        model = cls.from_pretrained(str(args.source_dir / component), quantization_config=config, dtype=torch.bfloat16, device_map={"": "cuda:0"}, local_files_only=True, low_cpu_mem_usage=True)
        print(f"{component}: quantized; allocated_mib={torch.cuda.memory_allocated()/2**20:.0f}", flush=True)
        model.save_pretrained(target, safe_serialization=True, max_shard_size="2GB")
        del model
        gc.collect()
        torch.cuda.empty_cache()
        print(f"{component}: saved in {time.monotonic()-started:.1f}s", flush=True)
    for name in ("processor", "scheduler", "vae"):
        if not (args.output_dir / name).exists() and (args.source_dir / name).exists():
            shutil.copytree(args.source_dir / name, args.output_dir / name)
    for name in ("model_index.json", "LICENSE"):
        if (args.source_dir / name).is_file():
            shutil.copy2(args.source_dir / name, args.output_dir / name)
    if all((args.output_dir / name / "config.json").exists() for name in ("text_encoder", "transformer", "vae")):
        weights = sum(p.stat().st_size for p in args.output_dir.rglob("*.safetensors"))
        manifest = {"source": SOURCE, "revision": REVISION, "format": "bitsandbytes-nf4-double-quant", "weights_bytes": weights, "quality_validated": False}
        (args.output_dir / "LOCAL_IMAGE_MODEL.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(json.dumps(manifest), flush=True)

if __name__ == "__main__":
    main()

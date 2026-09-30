"""Run a local diagnostic prompt against the experimental Naive weight prune.

The 6-layer checkpoint loads and generates, but has failed basic language checks.
This script does not stop or replace the currently running Bonsai service.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="Text to send as a user message")
    parser.add_argument("--model", type=Path, default=Path(".local-data/models/Naive-N0.5-Flash-pruned-6L-1E"))
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--max-new-tokens", type=int, default=32)
    args = parser.parse_args()
    if not 1 <= args.max_new_tokens <= 128:
        parser.error("--max-new-tokens must be between 1 and 128")
    folder = args.model.resolve()
    if not (folder / "PRUNING.json").exists() or not (folder / "model.safetensors.index.json").exists():
        parser.error(f"Pruned Naive checkpoint is missing or incomplete: {folder}")
    if args.device == "cuda":
        if not torch.cuda.is_available():
            parser.error("CUDA is unavailable")
        free_bytes, _ = torch.cuda.mem_get_info()
        if free_bytes < 5 * 1024**3:
            parser.error(
                "Naive needs at least 5 GiB free GPU memory. Stop the Bonsai model temporarily, "
                "run this diagnostic, then restart Bonsai with npm run local:bonsai."
            )
    started = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(folder, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        folder,
        trust_remote_code=True,
        device_map=args.device,
        low_cpu_mem_usage=True,
        dtype=torch.bfloat16,
    ).eval()
    encoded = tokenizer.apply_chat_template(
        [{"role": "user", "content": args.prompt}],
        add_generation_prompt=True,
        tokenize=True,
        return_tensors="pt",
    )
    input_ids = (encoded["input_ids"] if hasattr(encoded, "keys") else encoded).to(args.device)
    with torch.inference_mode():
        output = model.generate(input_ids, max_new_tokens=args.max_new_tokens, do_sample=False)
    answer = tokenizer.decode(output[0][input_ids.shape[-1] :], skip_special_tokens=True)
    print(answer)
    print(f"Elapsed: {time.perf_counter() - started:.2f}s; output tokens: {output.shape[-1] - input_ids.shape[-1]}")
    print("Experimental 6-layer prune: basic conversation quality failed validation.")


if __name__ == "__main__":
    main()

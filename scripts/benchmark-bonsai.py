"""Repeatable local llama-server measurements; no dependencies or cloud requests.

python scripts/benchmark-bonsai.py --label baseline --output artifacts/bonsai/baseline.json
Keep prompts, seed, token budget, cache policy and runtime fixed for A/B comparisons.
"""
import argparse
import hashlib
import json
import platform
import re
import statistics
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path


def runtime_metadata(base):
    """Record hardware and only allowlisted launch flags, never API keys."""
    metadata = {"os": platform.platform(), "python": platform.python_version()}
    try:
        gpu = subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total,memory.used,temperature.gpu,power.draw", "--format=csv"],
                             capture_output=True, text=True, timeout=10, check=True)
        metadata["gpu_snapshot"] = gpu.stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        metadata["gpu_snapshot_error"] = type(error).__name__
    if platform.system() == "Windows":
        port = urlsplit(base).port or 80
        command = (f"$taskListener=Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction Stop | Select-Object -First 1; "
                   "$taskOwner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskListener.OwningProcess); "
                   "$taskOwner | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress")
        try:
            process = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                                     capture_output=True, text=True, timeout=15, check=True)
            owner = json.loads(process.stdout)
            if Path(owner["ExecutablePath"]).name.lower() == "llama-server.exe":
                metadata["binary_sha256"] = hashlib.sha256(Path(owner["ExecutablePath"]).read_bytes()).hexdigest()
                flags = {}
                for name in ["--model", "--alias", "-ngl", "-c", "-np", "-b", "-ub", "-fa", "--cache-type-k", "--cache-type-v",
                             "--threads", "--threads-batch", "--cache-ram", "--spec-type", "--spec-ngram-simple-size-n", "--spec-ngram-simple-size-m"]:
                    match = re.search(r"(?<!\S)" + re.escape(name) + r'\s+(?:"([^"]*)"|(\S+))', owner["CommandLine"])
                    if match:
                        flags[name] = match.group(1) if match.group(1) is not None else match.group(2)
                flags["--backend-sampling"] = bool(re.search(r"(?<!\S)--backend-sampling(?!\S)", owner["CommandLine"]))
                metadata["launch_flags"] = flags
        except (OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
            metadata["launch_metadata_error"] = type(error).__name__
    return metadata


def request(base, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=240)


def measure(base, model, prompt, tokens, cache=False):
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}],
               "temperature": 0, "seed": 1234, "max_tokens": tokens,
               "cache_prompt": cache, "stream": True,
               "stream_options": {"include_usage": True}}
    start = time.perf_counter()
    first = None
    output = ""
    timings, usage, finish = {}, {}, None
    done = False
    with request(base, "/v1/chat/completions", payload) as response:
        for raw in response:
            if not raw.startswith(b"data: "):
                continue
            value = raw[6:].strip()
            if value == b"[DONE]":
                done = True
                break
            event = json.loads(value)
            if "error" in event:
                raise RuntimeError(event["error"])
            timings = event.get("timings") or timings
            usage = event.get("usage") or usage
            for choice in event.get("choices", []):
                content = choice.get("delta", {}).get("content", "") or ""
                if content and first is None:
                    first = time.perf_counter()
                output += content
                finish = choice.get("finish_reason") or finish
    end = time.perf_counter()
    if not done or not output or not usage.get("completion_tokens") or not finish:
        raise RuntimeError("Incomplete generation: missing DONE, content, usage or finish reason")
    return {"ttft_ms": round((first - start) * 1000, 2),
            "elapsed_ms": round((end - start) * 1000, 2),
            "decode_tokens_per_second": timings.get("predicted_per_second"),
            "timings": timings, "usage": usage, "finish_reason": finish,
            "output_sha256": hashlib.sha256(output.encode()).hexdigest(), "output": output}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8081")
    parser.add_argument("--model", default="ternary-bonsai-2-27b")
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--tokens", type=int, default=128)
    parser.add_argument("--metadata-only", action="store_true", help="Record current hardware/runtime without generating text")
    args = parser.parse_args()
    if args.reps < 1 or args.tokens < 1:
        parser.error("reps and tokens must be positive")
    parsed_url = urlsplit(args.base_url)
    if parsed_url.scheme != "http" or parsed_url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("Use an HTTP loopback endpoint; benchmark prompts stay local")
    with request(args.base_url, "/props") as response:
        props = json.load(response)
    lines = "\n".join(f"测试记录 {i:02d}：展厅灯具采用暖白光，调光比例为{i % 10 + 1}成；这些是虚构测试数据。" for i in range(30))
    fixtures = {
        "short-chat": "用中文解释什么是灯具色温，给出两种常见应用。",
        "context-copy": "原样抄写以下测试文本，不添加解释或代码块：\n" + lines,
        "long-context": "根据以下虚构测试记录，总结展厅灯具调光时应该检查哪些项目：\n" + lines,
    }
    report = {"label": args.label, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "model": args.model, "base_url": args.base_url, "seed": 1234,
              "temperature": 0, "max_tokens": args.tokens, "reps": args.reps,
              "environment": runtime_metadata(args.base_url),
              "runtime": {key: props.get(key) for key in ["build_info", "model_ftype", "modalities", "default_generation_settings"]},
              "fixtures": fixtures, "results": {}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    def save():
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.metadata_only:
        save()
        print(json.dumps({"saved": str(args.output), "environment": report["environment"]}), flush=True)
        return
    # Explicit warmup recorded separately, never counted as a measured repetition.
    report["warmup"] = measure(args.base_url, args.model, "Reply with OK.", 8)
    save()
    for name, prompt in fixtures.items():
        rows = []
        report["results"][name] = {"runs": rows}
        for i in range(args.reps):
            row = measure(args.base_url, args.model, prompt, args.tokens)
            rows.append(row)
            save()
            print(json.dumps({"label": args.label, "case": name, "run": i + 1,
                              **{k: row[k] for k in ["ttft_ms", "elapsed_ms", "decode_tokens_per_second"]}}), flush=True)
        summary = {k: statistics.median(row[k] for row in rows) for k in ["ttft_ms", "elapsed_ms", "decode_tokens_per_second"] if all(row[k] is not None for row in rows)}
        report["results"][name]["median"] = summary
        save()
    # Two identical prefix-enabled calls show real cache reuse independently of
    # the uncached comparisons above; they are not mixed into speedup statistics.
    report["cache_probe"] = [measure(args.base_url, args.model, fixtures["long-context"], 32, True) for _ in range(2)]
    save()
    print(json.dumps({"saved": str(args.output), "summary": {k: v["median"] for k, v in report["results"].items()}}), flush=True)


if __name__ == "__main__":
    main()

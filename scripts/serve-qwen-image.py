"""Loopback Qwen Image 2.1 worker backed by stable-diffusion.cpp.

The worker deliberately keeps the HTTP contract used by the LumaFlow image
route while delegating inference to ``sd-cli``. Model files and the binary
are selected from ``config/qwen-image-2.1-gguf.json`` (or
``QWEN_IMAGE_CONFIG``), so this module does not download or transform model
weights. Only one CLI process is allowed at a time because a 12 GB GPU must
share memory with the local text model.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import io
import json
import os
import shutil
import subprocess
import traceback
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
MODEL = "Qwen/Qwen-Image-2.1"
OUTPUTS = ROOT / ".local-data" / "generated-images"
DEFAULT_CONFIG = ROOT / "config" / "qwen-image-2.1-gguf.json"
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_PROMPT_CHARS = 4000
MAX_IMAGE_PIXELS = 20_000_000
LOCK = threading.Lock()
PROCESS_LOCK = threading.Lock()
STAGE = "idle"
CURRENT_JOB = ""
CURRENT_STOP = threading.Event()
CURRENT_PROCESS: subprocess.Popen[bytes] | None = None


class WorkerError(Exception):
    """An expected API error with a stable error code."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class _MissingValue:
    pass


def _as_path(value: Any) -> Path:
    path = Path(str(value)).expanduser()
    return path if path.is_absolute() else ROOT / path


def _read_config() -> dict[str, Any]:
    configured = os.environ.get("QWEN_IMAGE_CONFIG", "").strip()
    path = _as_path(configured) if configured else DEFAULT_CONFIG
    if not path.is_file():
        return {
            "model": MODEL,
            "quantization": "gguf-q4_k",
            "sd_cli": ".local-runtime/qwen-image/bin/sd-cli.exe",
            "diffusion_model": ".local-data/models/Qwen-Image-2.1-GGUF/qwen_image_2.1-Q4_K.gguf",
            "vae": ".local-data/models/Qwen-Image-2.1-GGUF/qwen_image_2.1_vae_bf16.safetensors",
            "llm": ".local-data/models/Qwen-Image-2.1-GGUF/Qwen3VL-8B-Instruct-Q4_K_M.gguf",
            "llm_vision": ".local-data/models/Qwen-Image-2.1-GGUF/mmproj-Qwen3VL-8B-Instruct-F16.gguf",
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise WorkerError(503, "IMAGE_MODEL_CONFIG_INVALID", f"Qwen Image 配置文件无法读取：{error}") from error
    if not isinstance(data, dict):
        raise WorkerError(503, "IMAGE_MODEL_CONFIG_INVALID", "Qwen Image 配置文件必须是 JSON 对象。")
    return data


def _config_value(config: dict[str, Any], name: str, *aliases: str) -> Any:
    paths = config.get("paths")
    if isinstance(paths, dict):
        for key in (name, *aliases):
            if key in paths:
                return paths[key]
    for key in (name, *aliases):
        if key in config:
            return config[key]
    return _MissingValue()


def _configured_paths(config: dict[str, Any]) -> dict[str, Path]:
    env_names = {
        "sd_cli": "QWEN_IMAGE_SD_CLI",
        "diffusion_model": "QWEN_IMAGE_DIFFUSION_MODEL",
        "vae": "QWEN_IMAGE_VAE",
        "llm": "QWEN_IMAGE_LLM",
        "llm_vision": "QWEN_IMAGE_LLM_VISION",
    }
    defaults = {
        "sd_cli": ".local-runtime/qwen-image/bin/sd-cli.exe",
        "diffusion_model": ".local-data/models/Qwen-Image-2.1-GGUF/qwen_image_2.1-Q4_K.gguf",
        "vae": ".local-data/models/Qwen-Image-2.1-GGUF/qwen_image_2.1_vae_bf16.safetensors",
        "llm": ".local-data/models/Qwen-Image-2.1-GGUF/Qwen3VL-8B-Instruct-Q4_K_M.gguf",
        "llm_vision": ".local-data/models/Qwen-Image-2.1-GGUF/mmproj-Qwen3VL-8B-Instruct-F16.gguf",
    }
    aliases = {
        "sd_cli": ("sdCli", "binary", "executable"),
        "diffusion_model": ("diffusionModel", "model"),
        "vae": ("vaeModel",),
        "llm": ("text_encoder", "textEncoder"),
        "llm_vision": ("llmVision", "mmproj", "vision_projector"),
    }
    result: dict[str, Path] = {}
    for name, fallback in defaults.items():
        raw = os.environ.get(env_names[name], "").strip() or _config_value(config, name, *aliases[name])
        if isinstance(raw, _MissingValue) or raw is None or not str(raw).strip():
            raw = fallback
        candidates = raw if isinstance(raw, list) else [raw]
        resolved = [_as_path(item) for item in candidates if str(item).strip()]
        result[name] = next((item for item in resolved if item.is_file()), resolved[0] if resolved else _as_path(fallback))
    return result


def _model_settings() -> tuple[dict[str, Any], dict[str, Path]]:
    config = _read_config()
    paths = _configured_paths(config)
    return config, paths


def _required_files() -> tuple[dict[str, Any], dict[str, Path], list[Path]]:
    config, paths = _model_settings()
    required = [paths["sd_cli"], paths["diffusion_model"], paths["vae"], paths["llm"], paths["llm_vision"]]
    return config, paths, required


def _installed() -> tuple[bool, dict[str, Any], dict[str, Path], list[Path]]:
    config, paths, required = _required_files()
    missing = [path for path in required if not path.is_file() or path.stat().st_size <= 0]
    return not missing, config, paths, missing


def _safe_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _dimensions(config: dict[str, Any], images: list[Path]) -> tuple[int, int]:
    defaults = config.get("defaults") if isinstance(config.get("defaults"), dict) else {}
    width = _safe_int(config.get("width", defaults.get("width", 768)), 768, 32, 2048)
    height = _safe_int(config.get("height", defaults.get("height", 768)), 768, 32, 2048)
    width -= width % 32
    height -= height % 32
    if images:
        try:
            from PIL import Image

            with Image.open(images[-1]) as image:
                aspect = image.width / max(1, image.height)
            if aspect > 1.2:
                height = max(32, (round(width / aspect) // 32) * 32)
            elif aspect < 0.8:
                width = max(32, (round(height * aspect) // 32) * 32)
        except Exception:
            pass
    return width, height


def _decode_images(payload: dict[str, Any], job_dir: Path) -> list[Path]:
    images = payload.get("images", [])
    if not isinstance(images, list) or len(images) > 4:
        raise WorkerError(400, "INVALID_IMAGE_REQUEST", "图片附件数量必须为 0 到 4 张。")
    result: list[Path] = []
    try:
        from PIL import Image, ImageOps
    except ImportError as error:
        raise WorkerError(503, "IMAGE_PIL_UNAVAILABLE", "本机图片运行环境缺少 Pillow。") from error
    for index, item in enumerate(images):
        if not isinstance(item, dict):
            raise WorkerError(400, "INVALID_IMAGE_REQUEST", "图片附件格式无效。")
        data = item.get("url", "")
        if not isinstance(data, str) or not data.startswith(("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,")):
            raise WorkerError(400, "INVALID_IMAGE_REQUEST", "只接受本机 PNG、JPEG 或 WebP 图片附件。")
        try:
            raw = base64.b64decode(data.split(",", 1)[1], validate=True)
            with Image.open(io.BytesIO(raw)) as source:
                source.verify()
            with Image.open(io.BytesIO(raw)) as source:
                if source.width * source.height > MAX_IMAGE_PIXELS:
                    raise WorkerError(413, "IMAGE_TOO_LARGE", "上传图片像素数过大。")
                image = ImageOps.exif_transpose(source).convert("RGBA")
                destination = job_dir / f"input-{index}.png"
                image.save(destination, format="PNG")
        except WorkerError:
            raise
        except (binascii.Error, ValueError, OSError) as error:
            raise WorkerError(400, "INVALID_IMAGE_REQUEST", f"第 {index + 1} 张图片无法读取。") from error
        result.append(destination)
    return result


def _terminate_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        if os.name == "nt":
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=10, check=False, creationflags=flags)
        else:
            process.kill()
    except (OSError, subprocess.SubprocessError):
        try:
            process.kill()
        except OSError:
            pass


def _extra_args(config: dict[str, Any]) -> list[str]:
    raw = config.get("extra_args", config.get("extraArgs", []))
    if isinstance(raw, str):
        raw = raw.split()
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if str(item)]


def _command(config: dict[str, Any], paths: dict[str, Path], prompt: str, operation: str, image_paths: list[Path], output: Path, seed: int) -> list[str]:
    width, height = _dimensions(config, image_paths)
    defaults = config.get("defaults") if isinstance(config.get("defaults"), dict) else {}
    cfg_scale = config.get("cfg_scale", config.get("cfgScale", defaults.get("cfg_scale", 6.0)))
    sampling = str(config.get("sampling_method", config.get("samplingMethod", defaults.get("sampling_method", "euler"))))
    steps = _safe_int(config.get("steps", defaults.get("steps", 20)), 20, 1, 100)
    args = [
        str(paths["sd_cli"]),
        "--diffusion-model", str(paths["diffusion_model"]),
        "--vae", str(paths["vae"]),
        "--llm", str(paths["llm"]),
        "-p", prompt,
        "--cfg-scale", str(cfg_scale),
        "--sampling-method", sampling,
        "--offload-to-cpu",
        "--steps", str(steps),
        "-H", str(height),
        "-W", str(width),
        "-s", str(seed),
    ]
    args.extend(_extra_args(config))
    if operation == "edit":
        if not paths["llm_vision"].is_file():
            raise WorkerError(503, "IMAGE_VISION_MODEL_NOT_INSTALLED", "图片编辑需要 Qwen3-VL mmproj 视觉文件。")
        args.extend(["--llm_vision", str(paths["llm_vision"])])
    for image in image_paths:
        args.extend(["-r", str(image)])
    args.extend(["-o", str(output)])
    return args


def _run_cli(args: list[str], stop_event: threading.Event, timeout_seconds: int, log_path: Path) -> str:
    global CURRENT_PROCESS
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = log_path.open("wb")
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    if os.name == "nt":
        # The worker is normally launched by a hidden PowerShell process.  A
        # native sd-cli child must opt out of allocating its own console or a
        # black window can flash over the desktop during each request.
        creationflags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        process = subprocess.Popen(args, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT, creationflags=creationflags)
    except OSError as error:
        handle.close()
        raise WorkerError(503, "IMAGE_CLI_UNAVAILABLE", f"stable-diffusion.cpp 无法启动：{error}") from error
    with PROCESS_LOCK:
        CURRENT_PROCESS = process
    started = time.monotonic()
    try:
        while process.poll() is None:
            if stop_event.is_set():
                _terminate_process(process)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                raise InterruptedError("Image operation cancelled")
            if time.monotonic() - started > timeout_seconds:
                _terminate_process(process)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                raise WorkerError(504, "IMAGE_OPERATION_TIMEOUT", "图片生成超过本机运行时限，已停止。")
            stop_event.wait(0.2)
        code = process.returncode
    finally:
        with PROCESS_LOCK:
            if CURRENT_PROCESS is process:
                CURRENT_PROCESS = None
        handle.close()
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    if code != 0:
        tail = text[-1200:].strip()
        raise WorkerError(500, "IMAGE_CLI_FAILED", f"stable-diffusion.cpp 生成失败。{tail}")
    return text


def _execute(payload: dict[str, Any], stop_event: threading.Event) -> dict[str, Any]:
    global STAGE
    operation = payload.get("operation")
    prompt = payload.get("prompt", "")
    if operation not in ("generate", "edit", "analyze") or not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
        raise WorkerError(400, "INVALID_IMAGE_REQUEST", "图片操作或提示词无效。")
    if operation == "analyze":
        raise WorkerError(422, "IMAGE_ANALYZE_UNSUPPORTED", "当前 Qwen Image 2.1 sd-cli 后端只支持生成和编辑，图片分析暂不支持。")
    installed, config, paths, missing = _installed()
    if not installed:
        names = ", ".join(path.name for path in missing)
        raise WorkerError(503, "IMAGE_MODEL_NOT_INSTALLED", f"Qwen Image 2.1 GGUF 文件尚未完整安装：{names}")
    if operation == "edit" and not payload.get("images"):
        raise WorkerError(400, "INVALID_IMAGE_REQUEST", "图片编辑需要至少一张上传图片。")
    job_dir = OUTPUTS / ".jobs" / uuid.uuid4().hex
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        STAGE = "validating_images"
        image_paths = _decode_images(payload, job_dir)
        seed = _safe_int(payload.get("seed", 42), 42, -1, 2**63 - 1)
        output = job_dir / "output.png"
        log_path = job_dir / "sd-cli.log"
        args = _command(config, paths, prompt.strip(), operation, image_paths, output, seed)
        # The Next route aborts at 590 seconds. Keep the native child below
        # that deadline so it can report a controlled timeout first and leave
        # time for the route to release the model lease.
        timeout = min(580, _safe_int(os.environ.get("QWEN_IMAGE_TIMEOUT_SECONDS", config.get("timeout_seconds", config.get("timeoutSeconds", 540))), 540, 30, 580))
        STAGE = "generating" if operation == "generate" else "editing"
        _run_cli(args, stop_event, timeout, log_path)
        if stop_event.is_set():
            raise InterruptedError("Image operation cancelled")
        if not output.is_file() or output.stat().st_size <= 0:
            raise WorkerError(500, "IMAGE_OUTPUT_MISSING", "stable-diffusion.cpp 未生成图片文件。")
        try:
            from PIL import Image

            with Image.open(output) as image:
                image.verify()
            with Image.open(output) as image:
                width, height = image.size
        except (ImportError, OSError, ValueError) as error:
            raise WorkerError(500, "IMAGE_OUTPUT_INVALID", f"生成文件不是有效图片：{error}") from error
        OUTPUTS.mkdir(parents=True, exist_ok=True)
        filename = uuid.uuid4().hex + ".png"
        shutil.copyfile(output, OUTPUTS / filename)
        return {
            "operation": operation,
            "model": MODEL,
            "text": "本机 Qwen-Image-2.1 GGUF 已完成图片生成。" if operation == "generate" else "本机 Qwen-Image-2.1 GGUF 已完成图片编辑。",
            "images": [{"filename": filename, "width": width, "height": height}],
        }
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "LumaFlow-QwenImage/2.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, status: int, data: dict[str, Any]) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            try:
                installed, config, paths, missing = _installed()
                error = None
            except WorkerError as failure:
                installed, config, paths, missing = False, {}, {}, []
                error = failure.message
            self.send_json(200 if installed else 503, {
                "status": "ok" if installed else "not-installed",
                "busy": LOCK.locked(),
                "stage": STAGE,
                "model": MODEL,
                "backend": "stable-diffusion.cpp",
                "quantization": str(config.get("quantization", "gguf-q4_k")),
                "loaded": CURRENT_PROCESS is not None,
                "installed": installed,
                "missing": [path.name for path in missing],
                "error": error,
            })
        elif self.path == "/v1/models":
            try:
                installed = _installed()[0]
            except WorkerError:
                installed = False
            self.send_json(200, {"data": [{"id": MODEL}] if installed else []})
        else:
            self.send_json(404, {"error": {"message": "Not found"}})

    def do_POST(self) -> None:
        global STAGE, CURRENT_JOB, CURRENT_STOP
        if self.path == "/v1/image-operations/cancel":
            size = int(self.headers.get("Content-Length", "0"))
            if not 1 <= size <= 512:
                self.send_json(400, {"error": {"message": "Invalid cancel request"}})
                return
            try:
                data = json.loads(self.rfile.read(size))
                matched = bool(CURRENT_JOB) and data.get("jobId") == CURRENT_JOB
                if matched:
                    CURRENT_STOP.set()
                    with PROCESS_LOCK:
                        _terminate_process(CURRENT_PROCESS)
                self.send_json(200, {"data": {"cancelled": bool(matched)}})
            except (ValueError, TypeError, AttributeError):
                self.send_json(400, {"error": {"message": "Invalid cancel request"}})
            return
        if self.path != "/v1/image-operations":
            self.send_json(404, {"error": {"message": "Not found"}})
            return
        size = int(self.headers.get("Content-Length", "0"))
        if size < 1 or size > MAX_BODY_BYTES:
            self.send_json(413, {"error": {"message": "Image request too large"}})
            return
        if not LOCK.acquire(blocking=False):
            self.send_json(409, {"error": {"message": "Image worker is busy"}})
            return
        try:
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise WorkerError(400, "INVALID_IMAGE_REQUEST", "图片请求必须是 JSON 对象。")
            CURRENT_JOB = str(payload.get("jobId") or uuid.uuid4().hex)
            CURRENT_STOP = threading.Event()
            started = time.monotonic()
            data = _execute(payload, CURRENT_STOP)
            data["elapsedSeconds"] = round(time.monotonic() - started, 3)
            self.send_json(200, {"data": data})
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass
        except InterruptedError:
            self.send_json(499, {"error": {"code": "IMAGE_OPERATION_CANCELLED", "message": "Image operation cancelled"}})
        except WorkerError as error:
            self.send_json(error.status, {"error": {"code": error.code, "message": error.message}})
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": {"code": "INVALID_IMAGE_REQUEST", "message": str(error)[:500]}})
        except Exception as error:
            traceback.print_exc()
            self.send_json(500, {"error": {"code": "IMAGE_OPERATION_FAILED", "message": str(error)[:500]}})
        finally:
            STAGE = "idle"
            CURRENT_JOB = ""
            with PROCESS_LOCK:
                CURRENT_STOP = threading.Event()
            LOCK.release()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8084)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Qwen Image worker only supports loopback hosts")
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Local Qwen Image 2.1 GGUF worker: http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

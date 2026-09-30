"""Serve the experimental Naive INT4 checkpoint through a local OpenAI API.

This is a small compatibility server for the full-depth/one-expert artifact
created by ``build-naive-int4.py``.  It deliberately binds to loopback by
default and reports the artifact's unvalidated quality state in ``/health``.
The model is loaded before the HTTP server starts, so a successful health
response means that the real tokenizer and model were loaded successfully.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from transformers import TextIteratorStreamer, StoppingCriteria, StoppingCriteriaList


MODEL_ID = "naive-n0.5-flash-int4-48l-1e"
DEFAULT_MODEL_DIR = Path(".local-data/models/Naive-N0.5-Flash-int4-48L-1E")
DEFAULT_PORT = int(os.environ.get("NAIVE_INT4_PORT", "8083"))
DEFAULT_MAX_OUTPUT_TOKENS = 16
MAX_REQUEST_BYTES = 4 * 1024 * 1024


def load_runner_module() -> ModuleType:
    """Import the existing runner without duplicating its model code."""

    runner_path = Path(__file__).with_name("run-naive-int4.py")
    spec = importlib.util.spec_from_file_location("naive_int4_runner", runner_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not import runner: {runner_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


RUNNER = load_runner_module()


def error_payload(message: str, error_type: str = "invalid_request_error") -> dict[str, Any]:
    return {"error": {"message": message, "type": error_type}}


def message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") in {"text", "input_text"}:
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    if content is None:
        return ""
    return str(content)


def normalize_messages(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("messages must be a non-empty array")
    messages: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("each message must be an object")
        role = item.get("role")
        if not isinstance(role, str) or not role.strip():
            raise ValueError("each message needs a role")
        messages.append({"role": role, "content": message_text(item.get("content"))})
    return messages


class NaiveRuntime:
    """One loaded model and its serialized generation lock."""

    def __init__(self, folder: Path, device: Any, row_block: int, max_output_tokens: int, gpu_weights: bool = False):
        if row_block < 1:
            raise ValueError("row block must be positive")
        if not 1 <= max_output_tokens <= DEFAULT_MAX_OUTPUT_TOKENS:
            raise ValueError(f"max output tokens must be between 1 and {DEFAULT_MAX_OUTPUT_TOKENS}")
        self.folder = folder.resolve()
        self.device = device
        self.row_block = row_block
        self.max_output_tokens = max_output_tokens
        self.generation_lock = threading.Lock()
        self.model = None
        self.store = None
        self.tokenizer = None
        self.metadata: dict[str, Any] = {}
        self.quality_validated = False
        self.context_limit = 128

        metadata_path = self.folder / "NAIVE_INT4.json"
        if not metadata_path.is_file():
            raise FileNotFoundError(f"Missing INT4 manifest: {metadata_path}")
        self.metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if self.metadata.get("format") != RUNNER.INT4_FORMAT:
            raise RuntimeError(f"Unsupported checkpoint format: {self.metadata.get('format')}")

        # Loading is intentionally synchronous.  The server is not bound until
        # both model and tokenizer have loaded, so /health cannot claim ready
        # while the process is still constructing a model.
        started = time.monotonic()
        if device.type == "cuda":
            RUNNER.torch.cuda.set_per_process_memory_fraction(0.78)
        self.model, self.store = RUNNER.load_model(self.folder, self.device, self.row_block, gpu_weights)
        self.load_seconds = time.monotonic() - started
        try:
            self.tokenizer = RUNNER.AutoTokenizer.from_pretrained(
                self.folder, trust_remote_code=True
            )
        except Exception:
            self.store.close()
            self.store = None
            raise
        self.quality_validated = bool(self.metadata.get("quality_validated", False))
        # The reference attention materializes large score matrices. Bound the
        # experimental service to the tested laptop's 8 GB GPU budget.
        self.context_limit = min(
            int(getattr(self.model.config, "max_position_embeddings", 8192)), 128
        )

    @property
    def ready(self) -> bool:
        return self.model is not None and self.tokenizer is not None and self.store is not None

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok" if self.ready else "loading",
            "loaded": self.ready,
            "busy": self.generation_lock.locked(),
            "model": MODEL_ID,
            "device": str(self.device),
            "format": RUNNER.INT4_FORMAT,
            "layers": self.metadata.get("layers"),
            "experts_kept": self.metadata.get("experts_kept"),
            "quality_validated": self.quality_validated,
            "experimental": True,
            "max_output_tokens": self.max_output_tokens,
            "max_input_tokens": self.context_limit,
            "load_seconds": round(self.load_seconds, 3),
            "gpu_packed_weights": bool(self.store.gpu_tensors) if self.store else False,
            "cuda_allocated_mib": round(RUNNER.torch.cuda.memory_allocated() / 2**20) if self.device.type == "cuda" else 0,
            "cuda_reserved_mib": round(RUNNER.torch.cuda.memory_reserved() / 2**20) if self.device.type == "cuda" else 0,
        }

    def encode(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        assert self.tokenizer is not None
        try:
            encoded = self.tokenizer.apply_chat_template(
                messages,
                add_generation_prompt=True,
                return_dict=True,
                return_tensors="pt",
            )
        except Exception:
            # Keep the endpoint usable if a future tokenizer changes its chat
            # template.  The normal artifact path uses the official template.
            prompt = "\n".join(f"{item['role']}: {item['content']}" for item in messages)
            encoded = self.tokenizer(prompt, return_tensors="pt")

        inputs = {
            key: value.to(self.device)
            for key, value in encoded.items()
            if key in {"input_ids", "attention_mask", "position_ids"}
        }
        if "input_ids" not in inputs:
            raise RuntimeError("Tokenizer did not return input_ids")
        input_length = inputs["input_ids"].shape[-1]
        if input_length > self.context_limit:
            for key, value in list(inputs.items()):
                if value.ndim >= 2 and value.shape[-1] == input_length:
                    inputs[key] = value[..., -self.context_limit :]
        return inputs

    def generation_kwargs(self, payload: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
        requested = payload.get("max_completion_tokens", payload.get("max_tokens", self.max_output_tokens))
        if isinstance(requested, bool):
            raise ValueError("max_tokens must be an integer")
        try:
            requested_int = int(requested)
        except (TypeError, ValueError) as exc:
            raise ValueError("max_tokens must be an integer") from exc
        if requested_int < 1:
            raise ValueError("max_tokens must be positive")
        max_new_tokens = min(requested_int, self.max_output_tokens)

        # Preserve deterministic greedy generation by default, while accepting
        # the common OpenAI temperature/top_p fields for simple clients.
        temperature = payload.get("temperature")
        do_sample = False
        kwargs: dict[str, Any] = {
            **inputs,
            "max_new_tokens": max_new_tokens,
            "do_sample": False,
        }
        if temperature is not None:
            try:
                temperature_value = float(temperature)
            except (TypeError, ValueError) as exc:
                raise ValueError("temperature must be numeric") from exc
            if temperature_value > 0:
                do_sample = True
                kwargs["temperature"] = temperature_value
                top_p = payload.get("top_p")
                if top_p is not None:
                    kwargs["top_p"] = float(top_p)
        kwargs["do_sample"] = do_sample
        return kwargs

    def generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        messages = normalize_messages(payload.get("messages"))
        inputs = self.encode(messages)
        kwargs = self.generation_kwargs(payload, inputs)
        input_length = inputs["input_ids"].shape[-1]
        with RUNNER.torch.inference_mode():
            output = self.model.generate(**kwargs)
        generated_ids = output[0, input_length:]
        text = self.tokenizer.decode(generated_ids, skip_special_tokens=True)
        completion_tokens = int(generated_ids.shape[-1])
        finish_reason = "length" if completion_tokens >= kwargs["max_new_tokens"] else "stop"
        return {
            "text": text,
            "prompt_tokens": int(input_length),
            "completion_tokens": completion_tokens,
            "finish_reason": finish_reason,
        }

    def stream_generate(
        self,
        payload: dict[str, Any],
        on_text: Callable[[str], None],
    ) -> tuple[int, int, str]:
        messages = normalize_messages(payload.get("messages"))
        inputs = self.encode(messages)
        kwargs = self.generation_kwargs(payload, inputs)
        input_length = int(inputs["input_ids"].shape[-1])
        streamer = TextIteratorStreamer(
            self.tokenizer,
            skip_prompt=True,
            skip_special_tokens=True,
            timeout=1.0,
        )
        kwargs["streamer"] = streamer
        worker_error: list[BaseException] = []
        stop_event = threading.Event()

        class ClientStopped(StoppingCriteria):
            def __call__(self, input_ids, scores, **unused):
                return stop_event.is_set()

        kwargs["stopping_criteria"] = StoppingCriteriaList([ClientStopped()])

        def worker() -> None:
            try:
                with RUNNER.torch.inference_mode():
                    self.model.generate(**kwargs)
            except BaseException as exc:  # propagate the real generation error to the handler
                worker_error.append(exc)

        thread = threading.Thread(target=worker, name="naive-int4-generation", daemon=True)
        thread.start()
        completion_text_parts: list[str] = []
        try:
            while thread.is_alive() or not streamer.text_queue.empty():
                try:
                    chunk = next(streamer)
                except queue.Empty:
                    continue
                except StopIteration:
                    break
                if chunk:
                    completion_text_parts.append(chunk)
                    on_text(chunk)
        finally:
            stop_event.set()
            thread.join()
        if worker_error:
            raise RuntimeError("model generation failed") from worker_error[0]
        completion_text = "".join(completion_text_parts)
        completion_tokens = len(self.tokenizer.encode(completion_text, add_special_tokens=False))
        finish_reason = "length" if completion_tokens >= kwargs["max_new_tokens"] else "stop"
        return input_length, completion_tokens, finish_reason

    def close(self) -> None:
        if self.store is not None:
            self.store.close()
            self.store = None
        self.model = None
        self.tokenizer = None


class NaiveServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], runtime: NaiveRuntime):
        self.runtime = runtime
        super().__init__(address, NaiveRequestHandler)


class NaiveRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "NaiveInt4/1.0"

    @property
    def runtime(self) -> NaiveRuntime:
        return self.server.runtime  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _send_json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)

    def _read_json(self) -> dict[str, Any]:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise ValueError("Content-Length is required")
        try:
            size = int(content_length)
        except ValueError as exc:
            raise ValueError("Content-Length is invalid") from exc
        if size < 0 or size > MAX_REQUEST_BYTES:
            raise ValueError("Request body is too large")
        raw = self.rfile.read(size)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Request body must be valid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("Request body must be a JSON object")
        return value

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_json(HTTPStatus.OK if self.runtime.ready else HTTPStatus.SERVICE_UNAVAILABLE, self.runtime.health())
            return
        if path == "/v1/models":
            self._send_json(
                HTTPStatus.OK,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": MODEL_ID,
                            "object": "model",
                            "created": 0,
                            "owned_by": "NaiveAI",
                        }
                    ],
                },
            )
            return
        self._send_json(HTTPStatus.NOT_FOUND, error_payload("Not found", "invalid_request_error"))

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.split("?", 1)[0]
        if path != "/v1/chat/completions":
            self._send_json(HTTPStatus.NOT_FOUND, error_payload("Not found"))
            return
        try:
            payload = self._read_json()
            requested_model = payload.get("model")
            if requested_model not in (None, MODEL_ID):
                raise ValueError(f"model must be {MODEL_ID}")
            messages = normalize_messages(payload.get("messages"))
            payload["messages"] = messages
            stream = bool(payload.get("stream", False))
        except ValueError as exc:
            # This branch runs before a request id or SSE headers exist.
            self._send_json(HTTPStatus.BAD_REQUEST, error_payload(str(exc)))
            return

        if not self.runtime.generation_lock.acquire(blocking=False):
            self._send_json(
                HTTPStatus.TOO_MANY_REQUESTS,
                error_payload("The local Naive INT4 runtime is busy; retry shortly.", "rate_limit_error"),
            )
            return

        request_id = f"chatcmpl-naive-{uuid.uuid4().hex}"
        created = int(time.time())
        try:
            if stream:
                self._stream_completion(payload, request_id, created)
            else:
                result = self.runtime.generate(payload)
                response = {
                    "id": request_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": MODEL_ID,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": result["text"]},
                            "finish_reason": result["finish_reason"],
                        }
                    ],
                    "usage": {
                        "prompt_tokens": result["prompt_tokens"],
                        "completion_tokens": result["completion_tokens"],
                        "total_tokens": result["prompt_tokens"] + result["completion_tokens"],
                    },
                }
                self._send_json(HTTPStatus.OK, response)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except ValueError as exc:
            if stream:
                self._send_sse_error(request_id, created, str(exc))
            else:
                self._send_json(HTTPStatus.BAD_REQUEST, error_payload(str(exc)))
        except Exception as exc:
            traceback.print_exc()
            if stream and self.wfile:
                self._send_sse_error(request_id, created, str(exc))
            else:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, error_payload("Model generation failed", "server_error"))
        finally:
            if self.runtime.device.type == "cuda":
                RUNNER.torch.cuda.empty_cache()
            self.runtime.generation_lock.release()

    def _send_sse(self, body: dict[str, Any]) -> None:
        payload = f"data: {json.dumps(body, ensure_ascii=False, separators=(',', ':'))}\n\n".encode("utf-8")
        self.wfile.write(payload)
        self.wfile.flush()

    def _stream_completion(self, payload: dict[str, Any], request_id: str, created: int) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self._send_sse(
            {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": MODEL_ID,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            }
        )

        def on_text(text: str) -> None:
            self._send_sse(
                {
                    "id": request_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": MODEL_ID,
                    "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                }
            )

        _, _, finish_reason = self.runtime.stream_generate(payload, on_text)
        self._send_sse(
            {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": MODEL_ID,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
            }
        )
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _send_sse_error(self, request_id: str, created: int, message: str) -> None:
        try:
            self._send_sse(
                {
                    "id": request_id,
                    "object": "error",
                    "created": created,
                    "model": MODEL_ID,
                    "error": {"message": message, "type": "server_error"},
                }
            )
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--row-block", type=int, default=256)
    parser.add_argument("--gpu-weights", action="store_true")
    parser.add_argument("--max-output-tokens", type=int, default=DEFAULT_MAX_OUTPUT_TOKENS)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if not 1 <= args.max_output_tokens <= DEFAULT_MAX_OUTPUT_TOKENS:
        parser.error(f"--max-output-tokens must be between 1 and {DEFAULT_MAX_OUTPUT_TOKENS}")
    return args


def main() -> None:
    args = parse_args()
    folder = args.model_dir.resolve()
    device = RUNNER.choose_device(args.device)
    print(
        f"Loading {folder} on {device}; INT4 row block={args.row_block}; "
        f"max output={args.max_output_tokens}",
        flush=True,
    )
    runtime = NaiveRuntime(folder, device, args.row_block, args.max_output_tokens, args.gpu_weights)
    try:
        server = NaiveServer((args.host, args.port), runtime)
    except Exception:
        runtime.close()
        raise
    print(f"Naive INT4 API ready at http://{args.host}:{args.port}", flush=True)
    print("GET /health; GET /v1/models; POST /v1/chat/completions", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("Stopping Naive INT4 API", flush=True)
    finally:
        server.server_close()
        runtime.close()


if __name__ == "__main__":
    main()

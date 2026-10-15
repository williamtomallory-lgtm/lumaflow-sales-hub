#!/usr/bin/env python3
"""Apply the pinned Octop Windows ConPTY compatibility patch.

The pinned Octop release only enables the web terminal on POSIX because its
original implementation calls pty, os.write and killpg. This patch keeps that
implementation untouched on POSIX and adds a small adapter around pywinpty for
Windows. It is applied to the installed package (wheel or editable checkout),
rather than changing repository-tracked upstream code.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, NoReturn


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PYTHON = REPO_ROOT / ".local-runtime" / "octop" / "venv" / "Scripts" / "python.exe"
OCTOP_VERSION = "1.0.2b7"
PYWINPTY_VERSION = "2.0.15"
PATCH_VERSION = "2"
PATCH_MARKER = "LUMAFLOW_OCTOP_WINDOWS_CONPTY_PATCH_V1"
UPSTREAM_TERMINAL_SHA256 = "6eea7517fd546b83e9417a1b6dbf068b74b8a8c4fab601e6ef48e608d08576cc"


class PatchError(RuntimeError):
    """An actionable, non-secret patching error."""


def die(message: str) -> NoReturn:
    raise PatchError(message)


def clean_network_env() -> dict[str, str]:
    """Remove stale proxy variables for package installation children only."""
    env = os.environ.copy()
    for name in list(env):
        if name.lower() in {"http_proxy", "https_proxy", "all_proxy"}:
            env.pop(name, None)
    return env


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def target_terminal_path(python: Path) -> Path:
    """Resolve terminal.py through the target interpreter without importing it."""
    code = (
        "import importlib.util\n"
        "p=importlib.util.find_spec('octop.api.routers.terminal')\n"
        "if p is None or not p.origin: raise SystemExit('terminal module not found')\n"
        "print(p.origin)"
    )
    try:
        result = subprocess.run(
            [str(python), "-c", code],
            check=True,
            capture_output=True,
            text=True,
            env=clean_network_env(),
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        die(f"cannot locate Octop terminal.py: {detail.strip()}")
    raw = result.stdout.strip().splitlines()
    if not raw:
        die("target Python returned no Octop terminal.py path")
    path = Path(raw[-1]).resolve()
    if not path.is_file() or path.name != "terminal.py":
        die(f"invalid Octop terminal.py path: {path}")
    return path


def ensure_pywinpty(python: Path, *, install: bool, offline: bool) -> dict[str, Any]:
    """Check or install the pinned pywinpty wheel in the target venv."""
    probe = (
        "import importlib.util; "
        "print('yes' if importlib.util.find_spec('winpty') else 'no')"
    )
    try:
        result = subprocess.run(
            [str(python), "-c", probe],
            check=True,
            capture_output=True,
            text=True,
            env=clean_network_env(),
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        die(f"cannot check pywinpty: {getattr(exc, 'stderr', '') or exc}")
    present = result.stdout.strip() == "yes"
    installed = False
    if not present and install:
        uv = REPO_ROOT / ".local-runtime" / "tools" / "uv.exe"
        command = [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
        ]
        if offline:
            command.append("--no-index")
        command.append(f"pywinpty=={PYWINPTY_VERSION}")
        if uv.is_file():
            command = [str(uv), "pip", "install", "--python", str(python), *(["--offline"] if offline else []), f"pywinpty=={PYWINPTY_VERSION}"]
        try:
            subprocess.run(command, check=True, env=clean_network_env())
        except (OSError, subprocess.CalledProcessError) as exc:
            die(
                f"installing pywinpty=={PYWINPTY_VERSION} failed; "
                f"prepare a compatible wheel: {getattr(exc, 'stderr', '') or exc}"
            )
        present = True
        installed = True
    return {
        "package": "pywinpty",
        "version": PYWINPTY_VERSION,
        "present": present,
        "installed": installed,
    }


def _windows_patch_block() -> str:
    """Return the reviewed adapter block inserted into terminal.py."""
    return r'''

# LUMAFLOW_OCTOP_WINDOWS_CONPTY_PATCH_V1
# Windows has no POSIX master/slave fd or process group. pywinpty exposes a
# ConPTY-backed string stream; this adapter gives the existing session manager
# the poll/read/write/resize/close surface it already expects.
class _WindowsPty:
    """Adapter from pywinpty's PtyProcess to the Octop session surface."""

    def __init__(self, pty: Any) -> None:
        self.pty = pty
        self.pid = int(getattr(pty, "pid", 0) or 0)
        self.closed = False
        self.pty.fileobj.settimeout(0.1)

    def poll(self) -> int | None:
        try:
            if self.pty.isalive():
                return None
        except Exception:
            return 0
        status = getattr(self.pty, "exitstatus", 0)
        return int(status) if isinstance(status, int) else 0

    def read(self, size: int = 4096) -> str:
        return self.pty.read(size)

    def write(self, data: str) -> int:
        return int(self.pty.write(data))

    def setwinsize(self, rows: int, cols: int) -> None:
        self.pty.setwinsize(rows, cols)

    def close(self) -> None:
        if self.closed:
            return
        try:
            self.pty.close(force=True)
        except Exception:
            # pywinpty may raise after closing its socket when the shell does
            # not answer the first termination request.
            with contextlib.suppress(Exception):
                self.pty.kill()
            with contextlib.suppress(Exception):
                self.pty.close()
        self.closed = True


def _is_windows_pty(value: Any) -> bool:
    return os.name == "nt" and isinstance(value, _WindowsPty)


def _spawn_windows_pty_session(
    sid: str,
    agent_id: str,
    user_id: int,
    workspace_dir: str,
    cols: int,
    rows: int,
    persistent: bool,
) -> _PtySession:
    """Spawn an interactive cmd or PowerShell process through Windows ConPTY."""
    from winpty import PtyProcess

    shell = _detect_shell()
    env = _shell_env(shell=shell)
    cwd = workspace_dir
    if not os.path.isdir(cwd):
        cwd = os.path.expanduser("~") or (os.environ.get("SystemDrive", "C:") + os.sep)
        logger.warning(
            "terminal cwd missing, falling back: agent=%s wanted=%s using=%s",
            agent_id,
            workspace_dir,
            cwd,
        )
    child = PtyProcess.spawn([shell], cwd=cwd, env=env, dimensions=(rows, cols))
    bridge = _WindowsPty(child)
    session = _PtySession(
        sid,
        agent_id,
        user_id,
        bridge,
        bridge,
        cols,
        rows,
        persistent,
    )
    logger.info(
        "terminal opened: agent=%s sid=%s pid=%s shell=%s cwd=%s persistent=%s backend=ConPTY",
        agent_id,
        sid,
        bridge.pid,
        shell,
        cwd,
        persistent,
    )
    return session


def _write_master(master: Any, data: str) -> None:
    if _is_windows_pty(master):
        try:
            master.write(data)
        except EOFError as exc:
            raise OSError("ConPTY is closed") from exc
        return
    os.write(master, data.encode("utf-8"))


def _close_master(master: Any) -> None:
    if _is_windows_pty(master):
        master.close()
        return
    os.close(master)
'''


def apply_text_patch(original: str) -> str:
    """Transform the pinned terminal module, refusing partial replacements."""
    if PATCH_MARKER in original:
        return original

    block = _windows_patch_block()
    old_support = '''def terminal_supported() -> tuple[bool, str]:
    """Return ``(supported, reason_if_unsupported)`` for the PTY WebSocket terminal."""
    if os.name != "posix":
        return False, _TERMINAL_UNSUPPORTED_REASON
    try:
        import fcntl  # noqa: F401
        import pty  # noqa: F401
        import termios  # noqa: F401
    except ImportError:
        return False, "PTY terminal dependencies are not available on this platform."
    return True, ""
'''
    new_support = '''def terminal_supported() -> tuple[bool, str]:
    """Return ``(supported, reason_if_unsupported)`` for the PTY WebSocket terminal."""
    if os.name == "nt":
        try:
            import winpty  # noqa: F401
        except ImportError:
            return False, "Windows ConPTY dependency pywinpty is not installed."
        return True, ""
    if os.name != "posix":
        return False, _TERMINAL_UNSUPPORTED_REASON
    try:
        import fcntl  # noqa: F401
        import pty  # noqa: F401
        import termios  # noqa: F401
    except ImportError:
        return False, "PTY terminal dependencies are not available on this platform."
    return True, ""
'''
    if old_support not in original:
        die("terminal.py does not match pinned Octop: terminal_supported() not found")
    patched = original.replace(old_support, new_support, 1)

    old_winsize = '''def _set_winsize(fd: int, cols: int, rows: int) -> None:
    """ioctl TIOCSWINSZ on the master fd. Errors are non-fatal."""
    try:
        posix_compat.set_winsize(fd, cols, rows)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("failed to set winsize: %s", exc)
'''
    new_winsize = '''def _set_winsize(fd: Any, cols: int, rows: int) -> None:
    """Resize a POSIX PTY or the Windows ConPTY adapter."""
    if _is_windows_pty(fd):
        try:
            fd.setwinsize(rows, cols)
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("failed to set ConPTY size: %s", exc)
        return
    try:
        posix_compat.set_winsize(fd, cols, rows)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("failed to set winsize: %s", exc)
'''
    if old_winsize not in patched:
        die("terminal.py does not match pinned Octop: _set_winsize() not found")
    patched = patched.replace(old_winsize, block + "\n" + new_winsize, 1)

    old_spawn_doc = '''    master_fd, slave_fd = posix_compat.openpty()
'''
    new_spawn_doc = '''    if os.name == "nt":
        return _spawn_windows_pty_session(
            sid, agent_id, user_id, workspace_dir, cols, rows, persistent
        )
    master_fd, slave_fd = posix_compat.openpty()
'''
    if old_spawn_doc not in patched:
        die("terminal.py does not match pinned Octop: _spawn_pty_session() not found")
    patched = patched.replace(old_spawn_doc, new_spawn_doc, 1)

    old_pump = '''        data = _read_nonblock(session.master_fd)
        if data is None:
'''
    new_pump = '''        if _is_windows_pty(session.master_fd):
            # pywinpty's socket read is blocking by design; keep it off the
            # event loop while preserving the existing POSIX fast path.
            data = await asyncio.to_thread(_read_nonblock, session.master_fd)
        else:
            data = _read_nonblock(session.master_fd)
        if data is None:
'''
    if old_pump not in patched:
        die("terminal.py does not match pinned Octop: _pump_pty() not found")
    patched = patched.replace(old_pump, new_pump, 1)

    old_close_master = '''    with contextlib.suppress(OSError):
        os.close(session.master_fd)
'''
    new_close_master = '''    with contextlib.suppress(Exception):
        _close_master(session.master_fd)
'''
    if old_close_master not in patched:
        die("terminal.py does not match pinned Octop: PTY close() not found")
    patched = patched.replace(old_close_master, new_close_master, 1)

    old_write = '''                            os.write(session.master_fd, data.encode("utf-8"))
'''
    new_write = '''                            _write_master(session.master_fd, data)
'''
    if old_write not in patched:
        die("terminal.py does not match pinned Octop: PTY write() not found")
    patched = patched.replace(old_write, new_write, 1)

    old_read = '''def _read_nonblock(fd: int | None) -> bytes | None:
    """Return ``bytes`` read, ``None`` if would-block, ``b""`` on EOF."""
    if fd is None:
        return b""
    try:
        return os.read(fd, 4096)
    except OSError as exc:
        if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
            return None
        return b""
'''
    new_read = '''def _read_nonblock(fd: Any) -> bytes | None:
    """Return bytes, None if POSIX would-block, or b"" on EOF."""
    if fd is None:
        return b""
    if _is_windows_pty(fd):
        try:
            data = fd.read(4096)
        except TimeoutError:
            return None
        except (EOFError, OSError):
            return b""
        if not data:
            return b""
        if isinstance(data, str):
            return data.encode("utf-8", errors="replace")
        return bytes(data)
    try:
        return os.read(fd, 4096)
    except OSError as exc:
        if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
            return None
        return b""
'''
    if old_read not in patched:
        die("terminal.py does not match pinned Octop: _read_nonblock() not found")
    patched = patched.replace(old_read, new_read, 1)

    old_terminate = '''def _terminate_process_group(proc: subprocess.Popen[bytes]) -> None:
    """SIGTERM (then SIGKILL) the shell's process group. Blocking — run in executor."""
    try:
'''
    new_terminate = '''def _terminate_process_group(proc: subprocess.Popen[bytes]) -> None:
    """Terminate a POSIX process group or a Windows ConPTY child."""
    if _is_windows_pty(proc):
        proc.close()
        return
    try:
'''
    if old_terminate not in patched:
        die("terminal.py does not match pinned Octop: process cleanup() not found")
    patched = patched.replace(old_terminate, new_terminate, 1)

    if PATCH_MARKER not in patched:
        die("Windows ConPTY patch insertion did not complete")
    return patched


def write_metadata(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def apply_patch(
    python: Path,
    *,
    install_dependency: bool,
    offline: bool,
    force: bool,
) -> dict[str, Any]:
    if os.name != "nt":
        return {
            "status": "skipped",
            "reason": "Windows ConPTY patch is only needed on Windows",
            "python": str(python),
        }
    if not python.is_file():
        die(f"target Python does not exist: {python}")
    dependency = ensure_pywinpty(python, install=install_dependency, offline=offline)
    terminal = target_terminal_path(python)
    original_bytes = terminal.read_bytes()
    original_hash = sha256_bytes(original_bytes)
    # The upstream source may be checked out with CRLF on Windows; the
    # transformation itself is line-ending neutral and writes canonical LF.
    original_text = original_bytes.decode("utf-8", errors="replace").replace("\r\n", "\n")
    if PATCH_MARKER in original_text:
        if original_hash == "6f1b4c1ccbdafbe3a9f08ebc012a8f3fbc8c3cd3b30bf6cbbb96b1f0b4d83c80":
            prior = terminal.with_name(f"{terminal.name}.octop-upstream-{UPSTREAM_TERMINAL_SHA256[:12]}.bak")
            if not prior.is_file() or sha256_bytes(prior.read_bytes()) != UPSTREAM_TERMINAL_SHA256:
                die("cannot upgrade ConPTY without the verified original backup")
            original_bytes = prior.read_bytes()
            original_hash = UPSTREAM_TERMINAL_SHA256
            original_text = original_bytes.decode("utf8").replace("\r\n", "\n")
        else:
            return {
            "status": "already-applied",
            "patchVersion": PATCH_VERSION,
            "python": str(python),
            "terminal": str(terminal),
            "terminalSha256": original_hash,
            "dependency": dependency,
            }
    if original_hash != UPSTREAM_TERMINAL_SHA256 and not force:
        die(
            "Octop terminal.py SHA-256 does not match pinned version; "
            "review the release first or use --force explicitly."
        )
    patched_text = apply_text_patch(original_text)
    compile(patched_text, str(terminal), "exec")
    backup = terminal.with_name(
        f"{terminal.name}.octop-upstream-{original_hash[:12]}.bak"
    )
    if not backup.exists():
        shutil.copy2(terminal, backup)
    with terminal.open("w", encoding="utf-8", newline="") as handle:
        handle.write(patched_text)
    patched_hash = sha256_bytes(terminal.read_bytes())
    metadata = {
        "status": "applied",
        "patchVersion": PATCH_VERSION,
        "octopVersion": OCTOP_VERSION,
        "upstreamTerminalSha256": original_hash,
        "patchedTerminalSha256": patched_hash,
        "terminal": str(terminal),
        "backup": str(backup),
        "python": str(python),
        "dependency": dependency,
        "appliedAt": int(time.time()),
    }
    marker = terminal.with_name("terminal.py.octop-windows-patch.json")
    write_metadata(marker, metadata)
    return metadata


def check_patch(python: Path) -> dict[str, Any]:
    if os.name != "nt":
        return {"status": "skipped", "reason": "host is not Windows"}
    if not python.is_file():
        die(f"target Python does not exist: {python}")
    terminal = target_terminal_path(python)
    data = terminal.read_bytes()
    text = data.decode("utf-8", errors="replace")
    dependency = ensure_pywinpty(python, install=False, offline=False)
    return {
        "status": "applied" if PATCH_MARKER in text else "not-applied",
        "terminal": str(terminal),
        "terminalSha256": sha256_bytes(data),
        "dependency": dependency,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Apply Octop Windows ConPTY compatibility patch"
    )
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument(
        "--force",
        action="store_true",
        help="allow an unrecognised terminal.py hash",
    )
    parser.add_argument(
        "--no-install",
        action="store_true",
        help="fail if pywinpty is absent",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    python = args.python.resolve()
    try:
        if args.check and not args.apply:
            result = check_patch(python)
        else:
            result = apply_patch(
                python,
                install_dependency=not args.no_install,
                offline=args.offline,
                force=args.force,
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except PatchError as exc:
        print(f"Octop Windows patch error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

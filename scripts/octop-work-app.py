"""Run the original Octop app with a local Work session handoff page.

The upstream runtime and all of its API/WebSocket routes remain in charge of
permissions and execution. This adapter only establishes a browser session
from the user's already authorised local LumaFlow page.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from fastapi import Request
from fastapi.responses import HTMLResponse

SECTIONS = {
    "/chat", "/experts", "/personalization/memory", "/skill-packages",
    "/admin/plugins", "/tasks", "/connectors", "/knowledge-bases",
    "/workbench/browser", "/workbench/terminal", "/remote-desktop", "/acp",
    "/personalization/channels", "/admin/models", "/admin/users",
    "/admin/advanced", "/admin/backend",
}


def launch_html(origins: list[str], agent_id: str = "") -> str:
    # These values are JSON escaped configuration, never templates supplied by a request.
    return """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>Work 能力中心</title><style>body{font:14px system-ui;background:#f7faf7;color:#294936;display:grid;place-items:center;height:90vh}p{max-width:32rem}</style>
<p id="state">正在建立本机 Work 会话…</p><script>
const allowed = new Set(ORIGINS), paths = new Set(PATHS), agent = AGENT;
let finished = false, busy = false;
const announce = () => { if (!finished && window.parent !== window) for (const origin of allowed) window.parent.postMessage({type:'lumaflow:ready'}, origin); };
window.addEventListener('message', async event => {
  if (finished || busy || event.source !== window.parent || !allowed.has(event.origin) || event.data?.type !== 'lumaflow:session') return;
  const token = event.data.token, path = event.data.path;
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_.-]+$/.test(token) || !paths.has(path)) return;
  busy = true;
  try {
    const response = await fetch('/api/auth/me', {headers:{Authorization:'Bearer '+token},cache:'no-store'});
    if (!response.ok) throw new Error('会话验证失败，请返回 Work 重试。');
    localStorage.removeItem('auth_token');
    sessionStorage.setItem('auth_token', token);
    if (agent && !localStorage.getItem('octop:active-agent')) localStorage.setItem('octop:active-agent', agent);
    finished = true; clearInterval(timer); window.location.replace(path);
  } catch (error) { document.getElementById('state').textContent = error.message || '本机会话未建立，请重试。'; }
  finally { busy = false; }
});
const timer = setInterval(announce, 750); announce();
</script></html>""".replace("ORIGINS", json.dumps(origins)).replace("PATHS", json.dumps(sorted(SECTIONS))).replace("AGENT", json.dumps(agent_id))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8088)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    home = (root / ".local-data" / "octop").resolve()
    os.environ["OCTOP_HOME"] = str(home)
    config_file = home / "lumaflow.json"
    config = json.loads(config_file.read_text("utf8")) if config_file.exists() else {}
    gateway = urlparse(config.get("gatewayBaseUrl", "http://127.0.0.1:3000/api/v1/work-engine/models"))
    if gateway.hostname not in {"127.0.0.1", "localhost", "::1"} or gateway.scheme != "http":
        raise RuntimeError("Work session handoff requires the local LumaFlow website")
    origins = [f"http://127.0.0.1:{gateway.port or 3000}", f"http://localhost:{gateway.port or 3000}"]
    agent_id = config.get("agentIds", {}).get("work", "")
    from octop.api import app as app_module
    original = app_module.build_app

    def build_app(server):
        app = original(server)

        async def handoff(request: Request):
            current = json.loads(config_file.read_text("utf8")) if config_file.exists() else config
            active_id = current.get("agentIds", {}).get("work", agent_id)
            return HTMLResponse(launch_html(origins, active_id), headers={
                "Cache-Control": "no-store", "Referrer-Policy": "same-origin",
                "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors " + " ".join(origins),
            })

        app.add_api_route("/lumaflow/launch", handoff, methods=["GET"], include_in_schema=False)
        # The upstream SPA catch-all has already been mounted. The precise handoff route must precede it.
        app.router.routes.insert(0, app.router.routes.pop())
        return app

    app_module.build_app = build_app
    from octop.launch import run_foreground_blocking
    run_foreground_blocking(host="127.0.0.1", port=args.port, reload=False, workers=1, log_level="warning", ssl_certfile=None, ssl_keyfile=None)


if __name__ == "__main__":
    main()

"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

const command = "$p=Join-Path $env:LOCALAPPDATA 'LumaFlow\\WorkConnector\\local-work-bridge.mjs'; New-Item -ItemType Directory -Path (Split-Path $p) -Force | Out-Null; Invoke-WebRequest -Uri 'https://lumaflow-sales-hub.vercel.app/downloads/local-work-bridge.mjs' -OutFile $p -UseBasicParsing; if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne '8925BD1205226859812376E10A6175706232ED8BF512613A7737D25148F4F38A') { throw '连接器校验失败，请停止操作' }; & node $p";

export function WorkStartCommand({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return <div>
    <button className={className} type="button" onClick={() => void copy()}>{copied ? <Check size={17} /> : <Copy size={17} />} {copied ? "已复制启动命令" : "复制启动命令"}</button>
    {copyFailed && <p role="alert">浏览器未允许自动复制。请展开下方命令，选中后手动复制。</p>}
    <details open={copyFailed}><summary>查看将要运行的命令</summary><code style={{ display: "block", overflowWrap: "anywhere", marginTop: 10, userSelect: "all", fontSize: 12 }}>{command}</code></details>
  </div>;
}

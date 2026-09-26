"use client";

import { useEffect, useState } from "react";
import styles from "./work-device-panel.module.css";

const bridgeUrl = "http://127.0.0.1:9877";
type PairState = { paired: boolean; code?: string; expiresAt?: number | null };

export function WeChatPairCard({ token }: { token: string }) {
  const [state, setState] = useState<PairState | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  async function request(method: "GET" | "POST"): Promise<PairState> {
    const response = await fetch(`${bridgeUrl}/wechat/pair`, {
      method,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      targetAddressSpace: "loopback",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12_000),
    } as RequestInit & { targetAddressSpace: "loopback" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "无法检查微信绑定状态");
    return data as PairState;
  }

  useEffect(() => {
    let active = true;
    void request("GET").then((value) => { if (active) setState(value); })
      .catch((error) => { if (active) setProblem(error instanceof Error ? error.message : "无法检查微信通道"); });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (!state?.code || state.paired) return;
    const timer = window.setInterval(() => {
      void request("GET").then((value) => {
        if (value.paired) { setState(value); setProblem(""); }
        else if (state.expiresAt && Date.now() >= state.expiresAt * 1000) {
          setState(value); setProblem("绑定码已过期，请重新生成。");
        }
      }).catch(() => { /* The next poll can recover from a brief local restart. */ });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [state?.code, state?.paired, state?.expiresAt, token]);

  async function start() {
    setBusy(true); setProblem("");
    try { setState(await request("POST")); }
    catch (error) { setProblem(error instanceof Error ? error.message : "生成绑定码失败"); }
    finally { setBusy(false); }
  }

  return <section className={styles.card} aria-label="微信绑定">
    <h3>可选：在微信使用这台电脑的 Agent</h3>
    <p>在本机 CowAgent 打开“通道”→“接入通道”→“微信”，用手机微信扫码并确认。接入后，在微信搜索“微信ClawBot”或“WeixinClawBot”找到机器人会话；它不是需要另外下载的插件。</p>
    <a className={styles.download} href="http://127.0.0.1:9876/" target="_blank" rel="noreferrer">打开本机 CowAgent</a>
    {state?.paired ? <p className={styles.notice}>已绑定微信主人。只有这个微信账号可以通过机器人让本机 Agent 操作文件。</p> : <>
      <p>找到机器人后，点击下面按钮，在微信会话中发送显示的绑定码。页面会自动确认绑定。</p>
      <button className={styles.primary} type="button" onClick={() => void start()} disabled={busy}>{busy ? "正在生成…" : "生成微信绑定码"}</button>
      {state?.code && <p className={styles.pairCode}>请发给微信机器人：<strong>{state.code}</strong><button type="button" onClick={() => void navigator.clipboard.writeText(state.code || "")}>复制</button></p>}
    </>}
    {problem && <p className={styles.error} role="alert">{problem}。请确认本机 CowAgent 已启动，并已扫码接入微信。</p>}
  </section>;
}

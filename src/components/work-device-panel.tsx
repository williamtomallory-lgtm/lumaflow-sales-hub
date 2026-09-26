"use client";

import { ArrowUp, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./work-device-panel.module.css";
import { WeChatPairCard } from "./wechat-pair-card";

const bridgeUrl = "http://127.0.0.1:9877";

type Session = { configured: boolean; authenticated: boolean; name?: string };
type Agent = { id: string; name: string; description?: string; enabled: boolean; type?: "local" | "wechat"; botType?: string };
type Agents = { agents: Agent[]; defaultAgentId: string };

async function localRequest(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${bridgeUrl}${path}`, {
    ...init,
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    targetAddressSpace: "loopback",
    signal: init.signal || AbortSignal.timeout(12_000),
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  } as RequestInit & { targetAddressSpace: "loopback" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `本机连接器返回 ${response.status}`);
  return data;
}

export function WorkDevicePanel() {
  const [session, setSession] = useState<Session | null>(null);
  const [localOnline, setLocalOnline] = useState(false);
  const [token, setToken] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkingLocal, setCheckingLocal] = useState(false);
  const controller = useRef<AbortController | null>(null);

  async function checkLocal() {
    setCheckingLocal(true);
    try { await localRequest("/health"); setLocalOnline(true); }
    catch { setLocalOnline(false); }
    finally { setCheckingLocal(false); }
  }

  const showAgents = useCallback((roster: Agents, nextToken: string) => {
    const enabled = Array.isArray(roster.agents) ? roster.agents.filter((agent) => agent.enabled && agent.type !== "wechat" && agent.botType !== "weixin_personal" && agent.botType !== "wecom_group") : [];
    setToken(nextToken); setAgents(enabled);
    setAgentId(enabled.find((agent) => agent.id === roster.defaultAgentId)?.id || enabled[0]?.id || "");
    setLocalOnline(true);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    async function resumeExisting(signal: AbortSignal) {
      try {
        const health = await localRequest("/health", { signal });
        if (!health.paired || signal.aborted) return;
        const issued = await fetch("/api/v1/work/ticket", { method: "POST", cache: "no-store", signal });
        const ticketPayload = await issued.json();
        if (!issued.ok || typeof ticketPayload.ticket !== "string") return;
        const resumed = await localRequest("/resume", { method: "POST", body: JSON.stringify({ ticket: ticketPayload.ticket }), signal });
        if (typeof resumed.token !== "string") return;
        const roster = await localRequest("/agents", { signal }, resumed.token) as Agents;
        if (!signal.aborted) showAgents(roster, resumed.token);
      } catch {
        // First-time pairing still uses the code displayed on the local computer.
      }
    }
    void fetch("/api/v1/work/session", { cache: "no-store", signal: abort.signal })
      .then((response) => response.json())
      .then((value: Session) => {
        if (abort.signal.aborted) return;
        setSession(value);
        if (value.authenticated) void resumeExisting(abort.signal);
      })
      .catch(() => { if (!abort.signal.aborted) setError("暂时无法检查登录状态，请刷新页面。"); });
    void localRequest("/health", { signal: abort.signal })
      .then(() => { if (!abort.signal.aborted) setLocalOnline(true); })
      .catch(() => { if (!abort.signal.aborted) setLocalOnline(false); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, [showAgents]);

  async function pair() {
    if (!session?.authenticated || !pairCode.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const issued = await fetch("/api/v1/work/ticket", { method: "POST", cache: "no-store" });
      const ticketPayload = await issued.json();
      if (!issued.ok || typeof ticketPayload.ticket !== "string") throw new Error(ticketPayload.error || "登录票据获取失败");
      const paired = await localRequest("/pair", { method: "POST", body: JSON.stringify({ code: pairCode.trim(), ticket: ticketPayload.ticket }) });
      if (typeof paired.token !== "string") throw new Error("本机连接器没有返回会话凭据");
      const roster = await localRequest("/agents", {}, paired.token) as Agents;
      showAgents(roster, paired.token);
      setPairCode("");
    } catch (issue) { setError(issue instanceof Error ? issue.message : "配对失败"); }
    finally { setBusy(false); }
  }

  async function send() {
    const message = input.trim();
    if (!token || !agentId || !message || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError(""); setAnswer(""); setQuestion(message);
    try {
      const started = await localRequest("/message", { method: "POST", signal: abort.signal, body: JSON.stringify({ agentId, message }) }, token);
      if (typeof started.requestId !== "string") throw new Error("本机 Agent 未返回任务编号");
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(new Error("任务已中断")); };
          const timer = setTimeout(() => { abort.signal.removeEventListener("abort", onAbort); resolve(); }, 1000);
          abort.signal.addEventListener("abort", onAbort, { once: true });
        });
        const result = await localRequest("/poll", { method: "POST", signal: abort.signal, body: JSON.stringify({ requestId: started.requestId }) }, token);
        if (result.hasContent) { setAnswer(String(result.content || "")); setInput(""); return; }
        if (result.status === "error" || result.status === "failed") throw new Error(typeof result.error === "string" ? result.error : "本机 Agent 处理失败");
      }
      throw new Error("本机 Agent 等待超过 5 分钟；任务可能仍在电脑上运行，请检查本机程序。");
    } catch (issue) { if (!abort.signal.aborted) setError(issue instanceof Error ? issue.message : "任务提交失败"); }
    finally { controller.current = null; setBusy(false); }
  }

  return <div className={styles.panel}>
    <header className={styles.intro}><span className={styles.mark}><ShieldCheck size={23} /></span><h2>连接你自己的电脑</h2><p>登录网站账号后，在这台电脑安装并启动本机 Agent，输入连接器显示的配对码。Work 的任务只发给这台电脑。</p></header>
    {!session && !error && <p className={styles.notice}>正在检查登录状态…</p>}
    {session && !session.configured && <p className={styles.notice}>网站登录服务尚未配置，Work 暂时不能配对电脑。</p>}
    {session?.configured && !session.authenticated && <div className={styles.card}><h3>第一步：登录网站</h3><p>登录后才能把本机 Agent 绑定到你的账号。</p><a className={styles.primary} href="/auth/login?returnTo=/?work=1">登录或注册</a></div>}
    {session?.authenticated && !token && <div className={styles.card}><h3>第二步：连接这台电脑</h3><p>已登录：{session.name || "当前账号"}。先打开 CowAgent，再按简短步骤启动连接器；窗口会显示配对码。</p><a className={styles.download} href="/work-setup">打开连接指引</a><p className={styles.status}>{localOnline ? "已检测到这台电脑的连接器。" : "尚未检测到连接器；启动后点击重新检测。"} <button type="button" disabled={checkingLocal} onClick={() => void checkLocal()}>{checkingLocal ? "检测中…" : "重新检测"}</button></p><label>本机配对码<input aria-label="本机配对码" value={pairCode} onChange={(event) => setPairCode(event.target.value)} maxLength={32} autoComplete="one-time-code" placeholder="输入启动窗口显示的配对码" /></label><button className={styles.primary} type="button" disabled={busy || !pairCode.trim()} onClick={() => void pair()}>{busy ? "正在配对…" : "连接我的电脑"}</button></div>}
    {session?.authenticated && token && <div className={styles.card}><div className={styles.connected}><strong>已连接本机 Agent</strong><button type="button" onClick={() => { setToken(""); setAgents([]); setAnswer(""); setQuestion(""); }}>断开本次连接</button></div>{agents.length ? <><label>选择本机 Agent<select aria-label="选择本机 Agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} disabled={busy}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><textarea aria-label="描述本机任务" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} disabled={busy} maxLength={4000} placeholder="描述要让这台电脑完成的任务…" /><button className={styles.primary} type="button" disabled={busy || !input.trim()} onClick={() => void send()}><ArrowUp size={16} /> {busy ? "本机 Agent 正在处理…" : "发送给本机 Agent"}</button></> : <p className={styles.notice}>这台电脑的 CowAgent 没有可用 Agent，请在本机创建或启用后重新配对。</p>}</div>}
    {session?.authenticated && token && <WeChatPairCard token={token} />}
    {question && <section className={styles.result} aria-label="本机任务结果"><strong>你：{question}</strong>{answer ? <p>{answer}</p> : busy ? <p><RefreshCw size={15} /> 正在等待本机 Agent 的回复…</p> : null}</section>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <p className={styles.hint}>浏览器可能请求“访问本地网络”权限；只允许你信任的 LumaFlow 网站。任务由你电脑上的 CowAgent 执行，请先确认其权限范围。</p>
  </div>;
}

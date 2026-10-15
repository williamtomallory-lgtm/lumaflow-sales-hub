"use client";

import { CircleAlert, LoaderCircle, RefreshCw, Settings2, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./work-capability-center.module.css";

export const WORK_ENGINE_ENDPOINT = "/api/v1/work-engine";
export const WORK_ENGINE_SESSION_ENDPOINT = "/api/v1/work-engine/session";
export const WORK_ENGINE_ROUTE_ENDPOINT = "/api/v1/work-engine/route-request";
const DEFAULT_SECTION_ID = "experts";
const ROUTING_CONFIDENCE_THRESHOLD = 0.75;

export type WorkCapabilitySection = {
  id: string;
  label: string;
  path: string;
  availability?: string;
  detail?: string;
};

export type WorkEngineInfo = {
  connected: boolean;
  version?: string;
  baseUrl: string;
  agentIds?: Record<string, string>;
  sections: WorkCapabilitySection[];
  models?: Array<{ id: string; label: string }>;
};

type EngineState =
  | { status: "loading" }
  | { status: "ready"; data: WorkEngineInfo }
  | { status: "error"; message: string };

type RouteRecommendation = { sectionId?: string; confidence: number; source: "local-rules" | "typesafe-choice" };
type RouteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "result"; recommendation: RouteRecommendation }
  | { status: "error"; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseSections(value: unknown): WorkCapabilitySection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): WorkCapabilitySection[] => {
    const record = asRecord(entry);
    const id = nonEmptyString(record?.id);
    const label = nonEmptyString(record?.label);
    const path = nonEmptyString(record?.path);
    if (!id || !label || !path) return [];
    return [{
      id,
      label,
      path,
      availability: nonEmptyString(record?.availability),
      detail: nonEmptyString(record?.detail),
    }];
  });
}

function parseEngineInfo(payload: unknown): WorkEngineInfo | null {
  const outer = asRecord(payload);
  const data = asRecord(outer?.data);
  if (!data) return null;
  const baseUrl = nonEmptyString(data.baseUrl);
  if (typeof data.connected !== "boolean" || !baseUrl) return null;

  const models = Array.isArray(data.models)
    ? data.models.flatMap((entry): Array<{ id: string; label: string }> => {
        const record = asRecord(entry);
        const id = nonEmptyString(record?.id);
        const label = nonEmptyString(record?.label);
        return id && label ? [{ id, label }] : [];
      })
    : undefined;

  const agentIds = asRecord(data.agentIds);
  return {
    connected: data.connected,
    version: nonEmptyString(data.version),
    baseUrl,
    agentIds: agentIds
      ? Object.fromEntries(
          Object.entries(agentIds).flatMap(([key, value]) => {
            const id = nonEmptyString(value);
            return id ? [[key, id]] : [];
          }),
        )
      : undefined,
    sections: parseSections(data.sections),
    models,
  };
}

function parseRouteRecommendation(payload: unknown): RouteRecommendation | null {
  const data = asRecord(asRecord(payload)?.data);
  if (!data || typeof data.confidence !== "number" || !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1) return null;
  const source = data.source === "local-rules" || data.source === "typesafe-choice" ? data.source : null;
  if (!source) return null;
  return { sectionId: nonEmptyString(data.sectionId), confidence: data.confidence, source };
}

/** Only loopback origins are accepted for the embedded local engine. */
export function loopbackOrigin(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The Work capability center must never send a public browser to its own localhost. */
export function isLocalBrowserHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/[\[\]]/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function buildWorkCapabilityLaunchUrl(baseUrl: unknown, path: string): string | null {
  const origin = loopbackOrigin(baseUrl);
  const sectionPath = path.trim();
  if (!origin || !sectionPath) return null;
  const launch = new URL("/lumaflow/launch", origin);
  launch.searchParams.set("section", sectionPath);
  return launch.toString();
}

function sectionIsAvailable(section: WorkCapabilitySection): boolean {
  const availability = section.availability?.toLowerCase();
  return !availability || ["available", "online", "ready"].includes(availability);
}

function firstAvailableSection(sections: WorkCapabilitySection[]): WorkCapabilitySection | undefined {
  return sections.find(sectionIsAvailable);
}

function isReadyMessage(value: unknown): boolean {
  const record = asRecord(value);
  return record?.type === "lumaflow:ready";
}

export function WorkCapabilityCenter() {
  const [open, setOpen] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [engine, setEngine] = useState<EngineState>({ status: "loading" });
  const [selectedSectionId, setSelectedSectionId] = useState(DEFAULT_SECTION_ID);
  const [routeText, setRouteText] = useState("");
  const [routeState, setRouteState] = useState<RouteState>({ status: "idle" });
  const [sessionState, setSessionState] = useState<{ key: string; ready: boolean; error: string }>({ key: "", ready: false, error: "" });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sessionRequestRef = useRef<{ key: string; active: boolean }>({ key: "", active: false });

  useEffect(() => {
    const controller = new AbortController();
    void fetch(WORK_ENGINE_ENDPOINT, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`能力中心状态检查失败（${response.status}）`);
        return parseEngineInfo(await response.json());
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data) {
          setEngine({ status: "error", message: "能力中心返回了无法识别的状态。" });
          return;
        }
        setEngine({ status: "ready", data });
        setSelectedSectionId((current) => {
          const currentSection = data.sections.find((section) => section.id === current);
          return currentSection && sectionIsAvailable(currentSection)
            ? current
            : firstAvailableSection(data.sections)?.id ?? DEFAULT_SECTION_ID;
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setEngine({ status: "error", message: error instanceof Error ? error.message : "暂时无法检查能力中心。" });
        }
      });
    return () => controller.abort();
  }, [retryKey]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const selectedSection = useMemo(() => {
    if (engine.status !== "ready") return undefined;
    const selected = engine.data.sections.find((section) => section.id === selectedSectionId);
    return selected && sectionIsAvailable(selected) ? selected : firstAvailableSection(engine.data.sections);
  }, [engine, selectedSectionId]);
  const engineOrigin = engine.status === "ready" ? loopbackOrigin(engine.data.baseUrl) : null;
  const localBrowser = typeof window !== "undefined" && isLocalBrowserHost(window.location.hostname);
  const frameUrl = selectedSection && engineOrigin
    ? buildWorkCapabilityLaunchUrl(engineOrigin, selectedSection.path)
    : null;
  const sessionKey = `${open ? "open" : "closed"}:${frameUrl ?? "none"}`;
  const iframeReady = sessionState.key === sessionKey && sessionState.ready;
  const sessionError = sessionState.key === sessionKey ? sessionState.error : "";
  const routeRecommendation = routeState.status === "result" ? routeState.recommendation : undefined;
  const routeSection = routeRecommendation?.sectionId && engine.status === "ready"
    ? engine.data.sections.find((section) => section.id === routeRecommendation.sectionId)
    : undefined;
  const routeIsCertain = Boolean(routeSection && sectionIsAvailable(routeSection) && routeRecommendation && routeRecommendation.confidence >= ROUTING_CONFIDENCE_THRESHOLD);

  useEffect(() => {
    if (!open || !frameUrl || !engineOrigin || !selectedSection || !localBrowser) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const onMessage = async (event: MessageEvent<unknown>) => {
      if (event.origin !== engineOrigin || event.source !== iframe.contentWindow || !isReadyMessage(event.data)) return;
      const activeSessionKey = sessionKey;
      if (sessionRequestRef.current.active && sessionRequestRef.current.key === activeSessionKey) return;
      sessionRequestRef.current = { key: activeSessionKey, active: true };
      setSessionState({ key: activeSessionKey, ready: false, error: "" });
      try {
        const response = await fetch(WORK_ENGINE_SESSION_ENDPOINT, {
          method: "POST",
          cache: "no-store",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ path: selectedSection.path }),
        });
        const payload = await response.json().catch(() => null);
        const data = asRecord(asRecord(payload)?.data);
        const token = nonEmptyString(data?.token);
        if (!response.ok || !token) throw new Error("能力中心会话未建立，请重试。" );
        if (iframeRef.current !== iframe || event.origin !== engineOrigin || event.source !== iframe.contentWindow || sessionRequestRef.current.key !== activeSessionKey) return;
        iframe.contentWindow?.postMessage({ type: "lumaflow:session", token, path: selectedSection.path }, engineOrigin);
        setSessionState({ key: activeSessionKey, ready: true, error: "" });
      } catch (error: unknown) {
        if (sessionRequestRef.current.key === activeSessionKey) {
          setSessionState({ key: activeSessionKey, ready: false, error: error instanceof Error ? error.message : "能力中心会话未建立，请重试。" });
        }
      } finally {
        if (sessionRequestRef.current.key === activeSessionKey) sessionRequestRef.current.active = false;
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [engineOrigin, frameUrl, localBrowser, open, selectedSection, sessionKey]);

  const retry = () => {
    setEngine({ status: "loading" });
    setRouteState({ status: "idle" });
    setSessionState({ key: "", ready: false, error: "" });
    sessionRequestRef.current = { key: "", active: false };
    setRetryKey((key) => key + 1);
  };

  const routeRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = routeText.trim();
    if (!text) return;
    setRouteState({ status: "loading" });
    try {
      const response = await fetch(WORK_ENGINE_ROUTE_ENDPOINT, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const recommendation = parseRouteRecommendation(await response.json().catch(() => null));
      if (!response.ok || !recommendation) throw new Error("暂时无法判断适合的功能入口，请从左侧选择。");
      setRouteState({ status: "result", recommendation });
    } catch (error: unknown) {
      setRouteState({ status: "error", message: error instanceof Error ? error.message : "暂时无法判断适合的功能入口，请从左侧选择。" });
    }
  };

  const connected = engine.status === "ready" && engine.data.connected;
  const canEmbed = connected && Boolean(engineOrigin) && localBrowser;

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-label="能力中心"
        title="打开 Work 能力中心"
        onClick={() => setOpen(true)}
      >
        <Settings2 size={15} aria-hidden="true" />
        <span>能力中心</span>
      </button>

      {open && createPortal(
        <section className={styles.overlay} role="dialog" aria-modal="true" aria-label="Work 能力中心">
          <div className={styles.panel}>
            <header className={styles.panelHeader}>
              <div>
                <strong>Work 能力中心</strong>
                <span>本机 Octop 引擎与 Agent 能力</span>
              </div>
              <div className={styles.headerActions}>
                <button type="button" className={styles.refreshButton} onClick={retry} disabled={engine.status === "loading"}>
                  <RefreshCw size={14} aria-hidden="true" />
                  <span>重新检测</span>
                </button>
                <button type="button" className={styles.closeButton} aria-label="关闭能力中心" onClick={() => setOpen(false)}>
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
            </header>

            <section className={styles.routingPanel} aria-label="功能入口推荐">
              <form className={styles.routingForm} onSubmit={(event) => void routeRequest(event)}>
                <label className={styles.routingLabel} htmlFor="work-capability-intent">你想做什么？</label>
                <div className={styles.routingInputRow}>
                  <input
                    id="work-capability-intent"
                    className={styles.routingInput}
                    value={routeText}
                    maxLength={2000}
                    placeholder="例如：创建一个研究专家团队，或整理一批本地文件"
                    onChange={(event) => setRouteText(event.target.value)}
                  />
                  <button type="submit" className={styles.routingSubmit} disabled={!routeText.trim() || routeState.status === "loading"}>
                    {routeState.status === "loading" ? "查找中…" : "推荐入口"}
                  </button>
                </div>
              </form>
              {routeState.status === "error" && <p className={styles.routingMessage} role="alert">{routeState.message}</p>}
              {routeState.status === "result" && routeIsCertain && routeSection && (
                <div className={styles.routingRecommendation} role="status" data-testid="work-engine-route-recommendation">
                  <span>可以先进入“{routeSection.label}”。</span>
                  <button type="button" onClick={() => setSelectedSectionId(routeSection.id)}>进入{routeSection.label}</button>
                </div>
              )}
              {routeState.status === "result" && !routeIsCertain && (
                <p className={styles.routingMessage} role="status" data-testid="work-engine-route-uncertain">暂时不能确定最合适的入口，请从左侧选择功能。</p>
              )}
            </section>

            <div className={styles.layout}>
              <aside className={styles.navigation} aria-label="能力中心导航">
                <div className={styles.navigationHeading}>本机能力</div>
                {engine.status === "ready" && engine.data.sections.length > 0
                  ? engine.data.sections.map((section) => {
                      const available = sectionIsAvailable(section);
                      return (
                        <button
                          key={section.id}
                          type="button"
                          className={selectedSection?.id === section.id ? styles.navigationItemActive : styles.navigationItem}
                          aria-current={selectedSection?.id === section.id ? "page" : undefined}
                          disabled={!available || !canEmbed}
                          onClick={() => setSelectedSectionId(section.id)}
                          title={section.detail || section.label}
                        >
                          <span>{section.label}</span>
                          {section.detail && <small>{section.detail}</small>}
                        </button>
                      );
                    })
                  : <span className={styles.navigationEmpty}>等待本机引擎返回能力列表…</span>}
              </aside>

              <main className={styles.content}>
                {engine.status === "loading" && (
                  <div className={styles.state} role="status" data-testid="work-engine-loading">
                    <LoaderCircle className={styles.spinner} size={22} aria-hidden="true" />
                    <strong>正在检查本机能力中心…</strong>
                    <p>只连接当前远程电脑上的本机引擎。</p>
                  </div>
                )}

                {engine.status === "error" && (
                  <div className={styles.state} role="alert" data-testid="work-engine-error">
                    <CircleAlert size={22} aria-hidden="true" />
                    <strong>暂时无法读取能力中心</strong>
                    <p>{engine.message}</p>
                    <button type="button" className={styles.primaryButton} onClick={retry}>重新检测</button>
                  </div>
                )}

                {engine.status === "ready" && !connected && (
                  <div className={styles.state} role="status" data-testid="work-engine-disconnected">
                    <CircleAlert size={22} aria-hidden="true" />
                    <strong>本机 Octop 引擎未连接</strong>
                    <p>{engine.data.version ? `检测到版本 ${engine.data.version}，但服务当前未报告已连接。` : "服务当前未报告已连接，启动本机引擎后重新检测。"}</p>
                    <button type="button" className={styles.primaryButton} onClick={retry}>重新检测</button>
                  </div>
                )}

                {engine.status === "ready" && connected && !localBrowser && (
                  <div className={styles.state} role="alert" data-testid="work-engine-public-host">
                    <CircleAlert size={22} aria-hidden="true" />
                    <strong>能力中心仅在远程电脑本机页面打开</strong>
                    <p>当前页面不是 loopback 地址，已阻止把访问者浏览器连接到它自己的 127.0.0.1。</p>
                  </div>
                )}

                {engine.status === "ready" && connected && localBrowser && !engineOrigin && (
                  <div className={styles.state} role="alert" data-testid="work-engine-invalid-origin">
                    <CircleAlert size={22} aria-hidden="true" />
                    <strong>本机引擎地址无效</strong>
                    <p>服务没有提供受信任的 loopback 地址，已阻止嵌入。</p>
                  </div>
                )}

                {engine.status === "ready" && connected && canEmbed && !frameUrl && (
                  <div className={styles.state} role="alert" data-testid="work-engine-no-section">
                    <CircleAlert size={22} aria-hidden="true" />
                    <strong>暂无可用能力入口</strong>
                    <p>本机引擎已连接，但没有返回可打开的控制台 section。</p>
                  </div>
                )}

                {frameUrl && canEmbed && (
                  <div className={styles.frameShell} data-testid="work-engine-frame-shell">
                    <iframe
                      key={frameUrl}
                      ref={iframeRef}
                      className={styles.frame}
                      src={frameUrl}
                      title={`${selectedSection?.label || "能力中心"} · LumaFlow Work 能力中心`}
                      referrerPolicy="no-referrer"
                    />
                    <div className={styles.frameStatus} role="status" data-testid="work-engine-session-status">
                      {sessionError ? sessionError : iframeReady ? "本机能力中心已连接" : "正在建立本机能力中心会话…"}
                    </div>
                  </div>
                )}
              </main>
            </div>
          </div>
        </section>, document.body
      )}
    </>
  );
}

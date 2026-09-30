"use client";

/* eslint-disable @next/next/no-img-element -- The local image endpoint returns
 * authenticated, loopback-only PNG assets which should be shown immediately. */
import { ArrowUp, Download, ImagePlus, LoaderCircle, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { FileUIPart } from "ai";
import { saveLocalChat, loadLocalChat } from "@/lib/client/chat-history";
import type { LocalChatSession } from "@/lib/contracts/chat-history";
import { resolveImageOperationIntent, type ImageOperation } from "@/lib/client/image-operation-intent";
import { ImageStyleGallery } from "./image-style-gallery";
import styles from "./wechat-local-image-panel.module.css";

const imageOperationEndpoint = "/api/v1/assistant/image-operations";
const imageCancelEndpoint = "/api/v1/assistant/image-operations/cancel";
const sessionMapPrefix = "lumaflow.wechat-image-session.v1:";
const acceptedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"] as const);
const maxImageCount = 4;
const maxImageBytes = 2_400_000;
const maxEncodedImageBytes = 3_600_000;
const assetUrlPattern = /^\/api\/v1\/assistant\/image-operations\/assets\/[0-9a-f]{32}\.png$/i;

type WechatLocalImage = {
  type: "file";
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  filename: string;
  url: string;
  size: number;
};

type ApiImage = Pick<WechatLocalImage, "type" | "mediaType" | "filename" | "url">;

type ImageOutput = {
  url: string;
  filename: string;
  width: number;
  height: number;
};

type ImageOperationPayload = {
  text: string;
  model: string;
  operation: ImageOperation;
  images: ImageOutput[];
};

const imageOutputSchema = z.object({
  url: z.string().trim().regex(assetUrlPattern),
  filename: z.string().trim().min(1).max(160),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

const imagePayloadSchema = z.object({
  data: z.object({
    text: z.string(),
    model: z.string().min(1),
    operation: z.enum(["generate", "edit", "analyze"]),
    images: z.array(imageOutputSchema),
  }).strict(),
}).strict();

export type WechatLocalImagePanelProps = {
  /** The remote Wechat conversation id. It is mapped to a local UUID for history. */
  conversationId: string;
  prompt: string;
  onPromptChange: (value: string) => void;
  /** Close image mode in the host composer. A running local job is cancelled first. */
  onExit: () => void;
  onToast?: (message: string) => void;
  disabled?: boolean;
  /** Existing data-url image parts from the Wechat composer. */
  initialImages?: readonly FileUIPart[];
  /** A rising edge submits exactly once; prompt rerenders do not resubmit. */
  autoSubmit?: boolean;
};

function storageKey(conversationId: string) {
  return `${sessionMapPrefix}${encodeURIComponent(conversationId)}`;
}

function isUuid(value: string | null): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function localUuid() {
  return crypto.randomUUID();
}

function readOrCreateSessionId(conversationId: string) {
  if (typeof window === "undefined" || !conversationId.trim()) return localUuid();
  try {
    const saved = window.localStorage.getItem(storageKey(conversationId));
    if (isUuid(saved)) return saved;
    const id = localUuid();
    window.localStorage.setItem(storageKey(conversationId), id);
    return id;
  } catch {
    return localUuid();
  }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlSize(url: string) {
  const comma = url.indexOf(",");
  if (comma < 0) return 0;
  const payload = url.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 0.75) - padding);
}

function normalizeInitialImage(image: FileUIPart): WechatLocalImage | null {
  if (image.type !== "file" || !acceptedImageTypes.has(image.mediaType as WechatLocalImage["mediaType"])) return null;
  const mediaType = image.mediaType as WechatLocalImage["mediaType"];
  if (!image.url.startsWith(`data:${mediaType};base64,`)) return null;
  const size = dataUrlSize(image.url);
  if (size > maxImageBytes || image.url.length > maxEncodedImageBytes) return null;
  return { type: "file", mediaType, filename: (image.filename || "图片").slice(0, 160), url: image.url, size };
}

function normalizeInitialImages(images: readonly FileUIPart[] | undefined) {
  if (!images?.length) return [];
  let encodedTotal = 0;
  return images.flatMap((image) => {
    if (encodedTotal + image.url.length > maxEncodedImageBytes) return [];
    const normalized = normalizeInitialImage(image);
    if (!normalized) return [];
    encodedTotal += normalized.url.length;
    return [normalized];
  }).slice(0, maxImageCount);
}

function toApiImage(image: WechatLocalImage): ApiImage {
  // The server schema is strict. `size` is local UI metadata and must never
  // cross the image-operation API boundary.
  return { type: image.type, mediaType: image.mediaType, filename: image.filename, url: image.url };
}

function imageTextFallback(operation: ImageOperation) {
  return operation === "analyze" ? "请查看我附加的图片。" : operation === "edit" ? "请编辑我附加的图片。" : "请生成一张图片。";
}

function operationLabel(operation: ImageOperation) {
  return operation === "analyze" ? "分析图片" : operation === "edit" ? "编辑图片" : "生成图片";
}

function extractSavedImages(session: LocalChatSession): ImageOutput[] {
  const images: ImageOutput[] = [];
  const seen = new Set<string>();
  for (const turn of session.turns) {
    const matches = [...turn.assistant.matchAll(/(?:\[[^\]]*\]\()?((?:\/api\/v1\/assistant\/image-operations\/assets\/)[0-9a-f]{32}\.png)/gi)];
    for (const match of matches) {
      const url = match[1];
      if (!assetUrlPattern.test(url) || seen.has(url)) continue;
      seen.add(url);
      const line = turn.assistant.slice(Math.max(0, (match.index ?? 0) - 180), match.index ?? 0).split(/\r?\n/).at(-1) ?? "";
      const name = line.replace(/^\s*[-*•]\s*/, "").replace(/\s*[:：]\s*$/, "").trim();
      images.push({ url, filename: name || "生成图片", width: 512, height: 512 });
    }
  }
  return images.slice(-24);
}

function imageAnswerText(text: string, images: ImageOutput[]) {
  const links = images.map((image) => `- ${image.filename || "生成图片"}: ${image.url}`).join("\n");
  return [text.trim(), links ? `图片文件：\n${links}` : ""].filter(Boolean).join("\n\n") || "图片操作已完成。";
}

function createSession(sessionId: string, title: string, now: string): LocalChatSession {
  return { id: sessionId, experience: "chat", title: title.slice(0, 120) || "微信图片", createdAt: now, updatedAt: now, turns: [] };
}

async function readImagePayload(response: Response): Promise<ImageOperationPayload> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && payload.error && typeof payload.error === "object" && "message" in payload.error && typeof payload.error.message === "string"
      ? payload.error.message
      : `图片模型请求失败（HTTP ${response.status}）。`;
    throw new Error(message);
  }
  return imagePayloadSchema.parse(payload).data;
}

export function WechatLocalImagePanel({ conversationId, prompt, onPromptChange, onExit, onToast, disabled = false, initialImages, autoSubmit = false }: WechatLocalImagePanelProps) {
  const [images, setImages] = useState<WechatLocalImage[]>(() => normalizeInitialImages(initialImages));
  const [results, setResults] = useState<ImageOutput[]>([]);
  const [resultText, setResultText] = useState("");
  const [resultModel, setResultModel] = useState("");
  const [resultConversationId, setResultConversationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const sessionRef = useRef<LocalChatSession | null>(null);
  const resultConversationIdRef = useRef("");
  const autoSubmitSeenRef = useRef(false);
  const toastRef = useRef(onToast);

  useEffect(() => {
    toastRef.current = onToast;
  }, [onToast]);

  const intent = useMemo(() => resolveImageOperationIntent({ prompt, images, enabled: true }), [prompt, images]);
  const operation = intent?.operation ?? (images.length ? "analyze" : "generate");

  useEffect(() => {
    const id = readOrCreateSessionId(conversationId);
    sessionIdRef.current = id;
    sessionRef.current = null;
    if (!id) return;
    const controller = new AbortController();
    void loadLocalChat(id).then((session) => {
      if (controller.signal.aborted) return;
      if (session) {
        sessionRef.current = session;
        resultConversationIdRef.current = conversationId;
        setResultConversationId(conversationId);
        setResults(extractSavedImages(session));
      }
    }).catch(() => {
      // A missing local history record is expected before the first image.
    });
    return () => controller.abort();
  }, [conversationId]);

  const cancel = useCallback(() => {
    const jobId = jobIdRef.current;
    if (jobId) {
      void fetch(imageCancelEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jobId }),
      }).catch(() => undefined);
    }
    abortRef.current?.abort();
  }, []);

  useEffect(() => () => {
    if (busyRef.current) cancel();
  }, [cancel]);

  async function addFiles(fileList: FileList | null) {
    if (!fileList || busy || disabled) return;
    const additions: WechatLocalImage[] = [];
    let encodedTotal = images.reduce((sum, image) => sum + image.url.length, 0);
    for (const file of Array.from(fileList)) {
      if (images.length + additions.length >= maxImageCount) {
        toastRef.current?.(`最多上传 ${maxImageCount} 张图片。`);
        break;
      }
      if (!acceptedImageTypes.has(file.type as WechatLocalImage["mediaType"])) {
        toastRef.current?.(`${file.name} 不是支持的 PNG、JPEG 或 WebP 图片。`);
        continue;
      }
      if (file.size > maxImageBytes) {
        toastRef.current?.(`${file.name} 超过 2.4 MB，无法上传。`);
        continue;
      }
      try {
        const url = await readFileAsDataUrl(file);
        if (encodedTotal + url.length > maxEncodedImageBytes) {
          toastRef.current?.("图片总大小超过本机接口限制，请减少图片数量或压缩后再试。");
          break;
        }
        encodedTotal += url.length;
        additions.push({ type: "file", mediaType: file.type as WechatLocalImage["mediaType"], filename: file.name.slice(0, 160), url, size: file.size });
      } catch (issue) {
        toastRef.current?.(issue instanceof Error ? issue.message : "图片读取失败。");
      }
    }
    if (additions.length) setImages((current) => [...current, ...additions].slice(0, maxImageCount));
  }

  async function persistResult(userText: string, data: ImageOperationPayload) {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    const now = new Date().toISOString();
    const current = sessionRef.current ?? createSession(sessionId, `微信图片·${userText}`, now);
    const answer = imageAnswerText(data.text, data.images);
    const next: LocalChatSession = {
      ...current,
      title: current.turns.length ? current.title : `微信图片·${userText}`.slice(0, 120),
      updatedAt: now,
      turns: [...current.turns, {
        id: localUuid(), user: userText, assistant: answer, createdAt: now,
        attachments: images.map((image) => image.filename || "图片"),
      }].slice(-100),
    };
    sessionRef.current = next;
    try {
      await saveLocalChat(next);
      window.dispatchEvent(new Event("lumaflow-chat-history-updated"));
    } catch {
      toastRef.current?.("图片已生成，但保存到本机对话记录失败。");
    }
  }

  async function submit(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy || disabled) return;
    const selectedIntent = intent ?? { operation: "generate" as const, explicit: false };
    const userText = prompt.trim() || imageTextFallback(selectedIntent.operation);
    const jobId = localUuid();
    const controller = new AbortController();
    abortRef.current = controller;
    jobIdRef.current = jobId;
    busyRef.current = true;
    setBusy(true);
    setError("");
    resultConversationIdRef.current = conversationId;
    setResultConversationId(conversationId);
    setResultText("");
    try {
      const response = await fetch(imageOperationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ jobId, prompt: userText, operation: selectedIntent.operation, images: images.map(toApiImage) }),
      });
      const data = await readImagePayload(response);
      setResultText(data.text);
      setResultModel(data.model);
      setResults((current) => {
        const base = resultConversationIdRef.current === conversationId ? current : [];
        return [...base, ...data.images].filter((image, index, all) => all.findIndex((candidate) => candidate.url === image.url) === index).slice(-24);
      });
      await persistResult(userText, data);
    } catch (issue) {
      const aborted = issue instanceof DOMException && issue.name === "AbortError";
      setError(aborted ? "图片处理已停止。" : issue instanceof z.ZodError ? "图片模型返回的数据不完整。" : issue instanceof Error ? issue.message : "图片模型请求失败，请检查本机图片服务。");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (jobIdRef.current === jobId) jobIdRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!autoSubmit) {
      autoSubmitSeenRef.current = false;
      return;
    }
    if (autoSubmitSeenRef.current || disabled || busy) return;
    autoSubmitSeenRef.current = true;
    void submit();
    // `autoSubmit` is a one-shot host event. Prompt rerenders intentionally do
    // not belong in this dependency list, otherwise one send could duplicate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmit, disabled, busy]);

  function exit() {
    if (busyRef.current) cancel();
    onExit();
  }

  const visibleResultState = resultConversationId === conversationId;
  const visibleResults = visibleResultState ? results : [];
  const visibleResultText = visibleResultState ? resultText : "";
  const visibleResultModel = visibleResultState ? resultModel : "";

  return <section className={styles.root} aria-label="Wechat Agent 本机图片操作" data-testid="wechat-local-image-panel">
    <header className={styles.header}>
      <div className={styles.modeNotice} role="status"><ImagePlus size={14} aria-hidden="true" /><span>生图功能启动</span><button type="button" aria-label="退出生图模式" title={busy ? "取消图片处理并退出" : "退出生图模式"} onClick={exit}><X size={14} aria-hidden="true" /></button></div>
      <div className={styles.model} aria-label="图片模型 Qwen Image 2.1"><ImagePlus size={15} aria-hidden="true" /><span>Qwen Image 2.1</span></div>
    </header>
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      {images.length > 0 && <div className={styles.attachments} aria-label="已上传图片">
        {images.map((image, index) => <div className={styles.attachment} key={`${image.filename}-${index}`}><img src={image.url} alt={image.filename} /><span title={image.filename}>{image.filename}</span><button type="button" aria-label={`移除 ${image.filename}`} onClick={() => setImages((current) => current.filter((_, imageIndex) => imageIndex !== index))} disabled={busy}><X size={13} /></button></div>)}
      </div>}
      <textarea aria-label="图片操作提示词" value={prompt} maxLength={4000} disabled={disabled || busy} placeholder="描述要生成或编辑的图片…" onChange={(event) => onPromptChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
      <footer className={styles.footer}>
        <div className={styles.footerLeft}><input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label="上传照片文件" onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ""; }} /><button type="button" className={styles.upload} aria-label="上传照片" title="上传照片" disabled={disabled || busy || images.length >= maxImageCount} onClick={() => fileInputRef.current?.click()}><Paperclip size={17} /><span>上传照片</span></button><span className={styles.operation}>{operationLabel(operation)}</span></div>
        {busy ? <button type="button" className={styles.stop} aria-label="停止图片处理" onClick={cancel}><X size={16} /> 停止</button> : <button type="submit" className={styles.submit} aria-label={operationLabel(operation)} disabled={disabled || (!prompt.trim() && images.length === 0)}><ArrowUp size={17} /> {operationLabel(operation)}</button>}
      </footer>
    </form>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {(visibleResultText || visibleResults.length > 0) && <section className={styles.result} aria-label="图片操作结果">
      <header><div><ImagePlus size={14} /><strong>{operation === "analyze" ? "图片识别结果" : operation === "edit" ? "图片编辑结果" : "生图结果"}</strong>{visibleResultModel && <small>{visibleResultModel}</small>}</div><span>已保存到本机</span></header>
      {visibleResultText && <p className={styles.resultText}>{visibleResultText}</p>}
      {visibleResults.length > 0 && <div className={styles.resultGrid}>{visibleResults.map((image, index) => <figure key={`${image.url}-${index}`}><a href={image.url} target="_blank" rel="noreferrer" download={image.filename || "image.png"}><img src={image.url} alt={image.filename || `图片结果 ${index + 1}`} width={image.width} height={image.height} loading="lazy" /></a><figcaption><span>{image.filename || `图片结果 ${index + 1}`}</span><a href={image.url} target="_blank" rel="noreferrer" download={image.filename || "image.png"}><Download size={12} /> 下载</a></figcaption></figure>)}</div>}
    </section>}
    <div className={styles.gallery}><ImageStyleGallery onUpload={() => fileInputRef.current?.click()} onSelect={onPromptChange} disabled={disabled || busy} /></div>
    {busy && <p className={styles.progress} role="status"><LoaderCircle size={14} className={styles.spin} /> 本机 Qwen-Image-2.1 正在处理，返回后会出现在下方并写入图片记录。</p>}
  </section>;
}

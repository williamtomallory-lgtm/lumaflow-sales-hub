import type { LocalChatMetadataPatch, LocalChatSession, LocalChatSummary } from "@/lib/contracts/chat-history";

const route = "/api/v1/assistant/history";

async function readJson(response: Response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `对话记录接口返回 ${response.status}`);
  return payload?.data;
}

export async function listLocalChats(query = ""): Promise<LocalChatSummary[]> {
  const data = await readJson(await fetch(query ? `${route}?q=${encodeURIComponent(query)}` : route, { cache: "no-store" }));
  return Array.isArray(data) ? data : [];
}

export async function loadLocalChat(id: string): Promise<LocalChatSession | null> {
  const data = await readJson(await fetch(`${route}?id=${encodeURIComponent(id)}`, { cache: "no-store" }));
  return data && typeof data === "object" && Array.isArray(data.turns) ? data as LocalChatSession : null;
}

export async function saveLocalChat(session: LocalChatSession): Promise<void> {
  await readJson(await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(session) }));
}

export async function removeLocalChat(id: string): Promise<void> {
  await readJson(await fetch(`${route}?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export async function updateLocalChatMetadata(id: string, patch: LocalChatMetadataPatch): Promise<LocalChatSession> {
  const data = await readJson(await fetch(`${route}?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
  if (!data || typeof data !== "object" || !Array.isArray(data.turns)) throw new Error("对话记录更新接口返回数据不完整");
  return data as LocalChatSession;
}

export async function copyLocalChatText(id: string): Promise<string> {
  const session = await loadLocalChat(id);
  if (!session) throw new Error("对话记录不存在。");
  const text = session.turns.map((turn) => `用户：${turn.user}\n助手：${turn.assistant}`).join("\n\n");
  if (!text.trim()) throw new Error("这条对话还没有可分享的内容。");
  if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不支持复制对话。");
  await navigator.clipboard.writeText(text);
  return text;
}

import "server-only";
import { z, ZodError } from "zod";
import { ApiHttpError, readValidatedJson } from "../server/api-security";
import { authorizeWorkEngineGateway } from "../server/work-engine";
import { assertModelConfigured, getModelOptions } from "./model-config";
import { leaseLocalModel, releaseRuntimeWhenResponseEnds } from "./local-model-runtime";
import { strataToolFetch } from "./strata-tool-transport";

const completionSchema = z.object({
  model: z.string().min(1).max(100), messages: z.array(z.record(z.string(), z.unknown())).min(1).max(300),
  stream: z.boolean().default(false), max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(), temperature: z.number().min(0).max(2).optional(),
  tools: z.array(z.record(z.string(), z.unknown())).max(128).optional(), tool_choice: z.unknown().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(8)]).optional(),
}).strip();

// Critical Harness task tools do not inherit a parent's denylist. Research
// and verification therefore use a separate credential whose model requests
// cannot offer or return task, shell, filesystem mutation, or plugin tools.
export const readOnlyWorkEngineTools = new Set([
  "ls", "read_file", "glob", "grep", "web_search", "web_fetch", "current_time",
  "memory_search", "memory_recall", "memory_read", "memory_get",
  "tavily_search", "brave_search", "google_search", "kimi_search", "searchfree_search",
  "search_knowledge", "cronjob_list", "cronjob_get",
]);

function wireToolName(tool: Record<string, unknown>) {
  const definition = tool.function;
  return tool.type === "function" && definition && typeof definition === "object" && typeof (definition as Record<string, unknown>).name === "string"
    ? (definition as { name: string }).name : "";
}

export function gatewayError(error: unknown) {
  if (error instanceof ZodError) return Response.json({ error: { message: "模型请求格式无效。", type: "invalid_request_error", code: "INVALID_REQUEST" } }, { status: 422, headers: { "cache-control": "no-store" } });
  const known = error instanceof ApiHttpError;
  return Response.json({ error: { message: known ? error.message : "本机模型请求失败，请检查引擎日志。", type: "work_engine_error", code: known ? error.code : "MODEL_REQUEST_FAILED" } }, { status: known ? error.status : 502, headers: { "cache-control": "no-store" } });
}

async function collectCompletion(response: Response) {
  if (!response.body) throw new ApiHttpError(502, "MODEL_EMPTY_RESPONSE", "模型没有返回内容。");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", content = "", finishReason = "stop", id = "", model = "", created = Math.floor(Date.now() / 1000), usage: unknown;
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  const parseFrame = (frame: string) => {
    const raw = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!raw || raw === "[DONE]") return;
    const value = JSON.parse(raw);
    if (value.error) throw new ApiHttpError(502, "MODEL_STREAM_FAILED", "本机模型返回了执行错误。");
    id = value.id || id; model = value.model || model; created = value.created || created; usage = value.usage || usage;
    const choice = value.choices?.[0];
    if (!choice) return;
    if (typeof choice.delta?.content === "string") content += choice.delta.content;
    if (content.length > 1_000_000) throw new ApiHttpError(502, "MODEL_OUTPUT_TOO_LARGE", "本机模型返回内容过大。");
    if (choice.finish_reason) finishReason = choice.finish_reason;
    for (const call of choice.delta?.tool_calls || []) {
      const index = call.index ?? 0;
      const current = calls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
      current.id ||= call.id || "";
      current.function.name += call.function?.name || "";
      current.function.arguments += call.function?.arguments || "";
      if (current.function.arguments.length > 1_000_000 || calls.size > 128) throw new ApiHttpError(502, "MODEL_OUTPUT_TOO_LARGE", "本机模型的工具参数过大。");
      calls.set(index, current);
    }
  };
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      buffer += decoder.decode(item.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        parseFrame(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
      }
      if (buffer.length > 2_000_000) throw new ApiHttpError(502, "MODEL_OUTPUT_TOO_LARGE", "本机模型流格式过大。");
    }
    buffer += decoder.decode(); if (buffer.trim()) parseFrame(buffer);
    return { id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: content || null, ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) }, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function handleWorkEngineCompletion(request: Request) {
  let release = () => undefined as void;
  const releaseModel = () => { const current = release; release = () => undefined; current(); };
  try {
    const authority = await authorizeWorkEngineGateway(request);
    const body = await readValidatedJson(request, completionSchema, 4 * 1024 * 1024);
    const option = (await getModelOptions()).find((entry) => entry.id === body.model);
    if (!option?.configured || option.connectionKind !== "live") throw new ApiHttpError(422, "MODEL_NOT_REGISTERED", "请从本机已注册的模型中选择。");
    const config = assertModelConfigured(option.id);
    const url = new URL(config.baseURL || "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new ApiHttpError(403, "LOCAL_MODEL_REQUIRED", "能力中心的电脑执行仅使用本机模型。");
    release = await leaseLocalModel(option.id);
    const maximum = Math.min(body.max_completion_tokens || body.max_tokens || 1024, config.maxOutputTokens || 1024, 4096);
    const offeredTools = authority.readOnly ? body.tools?.filter((tool) => readOnlyWorkEngineTools.has(wireToolName(tool))) : body.tools;
    if (authority.readOnly && body.tool_choice && typeof body.tool_choice === "object") {
      const name = wireToolName(body.tool_choice as Record<string, unknown>);
      if (!offeredTools?.some((tool) => wireToolName(tool) === name)) throw new ApiHttpError(403, "READ_ONLY_TOOL_DENIED", "研究和核验角色只能使用读取工具。");
    }
    const payload = { ...body, ...(offeredTools?.length ? { tools: offeredTools } : { tools: undefined, tool_choice: undefined }), model: config.model, stream: true, max_tokens: maximum, temperature: body.temperature ?? 0, ...(option.id === "local:strata-coder" ? { reasoning: "none", chat_template_kwargs: { enable_thinking: false } } : {}) };
    delete (payload as Record<string, unknown>).max_completion_tokens;
    const transport = option.id === "local:strata-coder" ? strataToolFetch : fetch;
    const response = await transport(`${config.baseURL?.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey || "local"}` },
      body: JSON.stringify(payload), signal: AbortSignal.any([request.signal, AbortSignal.timeout(600_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiHttpError(response.status === 400 ? 422 : 502, "LOCAL_MODEL_REJECTED", response.status === 400 ? "请求超出了本机模型的能力或上下文限制，请减少上下文或选择另一模型。" : "本机模型暂时无法处理请求，请稍后重试。");
    }
    if (!body.stream || authority.readOnly) {
      const completion = await collectCompletion(response); releaseModel();
      if (authority.readOnly) {
        const offeredNames = new Set(offeredTools?.map(wireToolName) || []);
        if (completion.choices[0].message.tool_calls?.some((call) => !readOnlyWorkEngineTools.has(call.function.name) || !offeredNames.has(call.function.name))) throw new ApiHttpError(403, "READ_ONLY_TOOL_DENIED", "研究和核验角色的写入或派生任务调用已被拦截。");
        if (body.stream) {
          const message = completion.choices[0].message;
          const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
          const frame = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
          const data = [
            { ...frame, choices: [{ index: 0, delta, finish_reason: null }] },
            { ...frame, choices: [{ index: 0, delta: {}, finish_reason: completion.choices[0].finish_reason }], ...(completion.usage ? { usage: completion.usage } : {}) },
          ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
          return new Response(data, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
        }
      }
      return Response.json(completion, { headers: { "cache-control": "no-store" } });
    }
    return releaseRuntimeWhenResponseEnds(new Response(response.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } }), release);
  } catch (error) { releaseModel(); return gatewayError(error); }
}

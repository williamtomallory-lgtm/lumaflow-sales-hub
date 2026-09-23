import "server-only";
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, toUIMessageStream, type StreamTextTransform } from "ai";
import { salesAgent, type SalesAgentUIMessage } from "./sales-agent";

type CallOptions = NonNullable<Parameters<typeof salesAgent.stream>[0]["options"]>;

function publicExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/context size|context length|available context|too many tokens/i.test(message)) return "当前任务上下文超过本机模型容量。请分页读取文件、局部编辑或拆分任务，已有结果已保留。";
  return error instanceof Error && error.name === "TimeoutError"
    ? "本机任务等待超时，已有内容已保留。请分步处理剩余任务。"
    : "本机执行或推理出现错误，请检查连接后重试。";
}

export async function completeAnswerResponse(input: {
  uiMessages: Parameters<typeof convertToModelMessages>[0];
  options: CallOptions; abortSignal: AbortSignal; timeoutMs: number; headers: HeadersInit;
  transform?: StreamTextTransform<typeof salesAgent.tools>;
}) {
  const originalPrompt = await convertToModelMessages(input.uiMessages);
  const stream = createUIMessageStream<SalesAgentUIMessage>({
    onError: publicExecutionError,
    execute: async ({ writer }) => {
      const signal = AbortSignal.any([input.abortSignal, AbortSignal.timeout(input.timeoutMs)]);
      let fullText = "";
      let textStarted = false;
      let finishReason: "stop" | "length" | "tool-calls" | "other" | "error" | "content-filter" = "stop";
      writer.write({ type: "start", messageId: crypto.randomUUID() });
      // Continue until the model finishes or the shared task deadline expires;
      // do not add an arbitrary three-chunk cap on top of its context limit.
      for (let pass = 0; !signal.aborted; pass++) {
        const prompt = pass === 0 ? originalPrompt : [
          ...originalPrompt,
          { role: "assistant" as const, content: fullText.slice(-6000) },
          { role: "user" as const, content: "上一段输出达到单次长度限制，请从最后一个字符接着完成剩余内容；不得重复、重开代码块或重新执行工具。只输出后续部分，完成原任务和代码闭合。" },
        ];
        const result = await salesAgent.stream({
          prompt, options: { ...input.options, continuation: pass > 0 }, abortSignal: signal,
          timeout: { totalMs: input.timeoutMs }, experimental_transform: input.transform,
        });
        // One text part across continuations prevents an inserted newline from
        // breaking a split JS identifier, CSS declaration or HTML attribute.
        const reader = toUIMessageStream<typeof salesAgent.tools, SalesAgentUIMessage>({ stream: result.stream, tools: salesAgent.tools, sendStart: false, sendFinish: false, sendReasoning: false, onError: publicExecutionError }).getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.type === "text-start" || value.type === "text-end") continue;
            if (value.type === "text-delta") {
              if (!textStarted) { writer.write({ type: "text-start", id: "answer" }); textStarted = true; }
              fullText += value.delta;
              writer.write({ ...value, id: "answer" });
            } else writer.write(value);
          }
        } finally { reader.releaseLock(); }
        finishReason = await result.finishReason;
        if (finishReason !== "length" || !await result.text) break;
      }
      signal.throwIfAborted();
      if (textStarted) writer.write({ type: "text-end", id: "answer" });
      writer.write({ type: "finish", finishReason });
    },
  });
  return createUIMessageStreamResponse({ stream, headers: input.headers });
}


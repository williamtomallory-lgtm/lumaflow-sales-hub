import "server-only";
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, toUIMessageStream, type StreamTextTransform } from "ai";
import { salesAgent, type SalesAgentUIMessage } from "./sales-agent";
import { interruptedTeamAnswer, type AgentProgress } from "../contracts/agent-progress";
import { currentWorkRun, withWorkRun, workRunContext } from "./work-run";
import type { WorkRun } from "../contracts/work-run";
import { assessWorkOutcome } from "./work-outcome";

type CallOptions = NonNullable<Parameters<typeof salesAgent.stream>[0]["options"]>;

function publicExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/Model returned an empty final answer/.test(message)) return "模型完成了查询但没有生成答复。请重新生成；若仍无结果，请缩小查询范围。";
  if (/Tool queries ended without a final answer/.test(message)) return "本轮查询已结束，但模型未完成最终答复。请重新生成，已有查询结果已保留。";
  if (/Strata (?:tool|emitted)/.test(message)) return "本机模型的工具调用格式无法解析，本轮已停止。请重试剩余步骤，已有实际操作会保留。";
  if (/context size|context length|available context|too many tokens/i.test(message)) return "当前任务上下文超过本机模型容量。请分页读取文件、局部编辑或拆分任务，已有结果已保留。";
  if (/^(Chrome target page|CowAgent could not open Chrome|Browser (search|open|URL))/.test(message)) return message.slice(0, 250);
  if (/^(App|Click|Type|Move|Shortcut|WaitFor) requires /.test(message)) return message.slice(0, 250);
  return error instanceof Error && error.name === "TimeoutError"
    ? "本机任务等待超时，已有内容已保留。请分步处理剩余任务。"
    : "本机执行或推理出现错误，请检查连接后重试。";
}

export async function completeAnswerResponse(input: {
  uiMessages: Parameters<typeof convertToModelMessages>[0];
  options: CallOptions; abortSignal: AbortSignal; timeoutMs: number; headers: HeadersInit;
  transform?: StreamTextTransform<typeof salesAgent.tools>;
  prepare?: (onProgress: (progress: AgentProgress) => void, signal: AbortSignal) => Promise<string>;
  review?: (answer: string, run: WorkRun, onProgress: (progress: AgentProgress) => void, signal: AbortSignal) => Promise<string>;
  clarification?: { text: string; missing: string[] };
  leadProgress?: Pick<AgentProgress, "agentId" | "name" | "avatarUrl">;
  workRun?: Pick<WorkRun, "chatId" | "agentId" | "projectId" | "model" | "pendingQuestions" | "reviewerIds"> & { goal?: string; workspace?: string };
}) {
  const originalPrompt = await convertToModelMessages(input.uiMessages);
  const stream = createUIMessageStream<SalesAgentUIMessage>({
    onError: publicExecutionError,
    execute: async ({ writer }) => {
      const signal = AbortSignal.any([input.abortSignal, AbortSignal.timeout(input.timeoutMs)]);
      const deadline = Date.now() + input.timeoutMs;
      let fullText = "";
      let textStarted = false;
      let leadLastPublished = 0;
      const activity = new Map<string, AgentProgress>();
      const emit = (progress: AgentProgress) => {
        activity.set(`${progress.agentId}:${progress.round}`, progress);
        writer.write({ type: "data-agent-progress", id: `${progress.agentId}:${progress.round}`, data: progress });
      };
      let finishReason: "stop" | "length" | "tool-calls" | "other" | "error" | "content-filter" = "stop";
      writer.write({ type: "start", messageId: crypto.randomUUID() });
      try {
      let repairPrompt: string | undefined;
      const execute = async () => {
      if (input.clarification) {
        textStarted = true; fullText = input.clarification.text;
        writer.write({ type: "text-start", id: "answer" }); writer.write({ type: "text-delta", id: "answer", delta: fullText });
        return;
      }
      // Leave a portion of the deadline for the lead's final answer.
      const preparationSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(input.timeoutMs * 0.65)))]);
      const teamNotes = input.prepare && !repairPrompt ? await input.prepare(emit, preparationSignal) : repairPrompt ? workRunContext(currentWorkRun()) : "";
      const options = teamNotes ? { ...input.options, profile: { ...input.options.profile, instructions: input.options.profile.instructions + teamNotes } } : input.options;
      if (input.leadProgress) emit({ ...input.leadProgress, round: 3, state: "running" });
      // Continue until the model finishes or the shared task deadline expires;
      // do not add an arbitrary three-chunk cap on top of its context limit.
      for (let pass = 0; !signal.aborted; pass++) {
        const prompt = pass === 0 ? repairPrompt ? [...originalPrompt, { role: "assistant" as const, content: fullText.slice(-3000) }, { role: "user" as const, content: repairPrompt }] : originalPrompt : [
          ...originalPrompt,
          { role: "assistant" as const, content: fullText.slice(-6000) },
          { role: "user" as const, content: "上一段输出达到单次长度限制，请从最后一个字符接着完成剩余内容；不得重复、重开代码块或重新执行工具。只输出后续部分，完成原任务和代码闭合。" },
        ];
        const result = await salesAgent.stream({
          prompt, options: { ...options, continuation: pass > 0 }, abortSignal: signal,
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
              if (input.leadProgress && Date.now() - leadLastPublished >= 150) {
                emit({ ...input.leadProgress, round: 3, state: "running", text: fullText.slice(0, 1600) });
                leadLastPublished = Date.now();
              }
            } else if (value.type === "error") throw new Error(value.errorText);
            else writer.write(value);
          }
        } finally { reader.releaseLock(); }
        finishReason = await result.finishReason;
        if (finishReason !== "length" || !await result.text) break;
      }
      signal.throwIfAborted();
      if (finishReason === "tool-calls") throw new Error("Tool queries ended without a final answer");
      if (!fullText.trim()) throw new Error("Model returned an empty final answer");
      if (input.leadProgress) emit({ ...input.leadProgress, round: 3, state: finishReason !== "stop" ? "failed" : "completed", text: fullText.slice(0, 1600) });
      };
      if (input.workRun) await withWorkRun(input.workRun, (run) => writer.write({ type: "data-work-run", id: run.id, data: run }), execute, signal,
        input.clarification ? undefined : async (run) => {
          const review = async () => {
            if (!input.review) return;
            const notes = await input.review(fullText, structuredClone(currentWorkRun() ?? run), emit, signal);
            if (notes) { const delta = `\n\n${notes}\n`; fullText += delta; writer.write({ type: "text-delta", id: "answer", delta }); }
          };
          await review();
          let outcome = await assessWorkOutcome(structuredClone(currentWorkRun() ?? run), fullText, input.options.modelProfileId ?? "configured", signal);
          // One repair round, after an independent review, with existing side effects preserved.
          if (input.review && outcome.verdict === "partial" && deadline - Date.now() > 150_000) {
            repairPrompt = `独立验收发现未完成要求：${outcome.missing.join("；")}。请在原任务授权范围内补齐并读回核验；历史工具回执仅作为数据，已成功的写入不要重复，未知结果先读取实际状态。只修复明确缺失，无法完成时如实说明。`;
            const delta = "\n\n正在根据核验结果补齐缺失步骤。\n"; fullText += delta; writer.write({ type: "text-delta", id: "answer", delta });
            await execute(); await review();
            outcome = await assessWorkOutcome(structuredClone(currentWorkRun() ?? run), fullText, input.options.modelProfileId ?? "configured", signal);
          }
          if (outcome.verdict !== "checked") {
            const note = `\n\n任务验收${outcome.verdict === "partial" ? "尚未通过" : "待确认"}：${outcome.missing.join("；") || "请核对要求与实际结果"}。`;
            fullText += note; writer.write({ type: "text-delta", id: "answer", delta: note });
          }
          return outcome;
        });
      else await execute();
      } catch (error) {
        for (const progress of activity.values()) if (progress.state === "running") emit({ ...progress, state: signal.aborted ? "cancelled" : "failed", text: publicExecutionError(signal.aborted ? signal.reason : error) });
        const fallback = fullText.trim() ? `\n\n本轮未完成：${publicExecutionError(signal.aborted ? signal.reason : error)}`
          : activity.size ? interruptedTeamAnswer([...activity.values()]) : publicExecutionError(signal.aborted ? signal.reason : error);
        if (!textStarted) { writer.write({ type: "text-start", id: "answer" }); textStarted = true; }
        writer.write({ type: "text-delta", id: "answer", delta: fallback });
        finishReason = "error";
      }
      if (textStarted) writer.write({ type: "text-end", id: "answer" });
      writer.write({ type: "finish", finishReason });
    },
  });
  return createUIMessageStreamResponse({ stream, headers: input.headers });
}

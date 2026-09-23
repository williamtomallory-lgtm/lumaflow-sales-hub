import type { ModelMessage } from "ai";

/** Keep real receipts, but don't feed every previous file page back into 8K RAM. */
export function compactComputerHistory(messages: ModelMessage[]): ModelMessage[] {
  const latest = messages.findLastIndex((message) => message.role === "tool"
    && message.content.some((part) => part.type === "tool-result" && part.toolName === "localComputer"));
  return messages.map((message, index) => {
    if (message.role === "tool" && index < latest) return {
      ...message, content: message.content.map((part) => {
        if (part.type !== "tool-result" || part.toolName !== "localComputer" || part.output.type !== "json") return part;
        const value = part.output.value;
        if (!value || typeof value !== "object" || Array.isArray(value)) return part;
        const compacted = { ...value };
        for (const key of ["content", "stdout", "stderr"]) {
          const text = compacted[key];
          if (typeof text === "string" && text.length > 800) compacted[key] = `${text.slice(0, 300)}\n[此前正文已折叠；准确编辑时请重新分页读取]\n${text.slice(-300)}`;
        }
        return { ...part, output: { ...part.output, value: compacted } };
      }),
    };
    if (message.role === "assistant" && typeof message.content !== "string") return {
      ...message, content: message.content.map((part) => {
        if (part.type !== "tool-call" || part.toolName !== "localComputer" || !part.input || typeof part.input !== "object" || Array.isArray(part.input)) return part;
        const input = part.input as Record<string, unknown>;
        return typeof input.content === "string" && input.content.length > 1000
          ? { ...part, input: { ...input, content: "[此前已提交的文件内容已折叠，真实结果见工具回执；需要正文时重新读取文件]" } } : part;
      }),
    };
    return message;
  });
}


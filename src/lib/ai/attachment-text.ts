import type { StreamTextTransform, TextStreamPart, ToolSet } from "ai";

/** The current tools expose attachment metadata, never authoritative download URLs. */
export function attachmentNamesOnly(text: string) {
  return text.replace(/!?\[([^\]\r\n]+)\]\([^\r\n)]*\)/g, "$1");
}

/** Buffer one text line so links split across model tokens are handled consistently. */
export function attachmentTextTransform<TOOLS extends ToolSet>(): StreamTextTransform<TOOLS> {
  return () => {
    type Delta = Extract<TextStreamPart<TOOLS>, { type: "text-delta" }>;
    const pending = new Map<string, { chunk: Delta; text: string }>();
    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        if (chunk.type === "text-delta") {
          const text = (pending.get(chunk.id)?.text ?? "") + chunk.text;
          const boundary = text.lastIndexOf("\n") + 1;
          if (boundary) controller.enqueue({ ...chunk, text: attachmentNamesOnly(text.slice(0, boundary)) });
          pending.set(chunk.id, { chunk, text: text.slice(boundary) });
          return;
        }
        if (chunk.type === "text-end") {
          const remaining = pending.get(chunk.id);
          if (remaining?.text) controller.enqueue({ ...remaining.chunk, text: attachmentNamesOnly(remaining.text) });
          pending.delete(chunk.id);
        }
        if (["error", "abort", "finish-step", "finish"].includes(chunk.type)) {
          for (const remaining of pending.values()) {
            if (remaining.text) controller.enqueue({ ...remaining.chunk, text: attachmentNamesOnly(remaining.text) });
          }
          pending.clear();
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        for (const remaining of pending.values()) {
          if (remaining.text) controller.enqueue({ ...remaining.chunk, text: attachmentNamesOnly(remaining.text) });
        }
      },
    });
  };
}

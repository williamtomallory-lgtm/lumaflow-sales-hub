// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TextStreamPart } from "ai";
import { attachmentNamesOnly, attachmentTextTransform } from "./attachment-text";
type NoTools = Record<string, never>;

describe("attachment names output formatting", () => {
  it("keeps names instead of unsupported Markdown download or image links", () => {
    expect(attachmentNamesOnly("[参数表](#)，![场景图](https://invented.invalid/file)" )).toBe("参数表，场景图");
    expect(attachmentNamesOnly("SKU LT-ARC-T18-BK，库存126件，Ø62 × H138 mm。" )).toBe("SKU LT-ARC-T18-BK，库存126件，Ø62 × H138 mm。");
  });

  it("handles every token boundary and preserves stream IDs and end markers", async () => {
    const text = "库存126件\n附件：[参数表](#)\n最后：[场景图](https://invented.invalid/file)";
    const input: TextStreamPart<NoTools>[] = [
      { type: "text-start", id: "answer" },
      ...Array.from(text).map((character) => ({ type: "text-delta" as const, id: "answer", text: character })),
      { type: "text-end", id: "answer" },
    ];
    const source = new ReadableStream<TextStreamPart<NoTools>>({ start(controller) { input.forEach((part) => controller.enqueue(part)); controller.close(); } });
    const parts: TextStreamPart<NoTools>[] = [];
    const reader = source.pipeThrough(attachmentTextTransform<NoTools>()({ tools: {}, stopStream() {} })).getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }
    expect(parts[0]).toEqual(input[0]);
    expect(parts.at(-1)).toEqual(input.at(-1));
    const deltas = parts.filter((part) => part.type === "text-delta");
    expect(deltas.every((part) => part.id === "answer")).toBe(true);
    expect(deltas.map((part) => part.text).join("")).toBe("库存126件\n附件：参数表\n最后：场景图");
    expect(deltas.length).toBe(3); // Still streams each completed line, not the whole answer.
  });
});

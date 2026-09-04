import { describe, expect, it } from "vitest";
import { parseDocumentBuffer } from "./document-parser";

describe("document parser", () => {
  it("extracts and normalizes UTF-8 text", async () => {
    const bytes = new TextEncoder().encode("产品知识   \n\n\nARC T18：18W 轨道灯");
    const result = await parseDocumentBuffer("catalog.txt", "text/plain", bytes.buffer);
    expect(result.text).toBe("产品知识\n\nARC T18：18W 轨道灯");
    expect(result.characters).toBeGreaterThan(10);
    expect(result.truncated).toBe(false);
  });

  it("rejects unsupported formats honestly", async () => {
    const bytes = new TextEncoder().encode("data");
    await expect(parseDocumentBuffer("archive.zip", "application/zip", bytes.buffer)).rejects.toThrow("暂不支持");
  });
});

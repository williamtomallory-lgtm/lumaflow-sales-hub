/** Task classification changes output length, never tools or permissions. */
export function requestsCodeArtifact(text: string): boolean {
  return /(?:创建|生成|编写|制作|写|create|build|generate|write)/i.test(text)
    && /(?:html|网页|动画|代码|javascript|canvas|svg)/i.test(text);
}

/** A closed HTML root is enough even when the model omits the Markdown fence. */
export function extractCompleteHtml(text: string): string | null {
  for (const segment of splitFencedAnswer(text)) {
    if (segment.kind !== "code") continue;
    const html = /(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*?<\/html>/i.exec(segment.content);
    if (html) return html[0].trim();
  }
  return null;
}
import { splitFencedAnswer } from "./fenced-code";

export type AnswerSegment = { kind: "text" | "code"; content: string; language?: string; complete?: boolean };

function unfencedCode(answer: string): AnswerSegment[] | null {
  const trimmed = answer.trim();
  const html = /(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*<\/html>/i.exec(answer);
  if (html) {
    const before = answer.slice(0, html.index);
    const after = answer.slice(html.index + html[0].length);
    return [
      ...(before ? [{ kind: "text" as const, content: before }] : []),
      { kind: "code", language: "html", content: html[0].trim() },
      ...(after ? [{ kind: "text" as const, content: after }] : []),
    ];
  }
  const partialHtml = /(?:<!doctype\s+html[^>]*>|<html\b[^>]*>)[\s\S]*/i.exec(answer);
  if (partialHtml && /^(?:\s*|[^<\n]*\n)$/.test(answer.slice(0, partialHtml.index))) {
    const before = answer.slice(0, partialHtml.index);
    return [...(before ? [{ kind: "text" as const, content: before }] : []), { kind: "code", language: "html", content: partialHtml[0], complete: false }];
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 4) return null;
  const codeLines = lines.filter((line) => /^\s*(?:const\s|let\s|var\s|function\s|import\s|export\s|class\s|if\s*\(|for\s*\(|return\b|\/\/|\/\*|\*|[{});]|<[\w!/]|[.#\w-]+\s*[:{=])/i.test(line)).length;
  if (codeLines / lines.length < 0.65 || !/^(?:\s*(?:const|let|var|function|import|export|class)\b|\s*<[\w!/])/i.test(trimmed)) return null;
  return [{ kind: "code", language: trimmed.startsWith("<") ? "html" : "javascript", content: trimmed }];
}

/** Render the opening fence immediately so streamed code stays inside its card. */
export function splitFencedAnswer(answer: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  const opening = /^[ \t]*```([^\r\n]*)(?:\r?\n|$)/gm;
  let offset = 0;
  while (true) {
    opening.lastIndex = offset;
    const start = opening.exec(answer);
    if (!start) break;
    const index = start.index;
    if (index > offset) segments.push({ kind: "text", content: answer.slice(offset, index) });
    const bodyStart = opening.lastIndex;
    const closing = /^[ \t]*```[ \t]*(?:\r?\n|$)/gm;
    closing.lastIndex = bodyStart;
    const end = closing.exec(answer);
    segments.push({ kind: "code", language: start[1].trim().split(/\s+/)[0].toLowerCase(), content: answer.slice(bodyStart, end?.index ?? answer.length).replace(/\r?\n$/, ""), complete: Boolean(end) });
    offset = end ? closing.lastIndex : answer.length;
    if (!end) break;
  }
  if (offset < answer.length) segments.push({ kind: "text", content: answer.slice(offset) });
  if (segments.length === 1 && segments[0].kind === "text") return unfencedCode(answer) ?? segments;
  return segments;
}

/** Task classification changes output length, never tools or permissions. */
export function requestsCodeArtifact(text: string): boolean {
  return /(?:创建|生成|编写|制作|写|create|build|generate|write)/i.test(text)
    && /(?:html|网页|动画|代码|javascript|canvas|svg)/i.test(text);
}

/** Only offer a file after a complete fenced HTML document was returned. */
export function extractCompleteHtml(text: string): string | null {
  const match = /```(?:html)?\s*\n([\s\S]*?)\n```/i.exec(text);
  if (!match || !/<html[\s>]/i.test(match[1]) || !/<\/html>\s*$/i.test(match[1])) return null;
  return match[1].trim();
}


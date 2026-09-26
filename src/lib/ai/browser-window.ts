export function focusedChromeWindow(snapshot: string): string {
  const section = snapshot.split("Focused Window:")[1]?.split("Opened Windows:")[0] ?? "";
  return section.split("\n").map((line) => line.trim()).find((line) => /Chrome/i.test(line)) ?? "";
}

function chromeWindows(snapshot: string): Array<{ title: string; handle: string }> {
  const section = snapshot.split("Opened Windows:")[1]?.split("UI Tree:")[0] ?? "";
  return section.split("\n").flatMap((line) => {
    const match = line.match(/^(.+? - Google Chrome)\s+\d+\s+\w+\s+\d+\s+\d+\s+(\d+)\s*$/i);
    return match ? [{ title: match[1].trim(), handle: match[2] }] : [];
  });
}

export function targetChromeWindow(before: string, after: string, query?: string): string | null {
  const oldHandles = new Set(chromeWindows(before).map((window) => window.handle));
  const windows = chromeWindows(after);
  const fresh = windows.find((window) => !oldHandles.has(window.handle));
  if (fresh) return fresh.title;
  const significantWord = query?.match(/[\p{L}\p{N}]{4,}/gu)?.sort((a, b) => b.length - a.length)[0];
  return significantWord ? windows.find((window) => window.title.toLowerCase().includes(significantWord.toLowerCase()))?.title ?? null : null;
}

export function readableBrowserPage(snapshot: string, action: "search" | "open" | "inspect"): boolean {
  const tree = snapshot.split("UI Tree:")[1] ?? "";
  if (action === "search") return tree.length >= 1_500 && (tree.match(/(?:├──|└──) text /g)?.length ?? 0) >= 8;
  return tree.length >= 200;
}

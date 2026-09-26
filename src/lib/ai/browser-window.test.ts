import { describe, expect, it } from "vitest";
import { focusedChromeWindow, readableBrowserPage, targetChromeWindow } from "./browser-window";

const before = `Focused Window:\nChatGPT       8  Normal  1920  1224  198060\nOpened Windows:\nLumaFlow · Chat-AI - Google Chrome       13  Maximized  2582  1550  396110\nUI Tree:\n`;
const after = `Focused Window:\nChatGPT       8  Normal  1920  1224  198060\nOpened Windows:\nLumaFlow · Chat-AI - Google Chrome       13  Maximized  2582  1550  396110\nMississauga weather today - Google Search - Google Chrome       11  Maximized  2582  1550  264138\nUI Tree:\n`;

describe("browser window evidence", () => {
  it("selects the newly opened Chrome window instead of the existing app tab", () => {
    expect(targetChromeWindow(before, after, "Mississauga weather today")).toBe("Mississauga weather today - Google Search - Google Chrome");
    expect(focusedChromeWindow(after)).toBe("");
  });

  it("requires a focused browser with loaded page text before a search answer", () => {
    const focused = after.replace("ChatGPT       8  Normal  1920  1224  198060", "Mississauga weather today - Google Search - Google Chrome       11  Maximized  2582  1550  264138");
    expect(focusedChromeWindow(focused)).toContain("Mississauga weather today");
    expect(readableBrowserPage(focused + "├── text loading", "search")).toBe(false);
    expect(readableBrowserPage(focused + "├── text result\n".repeat(200), "search")).toBe(true);
  });
});

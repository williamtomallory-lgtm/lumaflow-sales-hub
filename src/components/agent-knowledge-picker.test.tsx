import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentKnowledgePicker } from "./agent-knowledge-picker";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("saves text as an actual knowledge file and selects the returned file ID", async () => {
  const onChange = vi.fn(); const uploads: FormData[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { if (init?.method === "POST") { uploads.push(init.body); return Response.json({ data: { id: "11111111-1111-4111-8111-111111111111", title: "工作说明" } }); } return Response.json({ data: [] }); }));
  render(<AgentKnowledgePicker value={[]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" })); fireEvent.click(screen.getByRole("menuitem", { name: "输入文字" }));
  fireEvent.change(screen.getByRole("textbox", { name: "知识文字标题" }), { target: { value: "工作说明" } });
  fireEvent.change(screen.getByRole("textbox", { name: "知识文字正文" }), { target: { value: "Verify actual receipts." } });
  fireEvent.click(screen.getByRole("button", { name: "保存并选用" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(["11111111-1111-4111-8111-111111111111"]));
  expect((uploads[0].get("file") as File).name).toBe("工作说明.txt");
});

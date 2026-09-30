import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeEntry } from "@/lib/knowledge/contracts";
import { AgentKnowledgeLibrary } from "./agent-knowledge-library";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const agents = [{ id: "wechat-service", name: "微信客服", enabled: true, agentType: "weixin_personal" }, { id: "other", name: "其它 Agent", enabled: true }];
const status = (agentId: string, includeDemo = false) => ({ agentId, documentIds: [], includeDemo, documents: includeDemo ? [{ id: "demo-pa-products", fileName: "01-products.txt", title: "演示", collection: "demo", characters: 100 }] : [] });
function mockRequests(mutate?: (input: Record<string, unknown>) => unknown) {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/v1/cowagent/agents") return Response.json({ data: { agents } });
    if (options?.method === "POST") {
      const input = JSON.parse(options.body as string);
      return Response.json({ data: mutate?.(input) ?? status(input.agentId, input.action === "import-demo") });
    }
    return Response.json({ data: status(new URL(url, "http://localhost").searchParams.get("agentId")!) });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("explicit Agent knowledge sharing", () => {
  it("does not import or grant any files merely by opening the page", async () => {
    const fetcher = mockRequests();
    render(<AgentKnowledgeLibrary documents={[]} onToast={vi.fn()} />);
    await screen.findByText(/当前可检索 0 份资料/);
    expect(fetcher.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
    expect(screen.getByText(/暂未上传可读文件/)).toBeTruthy();
  });
  it("imports fixtures only after explicit action and labels them as fictional", async () => {
    const toast = vi.fn(); const fetcher = mockRequests();
    render(<AgentKnowledgeLibrary documents={[]} onToast={toast} />);
    await screen.findByText(/当前可检索 0 份资料/);
    fireEvent.click(screen.getByText("导入四份虚构演示 TXT"));
    await screen.findByText(/01-products.txt（虚构演示）/);
    const post = fetcher.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ action: "import-demo", agentId: "wechat-service" });
    expect(toast).toHaveBeenCalled();
  });
  it("sends only selected readable files to the current Agent", async () => {
    const documents = [{ id: "b5900a80-ec74-46c8-b9de-a4a946c84502", originalName: "我的参数.txt", hasText: true, classificationStatus: "classified" },
      { id: "binary", originalName: "不可读.bin", hasText: false }, { id: "archived", originalName: "已归档.txt", hasText: true, classificationStatus: "archived" }] as KnowledgeEntry[];
    const fetcher = mockRequests();
    render(<AgentKnowledgeLibrary documents={documents} onToast={vi.fn()} />);
    await screen.findByText(/当前可检索 0 份资料/);
    expect(screen.queryByText(/不可读.bin|已归档.txt/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/我的参数.txt/));
    fireEvent.click(screen.getByText("保存文件授权"));
    await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
    const post = fetcher.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ action: "assign", agentId: "wechat-service", documentIds: [documents[0].id], includeDemo: false });
  });
  it("shows a backend failure instead of claiming knowledge was connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "backend down" } }, { status: 503 })));
    render(<AgentKnowledgeLibrary documents={[]} onToast={vi.fn()} />);
    await screen.findByRole("alert");
    expect((screen.getByText("导入四份虚构演示 TXT") as HTMLButtonElement).disabled).toBe(true);
  });
});

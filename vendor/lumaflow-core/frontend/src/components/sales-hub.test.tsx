import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testSnapshot } from "@/test/fixtures";
import { buildDashboardSummary } from "@/lib/data-snapshot";
import { SalesHub } from "./sales-hub";

vi.mock("@/hooks/use-backend-data", () => ({
  useBackendData: () => ({
    response: { data: testSnapshot, dashboard: buildDashboardSummary(testSnapshot), meta: { generatedAt: "2026-09-08T12:00:00.000Z" } },
    loading: false, error: null, refresh: vi.fn(),
  }),
}));
// Verify shell wiring independently of inference: both entry paths use this
// exact component and pass the intended experience/customer, not two page trees.
vi.mock("./agent-workspace", () => ({
  AgentWorkspace: (props: { initialExperience: string; initialCustomerId?: string; initialMessage?: string; preferredRoleId?: string; selectAllKnowledge?: boolean; onOpenKnowledge: () => void }) => <div data-testid="unified-chat" data-role={props.preferredRoleId} data-all-knowledge={String(props.selectAllKnowledge)}>{props.initialExperience}<span>{props.initialCustomerId}</span><span>{props.initialMessage}</span><button onClick={props.onOpenKnowledge}>归档资料</button></div>,
}));
vi.mock("./knowledge-hub", () => ({
  KnowledgeHub: (props: { section?: string }) => <div data-testid="knowledge-destination" data-section={props.section}>文件归档模块</div>,
}));
beforeEach(() => { vi.stubGlobal("scrollTo", vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("unified Chat-AI navigation", () => {
  it("opens customer analysis in Work on the same Chat-AI page", () => {
    render(<SalesHub />);
    fireEvent.click(screen.getByRole("button", { name: "客户与会话" }));
    fireEvent.click(screen.getByRole("button", { name: "复盘全部会话" }));
    expect(screen.getByTestId("unified-chat")).toHaveTextContent("work");
    expect(screen.getByTestId("unified-chat")).toHaveTextContent(testSnapshot.customers[0].id);
    expect(screen.getByTestId("unified-chat")).toHaveAttribute("data-role", "sales-review");
    expect(screen.getByTestId("unified-chat")).toHaveAttribute("data-all-knowledge", "true");
    expect(screen.getByTestId("unified-chat")).toHaveTextContent(testSnapshot.customers[0].conversations[0].content);
    expect(screen.getAllByTestId("unified-chat")).toHaveLength(1);
  });
  it("merges legacy catalog pages into knowledge and removes unused navigation", () => {
    render(<SalesHub />);
    const navigation = within(screen.getByLabelText("主导航"));
    expect(navigation.getAllByRole("button", { name: /Chat-AI/ })).toHaveLength(1);
    for (const removed of ["工作台", "产品中心", "资料中心", "销售资料包", "报价系统", "管理后台"]) expect(navigation.queryByRole("button", { name: removed })).not.toBeInTheDocument();
    expect(screen.queryByTestId("unified-chat")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "所有销售知识，一个入口管理" })).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-destination")).toBeInTheDocument();
    fireEvent.click(navigation.getByRole("button", { name: /Chat-AI/ }));
    expect(screen.getByTestId("unified-chat")).toHaveTextContent("chat");
  });
  it("opens a new sales kit inside the knowledge page", () => {
    render(<SalesHub />);
    fireEvent.click(screen.getByRole("button", { name: "新建资料包" }));
    expect(screen.getByTestId("knowledge-destination")).toHaveAttribute("data-section", "kit");
    expect(screen.getByRole("heading", { name: "所有销售知识，一个入口管理" })).toBeInTheDocument();
  });
});

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
  AgentWorkspace: (props: { initialExperience: string; initialCustomerId?: string; onOpenKnowledge: () => void }) => <div data-testid="unified-chat">{props.initialExperience}<span>{props.initialCustomerId}</span><button onClick={props.onOpenKnowledge}>归档资料</button></div>,
}));
vi.mock("./knowledge-hub", () => ({
  KnowledgeHub: () => <div data-testid="knowledge-destination">文件归档模块</div>,
}));
beforeEach(() => { vi.stubGlobal("scrollTo", vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("unified Chat-AI navigation", () => {
  it("opens customer analysis in Work on the same Chat-AI page", () => {
    render(<SalesHub />);
    fireEvent.click(screen.getByRole("button", { name: "客户与会话" }));
    fireEvent.click(screen.getByRole("button", { name: "分析最新消息" }));
    expect(screen.getByTestId("unified-chat")).toHaveTextContent("work");
    expect(screen.getByTestId("unified-chat")).toHaveTextContent(testSnapshot.customers[0].id);
    expect(screen.getAllByTestId("unified-chat")).toHaveLength(1);
  });
  it("has one Chat-AI entry, opens it by default, and links to knowledge", () => {
    render(<SalesHub />);
    const navigation = within(screen.getByLabelText("主导航"));
    expect(navigation.getAllByRole("button", { name: /Chat-AI/ })).toHaveLength(1);
    expect(navigation.queryByRole("button", { name: "智能搜索" })).not.toBeInTheDocument();
    expect(navigation.queryByRole("button", { name: /销售助手/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("unified-chat")).toHaveTextContent("chat");
    fireEvent.click(screen.getByRole("button", { name: "归档资料" }));
    expect(screen.queryByTestId("unified-chat")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "文件归档，知识一目了然" })).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-destination")).toBeInTheDocument();
  });
});

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
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
  AgentWorkspace: (props: { initialExperience: string; initialMessage?: string; onOpenKnowledge: () => void; onOpenWechat: () => void }) => {
    const [draft, setDraft] = useState("临时草稿");
    return <div data-testid="unified-chat">{props.initialExperience}<span>{props.initialMessage}</span><button onClick={props.onOpenKnowledge}>归档资料</button><button onClick={props.onOpenWechat}>Wechat Agent</button><button onClick={() => setDraft("已修改的草稿")}>{draft}</button></div>;
  },
}));
vi.mock("./wechat-agent-workspace", () => ({
  WechatAgentWorkspace: (props: { historyPortalTarget?: HTMLElement | null; onExperienceChange: (next: "chat" | "work") => void }) => <div data-testid="wechat-destination" data-sidebar={Boolean(props.historyPortalTarget)}><button onClick={() => props.onExperienceChange("chat")}>回到 Chat</button><button onClick={() => props.onExperienceChange("work")}>回到 Work</button></div>,
}));
vi.mock("./knowledge-hub", () => ({
  KnowledgeHub: (props: { section?: string }) => <div data-testid="knowledge-destination" data-section={props.section}>文件归档模块</div>,
}));
beforeEach(() => { vi.stubGlobal("scrollTo", vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("unified Chat-AI navigation", () => {
  it("shows recent/project navigation only on Chat-AI and keeps reminders above the profile", () => {
    render(<SalesHub />);
    const panel = screen.getByRole("region", { name: "最近与项目" });
    expect(panel).toBeVisible();
    expect(screen.queryByText("管理与增长")).not.toBeInTheDocument();
    const reminder = screen.getByRole("button", { name: "跟进提醒" });
    expect(reminder.closest(".sidebar-bottom-nav")?.nextElementSibling).toHaveClass("profile-row");
    fireEvent.click(screen.getByRole("button", { name: "知识库" }));
    expect(panel).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Chat-AI AI/ }));
    expect(panel).toBeVisible();
  });
  it("opens the dedicated Wechat Agent with global sidebar history and returns to Work", () => {
    render(<SalesHub />);
    fireEvent.click(screen.getByRole("button", { name: "Wechat Agent" }));
    expect(screen.getByTestId("wechat-destination")).toHaveAttribute("data-sidebar", "true");
    const listener = vi.fn();
    window.addEventListener("lumaflow-wechat-new-conversation", listener);
    fireEvent.click(screen.getByRole("button", { name: "新聊天" }));
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("lumaflow-wechat-new-conversation", listener);
    expect(screen.getByTestId("wechat-destination")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回到 Work" }));
    expect(screen.getByTestId("unified-chat")).toHaveTextContent("work");
  });
  it("starts a clean Chat conversation from the sidebar and removes the customer page", () => {
    render(<SalesHub />);
    const navigation = within(screen.getByLabelText("主导航"));
    expect(navigation.queryByRole("button", { name: "客户与会话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "临时草稿" }));
    expect(screen.getByRole("button", { name: "已修改的草稿" })).toBeInTheDocument();
    fireEvent.click(navigation.getByRole("button", { name: "新聊天" }));
    expect(screen.getByRole("button", { name: "临时草稿" })).toBeInTheDocument();
    expect(screen.getByTestId("unified-chat")).toHaveTextContent("chat");
    expect(screen.getAllByTestId("unified-chat")).toHaveLength(1);
  });
  it("merges legacy catalog pages into knowledge and removes unused navigation", () => {
    render(<SalesHub />);
    const navigation = within(screen.getByLabelText("主导航"));
    expect(navigation.getAllByRole("button", { name: /Chat-AI/ })).toHaveLength(1);
    for (const removed of ["工作台", "产品中心", "资料中心", "销售资料包", "报价系统", "管理后台"]) expect(navigation.queryByRole("button", { name: removed })).not.toBeInTheDocument();
    expect(screen.getByTestId("unified-chat")).toHaveTextContent("chat");
    const primaryButtons = within(navigation.getByText("工作空间").parentElement as HTMLElement).getAllByRole("button");
    expect(primaryButtons).toHaveLength(3);
    expect(primaryButtons[0]).toHaveTextContent("Chat-AI");
    expect(primaryButtons[1]).toHaveTextContent("智能体");
    expect(primaryButtons[2]).toHaveTextContent("知识库");
    fireEvent.click(navigation.getByRole("button", { name: "知识库" }));
    expect(screen.getByRole("heading", { name: "所有销售知识，一个入口管理" })).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-destination")).toBeInTheDocument();
  });
  it("opens a new sales kit inside the knowledge page", () => {
    render(<SalesHub />);
    fireEvent.click(screen.getByRole("button", { name: "知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "新建资料包" }));
    expect(screen.getByTestId("knowledge-destination")).toHaveAttribute("data-section", "kit");
    expect(screen.getByRole("heading", { name: "所有销售知识，一个入口管理" })).toBeInTheDocument();
  });
});

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProgress } from "@/lib/contracts/agent-progress";
import { AgentTeamActivity } from "./agent-team-activity";

afterEach(cleanup);

describe("independent collaboration progress", () => {
  it("shows execution progress for a single real Agent without team labels or rounds", () => {
    const record: AgentProgress = { agentId: "a", name: "Doudou", round: 2, state: "running", recipientNames: ["BibleDog", "Molly"], text: "我先核对" };
    const { rerender } = render(<AgentTeamActivity records={[record]} busy />);
    const progress = screen.getByRole("region", { name: "执行进度" });
    expect(within(progress).getByRole("status")).toHaveTextContent("正在回应");
    expect(within(progress).getByText("我先核对")).toBeVisible();
    expect(screen.queryByRole("button", { name: "协作 Agent" })).not.toBeInTheDocument();
    expect(screen.queryByText(/第 2 轮/)).not.toBeInTheDocument();
    expect(screen.queryByText("全体成员")).not.toBeInTheDocument();
    rerender(<AgentTeamActivity records={[{ ...record, text: "我先核对公开资料，发现两处差异。", actions: ["读取了已授权的说明文件", "核对了两条来源"] }]} busy />);
    expect(within(progress).getByText("我先核对公开资料，发现两处差异。")).toBeVisible();
    const actions = within(progress).getByLabelText("Doudou 实际操作");
    expect(actions).toHaveTextContent("实际操作");
    expect(within(actions).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("公开分析依据与成员发言")).not.toBeInTheDocument();
  });

  it("shows team collaboration for two distinct Agent IDs in saved history", () => {
    render(<AgentTeamActivity records={[
      { agentId: "a", name: "资料助手", round: 1, state: "running", text: "已返回的公开依据", recipientNames: ["主助手"], actions: ["查询了产品资料"] },
      { agentId: "a", name: "资料助手", round: 1, state: "completed" },
      { agentId: "a", name: "资料助手", round: 2, state: "completed", text: "给全体的补充" },
      { agentId: "b", name: "主助手", round: 1, state: "completed", text: "主 Agent 已汇总" },
    ]} busy={false} />);
    expect(screen.getByRole("region", { name: "协作 Agent 进度" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "执行进度" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    const first = screen.getAllByText("第 1 轮 · 分析观点")[0].closest("details")!;
    expect(first).not.toHaveAttribute("open");
    expect(within(first).getByText("资料助手 → 主助手")).toBeInTheDocument();
    fireEvent.click(first.querySelector("summary")!);
    expect(within(first).getByText("已返回的公开依据")).toBeVisible();
    expect(within(first).getByText("查询了产品资料")).toBeVisible();
    expect(screen.getByText("资料助手 → 全体")).toBeInTheDocument();
  });

  it.each(["parallel", "sequential", "debate"] as const)("labels actual work according to %s mode", (mode) => {
    render(<AgentTeamActivity records={[
      { agentId: "a", name: "资料助手", round: 1, state: "running" },
      { agentId: "b", name: "主助手", round: 1, state: "completed" },
    ]} busy mode={mode} />);
    expect(screen.getByRole("list", { name: "正在工作的 Agent" })).toHaveTextContent(mode === "debate" ? "开始工作" : "正在工作");
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    expect(screen.getAllByText(`第 1 轮 · ${mode === "debate" ? "分析观点" : "处理任务"}`)).not.toHaveLength(0);
    expect(screen.getAllByText(mode === "debate" ? "正在分析" : "正在工作")).toHaveLength(2);
  });

  it("renders nothing without real member records", () => {
    const { container } = render(<AgentTeamActivity records={[]} busy />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts each member from its highest round and keeps failed or cancelled separate", () => {
    const records: AgentProgress[] = [
      { agentId: "a", name: "资料助手", round: 2, state: "running" },
      { agentId: "a", name: "资料助手", round: 1, state: "completed", text: "第一轮真实分析" },
      { agentId: "b", name: "审核助手", round: 1, state: "running" },
      { agentId: "b", name: "审核助手", round: 1, state: "completed", text: "已核对来源" },
      { agentId: "c", name: "失败助手", round: 1, state: "failed" },
      { agentId: "d", name: "取消助手", round: 2, state: "cancelled" },
    ];
    render(<AgentTeamActivity records={records} busy />);
    expect(screen.getByRole("status")).toHaveTextContent("1 运行中 · 1 完成 · 1 失败 · 1 已取消");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    expect(within(screen.getByRole("list", { name: "协作成员进度" })).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getAllByText("正在回应")).toHaveLength(2);
    expect(screen.getByText("失败助手")).toBeInTheDocument();
  });

  it("shows a single Agent as stopped once the request ends", () => {
    const { rerender } = render(<AgentTeamActivity records={[{ agentId: "a", name: "资料助手", round: 1, state: "running" }]} busy />);
    expect(screen.getByRole("status")).toHaveTextContent("正在分析");
    rerender(<AgentTeamActivity records={[{ agentId: "a", name: "资料助手", round: 1, state: "running" }]} busy={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("已停止");
    expect(screen.queryByRole("button", { name: "协作 Agent" })).not.toBeInTheDocument();
  });

  it("shows one Agent's current stage and avatar without a collaboration toggle", () => {
    const record: AgentProgress = { agentId: "doudou", name: "Doudou", avatarUrl: "/api/avatars/doudou", round: 1, state: "running" };
    const { rerender } = render(<AgentTeamActivity records={[record]} busy />);
    const progress = screen.getByRole("region", { name: "执行进度" });
    expect(within(progress).getByText("Doudou")).toBeInTheDocument();
    expect(within(progress).getByRole("status")).toHaveTextContent("正在分析");
    expect(progress.querySelector("img")).toHaveAttribute("src", "/api/avatars/doudou");
    expect(screen.queryByRole("button", { name: "协作 Agent" })).not.toBeInTheDocument();
    expect(screen.queryByText("第 1 轮 · 分析观点")).not.toBeInTheDocument();
    rerender(<AgentTeamActivity records={[{ ...record, state: "completed" }]} busy={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("已完成");
  });

  it("shows the latest single-Agent history content without round labels", () => {
    render(<AgentTeamActivity records={[
      { agentId: "a", name: "资料助手", avatarUrl: "/api/avatars/a", round: 1, state: "completed", text: "第一轮：资料有两处缺口。" },
      { agentId: "a", name: "资料助手", round: 2, state: "completed", text: "第二轮：已复查，建议标明这两处缺口。" },
    ]} busy={false} />);
    const progress = screen.getByRole("region", { name: "执行进度" });
    expect(within(progress).getByText("第二轮：已复查，建议标明这两处缺口。")).toBeVisible();
    expect(within(progress).queryByText("第一轮：资料有两处缺口。")).not.toBeInTheDocument();
    expect(progress.querySelector("img")).toHaveAttribute("src", "/api/avatars/a");
    expect(screen.queryByText(/第 [12] 轮/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已完成");
  });

  it("retains previously supplied real text when a terminal update has no new text", () => {
    render(<AgentTeamActivity records={[
      { agentId: "a", name: "资料助手", round: 1, state: "running", text: "已收到的分析片段" },
      { agentId: "a", name: "资料助手", round: 1, state: "failed" },
    ]} busy={false} />);
    const progress = screen.getByRole("region", { name: "执行进度" });
    expect(within(progress).getByRole("status")).toHaveTextContent("失败");
    expect(within(progress).getByText("已收到的分析片段")).toBeVisible();
    expect(screen.queryByText(/第 1 轮/)).not.toBeInTheDocument();
  });

  it("keeps the lead Agent running through delivery and shows its saved third-round text", () => {
    const member: AgentProgress = { agentId: "member", name: "资料助手", round: 2, state: "completed", text: "协作建议" };
    const lead: AgentProgress = { agentId: "lead", name: "主 Agent", round: 3, state: "running" };
    const { rerender } = render(<AgentTeamActivity records={[member, lead]} busy />);
    expect(screen.getByRole("status")).toHaveTextContent("1 运行中 · 1 完成");
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    expect(screen.getAllByText("正在汇总与交付")).toHaveLength(2);
    rerender(<AgentTeamActivity records={[member, { ...lead, state: "completed", text: "已核对并交付最终文件。" }]} busy={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("0 运行中 · 2 完成");
    const round = screen.getByText("第 3 轮 · 汇总与交付").closest("details")!;
    fireEvent.click(round.querySelector("summary")!);
    expect(within(round).getByText("已核对并交付最终文件。")).toBeVisible();
  });
});

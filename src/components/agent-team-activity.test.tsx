import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProgress } from "@/lib/contracts/agent-progress";
import { AgentTeamActivity } from "./agent-team-activity";

afterEach(cleanup);

describe("independent collaboration progress", () => {
  it("opens the running round and updates real partial speech with recipients and operations", () => {
    const record: AgentProgress = { agentId: "a", name: "Doudou", round: 2, state: "running", recipientNames: ["BibleDog", "Molly"], text: "我先核对" };
    const { rerender } = render(<AgentTeamActivity records={[record]} busy />);
    expect(screen.queryByText("我先核对")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    const round = screen.getByText("第 2 轮 · 相互回应").closest("details")!;
    expect(round).toHaveAttribute("open");
    expect(within(round).getByText("Doudou → BibleDog、Molly")).toBeInTheDocument();
    expect(within(round).getByText("我先核对")).toBeVisible();
    rerender(<AgentTeamActivity records={[{ ...record, text: "我先核对公开资料，发现两处差异。", actions: ["读取了已授权的说明文件", "核对了两条来源"] }]} busy />);
    expect(within(round).getByText("我先核对公开资料，发现两处差异。")).toBeVisible();
    const actions = within(round).getByLabelText("Doudou 第 2 轮实际操作");
    expect(actions).toHaveTextContent("实际操作");
    expect(within(actions).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("公开分析依据与成员发言")).toBeInTheDocument();
  });

  it("keeps saved rounds folded until opened and falls back to all recipients", () => {
    render(<AgentTeamActivity records={[
      { agentId: "a", name: "资料助手", round: 1, state: "running", text: "已返回的公开依据", recipientNames: ["主助手"], actions: ["查询了产品资料"] },
      { agentId: "a", name: "资料助手", round: 1, state: "completed" },
      { agentId: "a", name: "资料助手", round: 2, state: "completed", text: "给全体的补充" },
    ]} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    const first = screen.getByText("第 1 轮 · 分析观点").closest("details")!;
    expect(first).not.toHaveAttribute("open");
    expect(within(first).getByText("资料助手 → 主助手")).toBeInTheDocument();
    fireEvent.click(first.querySelector("summary")!);
    expect(within(first).getByText("已返回的公开依据")).toBeVisible();
    expect(within(first).getByText("查询了产品资料")).toBeVisible();
    expect(screen.getByText("资料助手 → 全体")).toBeInTheDocument();
  });

  it.each(["parallel", "sequential", "debate"] as const)("labels actual work according to %s mode", (mode) => {
    render(<AgentTeamActivity records={[{ agentId: "a", name: "资料助手", round: 1, state: "running" }]} busy mode={mode} />);
    expect(screen.getByRole("list", { name: "正在工作的 Agent" })).toHaveTextContent(mode === "debate" ? "开始工作" : "正在工作");
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    expect(screen.getByText(`第 1 轮 · ${mode === "debate" ? "分析观点" : "处理任务"}`)).toBeInTheDocument();
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

  it("shows unfinished records as stopped once the request ends without counting them as completed", () => {
    const { rerender } = render(<AgentTeamActivity records={[{ agentId: "a", name: "资料助手", round: 1, state: "running" }]} busy />);
    expect(screen.getByRole("status")).toHaveTextContent("1 运行中 · 0 完成");
    rerender(<AgentTeamActivity records={[{ agentId: "a", name: "资料助手", round: 1, state: "running" }]} busy={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("0 运行中 · 0 完成 · 1 已停止");
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    expect(screen.getAllByText("已停止")).toHaveLength(2);
  });

  it("shows who started work while collapsed and hides active rows when all members finish", () => {
    const record: AgentProgress = { agentId: "doudou", name: "Doudou", avatarUrl: "/api/avatars/doudou", round: 1, state: "running" };
    const { rerender } = render(<AgentTeamActivity records={[record]} busy />);
    const active = screen.getByRole("list", { name: "正在工作的 Agent" });
    expect(within(active).getByText("Doudou")).toBeInTheDocument();
    expect(within(active).getByText("开始工作")).toBeInTheDocument();
    expect(active.querySelector("img")).toHaveAttribute("src", "/api/avatars/doudou");
    expect(screen.getByRole("button", { name: "协作 Agent" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("第 1 轮 · 分析观点")).not.toBeInTheDocument();
    rerender(<AgentTeamActivity records={[{ ...record, state: "completed" }]} busy={false} />);
    expect(screen.queryByRole("list", { name: "正在工作的 Agent" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 运行中 · 1 完成");
  });

  it("expands real text from both saved rounds and renders the supplied avatar", () => {
    render(<AgentTeamActivity records={[
      { agentId: "a", name: "资料助手", avatarUrl: "/api/avatars/a", round: 1, state: "completed", text: "第一轮：资料有两处缺口。" },
      { agentId: "a", name: "资料助手", round: 2, state: "completed", text: "第二轮：已复查，建议标明这两处缺口。" },
    ]} busy={false} />);
    expect(screen.queryByRole("list", { name: "协作成员进度" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    expect(screen.getByRole("button", { name: "协作 Agent" })).toHaveAttribute("aria-expanded", "true");
    const rounds = screen.getByText("第 1 轮 · 分析观点").closest("details")!;
    const response = screen.getByText("第 2 轮 · 相互回应").closest("details")!;
    fireEvent.click(rounds.querySelector("summary")!);
    fireEvent.click(response.querySelector("summary")!);
    expect(rounds).toHaveAttribute("open");
    expect(response).toHaveAttribute("open");
    expect(within(rounds).getByText("第一轮：资料有两处缺口。")).toBeVisible();
    expect(within(response).getByText("第二轮：已复查，建议标明这两处缺口。")).toBeVisible();
    expect(screen.getByText("资料助手").closest("li")?.querySelector("img")).toHaveAttribute("src", "/api/avatars/a");
    expect(screen.getByRole("status")).toHaveTextContent("0 运行中 · 1 完成");
  });

  it("retains previously supplied real text when a terminal update has no new text", () => {
    render(<AgentTeamActivity records={[
      { agentId: "a", name: "资料助手", round: 1, state: "running", text: "已收到的分析片段" },
      { agentId: "a", name: "资料助手", round: 1, state: "failed" },
    ]} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "协作 Agent" }));
    expect(screen.getByRole("status")).toHaveTextContent("0 运行中 · 0 完成 · 1 失败");
    const round = screen.getByText("第 1 轮 · 分析观点").closest("details")!;
    fireEvent.click(round.querySelector("summary")!);
    expect(within(round).getByText("已收到的分析片段")).toBeVisible();
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

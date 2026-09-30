import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FollowupView } from "./crm-views";
import { testCustomers, testFollowups } from "@/test/fixtures";
import { createFollowupViaApi, listFollowupsViaApi, updateFollowupStatusViaApi } from "@/lib/client/backend-api";
vi.mock("@/lib/client/backend-api", () => ({ createFollowupViaApi: vi.fn(), listFollowupsViaApi: vi.fn(), updateFollowupStatusViaApi: vi.fn() }));
beforeEach(() => { vi.mocked(listFollowupsViaApi).mockResolvedValue(testFollowups); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function show() { return render(<FollowupView customers={testCustomers} tasks={testFollowups} referenceDate="2026-09-09T12:00:00+08:00" timeZone="Asia/Shanghai" />); }
describe("persistent dated Todo UI", () => {
  it("shows date and weekday for today and each actual deadline", async () => {
    const { container } = show();
    expect(screen.getByTestId("followup-today")).toHaveTextContent("2026年9月9日星期三");
    await waitFor(() => expect(listFollowupsViaApi).toHaveBeenCalledOnce());
    for (const time of container.querySelectorAll("time")) { expect(time).toHaveAttribute("datetime"); expect(time.textContent).toMatch(/2026年.*星期/); }
  });
  it("does not falsely complete a task when the API fails", async () => {
    vi.mocked(updateFollowupStatusViaApi).mockRejectedValue(new Error("保存失败"));
    show(); await waitFor(() => expect(listFollowupsViaApi).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText(`完成 ${testFollowups[0].title}`));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByLabelText(`完成 ${testFollowups[0].title}`)).toHaveAttribute("aria-pressed", "false");
  });
  it("saves entered title, customer and datetime instead of a hardcoded task", async () => {
    const task = { ...testFollowups[0], id: "task-new", title: "真实待办" };
    vi.mocked(createFollowupViaApi).mockResolvedValue(task);
    show(); await waitFor(() => expect(listFollowupsViaApi).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    const form = within(screen.getByRole("dialog"));
    fireEvent.change(form.getByLabelText("任务标题"), { target: { value: "真实待办" } });
    fireEvent.change(form.getByLabelText("截止日期与时间"), { target: { value: "2026-09-10T15:30" } });
    fireEvent.click(form.getByRole("button", { name: "保存任务" }));
    await waitFor(() => expect(createFollowupViaApi).toHaveBeenCalledWith(expect.objectContaining({ title: "真实待办", customerId: testCustomers[0].id, dueAt: new Date("2026-09-10T15:30").toISOString() })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("完成 真实待办")).toBeInTheDocument();
  });
  it("refreshes using server state and handles an empty customer list", async () => {
    vi.mocked(listFollowupsViaApi).mockResolvedValue([]);
    render(<FollowupView customers={[]} tasks={[]} />);
    expect(screen.getByRole("button", { name: "新建任务" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("刷新待办"));
    await waitFor(() => expect(listFollowupsViaApi).toHaveBeenCalledTimes(2));
  });
});

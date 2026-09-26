import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCustomers, testFollowups } from "@/test/fixtures";
import { FollowupView } from "./crm-views";
import styles from "./crm-views.module.css";

const { listCalendarEvents, listCalendarPresence, sendCalendarHeartbeat, createCalendarEvent, updateCalendarEvent, updateCalendarMemberStatus, getCalendarIdentity, listFollowupsViaApi, updateFollowupStatusViaApi } = vi.hoisted(() => ({
  listCalendarEvents: vi.fn(),
  listCalendarPresence: vi.fn(),
  sendCalendarHeartbeat: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  updateCalendarMemberStatus: vi.fn(),
  getCalendarIdentity: vi.fn(),
  listFollowupsViaApi: vi.fn(),
  updateFollowupStatusViaApi: vi.fn(),
}));

vi.mock("@/lib/client/calendar-api", () => ({ listCalendarEvents, listCalendarPresence, sendCalendarHeartbeat, createCalendarEvent, updateCalendarEvent, updateCalendarMemberStatus, getCalendarIdentity }));
vi.mock("@/lib/client/calendar-connection", () => ({ usesSharedCalendarConnection: () => false, currentCalendarConnection: () => null, connectSharedCalendar: vi.fn(), disconnectSharedCalendar: vi.fn() }));
vi.mock("@/lib/client/backend-api", () => ({
  createCustomerViaApi: vi.fn(),
  createFollowupViaApi: vi.fn(),
  listFollowupsViaApi,
  updateFollowupStatusViaApi,
}));

const sharedFollowup = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "共享确认需求",
  description: "和团队确认项目数量",
  startAt: "2026-09-24T14:00:00.000Z",
  endAt: "2026-09-24T15:00:00.000Z",
  allDay: false,
  kind: "followup",
  status: "confirmed",
  participantEmails: ["owner@example.com", "sales@example.com"],
  createdById: "user-1",
  createdByEmail: "owner@example.com",
  createdByName: "销售负责人",
  updatedByName: "销售负责人",
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
  revision: "22222222-2222-4222-8222-222222222222",
} as const;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

getCalendarIdentity.mockResolvedValue({ id: "user-1", email: "owner@example.com", name: "销售负责人" });
listCalendarPresence.mockResolvedValue({ "owner@example.com": { name: "销售负责人", lastSeenAt: "2026-09-24T12:00:00.000Z", online: true } });
sendCalendarHeartbeat.mockResolvedValue(undefined);

describe("FollowupView collaboration calendar", () => {
  it("renders followups in the calendar and switches month, week, and day views", async () => {
    listFollowupsViaApi.mockResolvedValue(testFollowups);
    listCalendarEvents.mockResolvedValue([sharedFollowup]);
    render(<FollowupView customers={testCustomers} tasks={testFollowups} referenceDate="2026-09-24T12:00:00.000Z" timeZone="Asia/Shanghai" />);

    expect(await screen.findByTestId("collaboration-calendar")).toBeInTheDocument();
    expect(screen.getAllByText("共享确认需求").length).toBeGreaterThan(0);
    expect(screen.getByText("多人在线协作日历")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("正在加载共享日历…")).not.toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "周" })); });
    expect(screen.getByTestId("calendar-week-view")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "日" })); });
    expect(screen.queryByTestId("calendar-week-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-day-view")).toBeInTheDocument();
  });

  it("shows shared followup in the todo list and completes it through the calendar API", async () => {
    listFollowupsViaApi.mockResolvedValue([]);
    listCalendarEvents.mockResolvedValue([sharedFollowup]);
    updateCalendarEvent.mockResolvedValue({ ...sharedFollowup, status: "completed", revision: "33333333-3333-4333-8333-333333333333" });
    render(<FollowupView customers={[]} tasks={[]} referenceDate="2026-09-24T12:00:00.000Z" timeZone="Asia/Shanghai" />);

    expect(await screen.findByRole("button", { name: "完成 共享确认需求" })).toBeInTheDocument();
    const completeButton = screen.getByRole("button", { name: "完成 共享确认需求" });
    fireEvent.click(completeButton);
    await waitFor(() => expect(updateCalendarEvent).toHaveBeenCalledWith(sharedFollowup.id, { status: "completed", revision: sharedFollowup.revision }));
  });

  it("opens a collaborative event form without requiring an existing customer", async () => {
    listFollowupsViaApi.mockResolvedValue([]);
    listCalendarEvents.mockResolvedValue([]);
    createCalendarEvent.mockResolvedValue(sharedFollowup);
    render(<FollowupView customers={[]} tasks={[]} referenceDate="2026-09-24T12:00:00.000Z" timeZone="Asia/Shanghai" />);

    await waitFor(() => expect(screen.queryByText("正在加载共享日历…")).not.toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: /新建协作事件|安排/ })[0]); });
    expect(screen.getByRole("dialog", { name: "新建协作日历事件" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("事件类型"), { target: { value: "followup" } });
    expect(screen.getByText(/无需先创建客户档案/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "确认方案" } });
    fireEvent.change(screen.getByLabelText("开始"), { target: { value: "2026-09-25T10:00" } });
    fireEvent.change(screen.getByLabelText("结束"), { target: { value: "2026-09-25T11:00" } });
    fireEvent.change(screen.getByLabelText("参与者邮箱"), { target: { value: "sales@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "创建事件" }));
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ title: "确认方案", kind: "followup", participantEmails: ["sales@example.com"] })));
  });

  it("opens a dedicated detail page when a shared event bar is selected", async () => {
    listFollowupsViaApi.mockResolvedValue([]);
    listCalendarEvents.mockResolvedValue([sharedFollowup]);
    getCalendarIdentity.mockResolvedValue({ id: "sales-id", email: "sales@example.com", name: "销售同事" });
    render(<FollowupView customers={[]} tasks={[]} referenceDate="2026-09-24T12:00:00.000Z" timeZone="Asia/Shanghai" />);
    const eventLink = await screen.findByRole("link", { name: /共享确认需求.*由销售负责人创建.*打开详情/ });
    expect(eventLink).toHaveAttribute("href", `/calendar/events/${sharedFollowup.id}`);
  });

  it("colors calendar bars by event status and keeps the status readable", async () => {
    listFollowupsViaApi.mockResolvedValue([]);
    listCalendarEvents.mockResolvedValue([
      sharedFollowup,
      { ...sharedFollowup, id: "55555555-5555-4555-8555-555555555555", title: "已完成的会议", status: "completed" },
      { ...sharedFollowup, id: "66666666-6666-4666-8666-666666666666", title: "已取消的会议", status: "cancelled" },
    ]);
    render(<FollowupView customers={[]} tasks={[]} referenceDate="2026-09-24T12:00:00.000Z" timeZone="Asia/Shanghai" />);

    const confirmed = (await screen.findAllByRole("link", { name: /共享确认需求，跟进，已确认.*打开详情/ }))[0];
    const completed = screen.getAllByRole("link", { name: /已完成的会议，跟进，已完成.*打开详情/ })[0];
    const cancelled = screen.getAllByRole("link", { name: /已取消的会议，跟进，已取消.*打开详情/ })[0];
    expect(confirmed).toHaveClass(styles.calendarEventConfirmed);
    expect(completed).toHaveClass(styles.calendarEventCompleted);
    expect(cancelled).toHaveClass(styles.calendarEventCancelled);
    expect(screen.getByText(/事件状态：/)).toBeInTheDocument();
  });

  it("adds a new meeting to the follow-up todo list even when its date is not today", async () => {
    listFollowupsViaApi.mockResolvedValue([]);
    const meeting = { ...sharedFollowup, id: "44444444-4444-4444-8444-444444444444", title: "项目会议", kind: "meeting", startAt: "2026-10-05T14:00:00.000Z", endAt: "2026-10-05T15:00:00.000Z" };
    let stored: typeof meeting[] = [];
    listCalendarEvents.mockImplementation(async () => stored);
    createCalendarEvent.mockImplementation(async () => { stored = [meeting]; return meeting; });
    render(<FollowupView customers={[]} tasks={[]} referenceDate="2026-09-24T12:00:00.000Z" timeZone="Asia/Shanghai" />);
    await waitFor(() => expect(screen.queryByText("正在加载共享日历…")).not.toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "今天" }).at(-1)!);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "新建协作事件" })); });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "项目会议" } });
    fireEvent.change(screen.getByLabelText("开始"), { target: { value: "2026-10-05T10:00" } });
    fireEvent.change(screen.getByLabelText("结束"), { target: { value: "2026-10-05T11:00" } });
    fireEvent.click(screen.getByRole("button", { name: "创建事件" }));
    expect(await screen.findByRole("button", { name: "完成 项目会议" })).toBeInTheDocument();
    expect(screen.getByText("协作会议")).toBeInTheDocument();
  });
});

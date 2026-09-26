import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarEventDetails } from "./calendar-event-details";

const { getCalendarEvent, getCalendarIdentity, listCalendarPresence, sendCalendarHeartbeat, updateCalendarEvent, updateCalendarMemberStatus, deleteCalendarEvent, push } = vi.hoisted(() => ({
  getCalendarEvent: vi.fn(), getCalendarIdentity: vi.fn(), listCalendarPresence: vi.fn(), sendCalendarHeartbeat: vi.fn(), updateCalendarEvent: vi.fn(), updateCalendarMemberStatus: vi.fn(), deleteCalendarEvent: vi.fn(), push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/client/calendar-api", () => ({ getCalendarEvent, getCalendarIdentity, listCalendarPresence, sendCalendarHeartbeat, updateCalendarEvent, updateCalendarMemberStatus, deleteCalendarEvent }));
vi.mock("@/lib/client/calendar-connection", () => ({ usesSharedCalendarConnection: () => false, currentCalendarConnection: () => null, connectSharedCalendar: vi.fn() }));

const event = {
  id: "11111111-1111-4111-8111-111111111111", title: "确认报价", description: "核对明细", startAt: "2026-09-25T14:00:00.000Z", endAt: "2026-09-25T15:00:00.000Z", allDay: false, kind: "followup", status: "confirmed", participantEmails: ["bob@example.com"], memberStatuses: { "alice@example.com": "pending", "bob@example.com": "pending" }, memberNames: { "alice@example.com": "Alice" }, createdById: "alice-id", createdByEmail: "alice@example.com", createdByName: "Alice", updatedByName: "Alice", createdAt: "2026-09-24T12:00:00.000Z", updatedAt: "2026-09-24T12:00:00.000Z", revision: "22222222-2222-4222-8222-222222222222",
} as const;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("calendar event detail page", () => {
  it("shows identity and presence, and confirms deletion by the creator", async () => {
    getCalendarEvent.mockResolvedValue(event);
    getCalendarIdentity.mockResolvedValue({ id: "alice-id", email: "alice@example.com", name: "Alice" });
    listCalendarPresence.mockResolvedValue({ "bob@example.com": { name: "Bob", lastSeenAt: "2026-09-24T12:00:00.000Z", online: true } });
    sendCalendarHeartbeat.mockResolvedValue(undefined);
    deleteCalendarEvent.mockResolvedValue({ id: event.id });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CalendarEventDetails eventId={event.id} />);
    expect(await screen.findByRole("heading", { name: "确认报价" })).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("在线")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除事件" }));
    await waitFor(() => expect(deleteCalendarEvent).toHaveBeenCalledWith(event.id, event.revision));
    expect(push).toHaveBeenCalledWith("/?followup=1");
  });

  it("lets an invitee change only their own participation status", async () => {
    getCalendarEvent.mockResolvedValue(event);
    getCalendarIdentity.mockResolvedValue({ id: "bob-id", email: "bob@example.com", name: "Bob" });
    listCalendarPresence.mockResolvedValue({});
    sendCalendarHeartbeat.mockResolvedValue(undefined);
    updateCalendarMemberStatus.mockResolvedValue({ ...event, memberStatuses: { ...event.memberStatuses, "bob@example.com": "in_progress" }, memberNames: { ...event.memberNames, "bob@example.com": "Bob" }, revision: "33333333-3333-4333-8333-333333333333" });
    render(<CalendarEventDetails eventId={event.id} />);
    const select = await screen.findByLabelText("我的参与状态");
    expect(screen.queryByRole("button", { name: "删除事件" })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "in_progress" } });
    await waitFor(() => expect(updateCalendarMemberStatus).toHaveBeenCalledWith(event.id, event.revision, "in_progress"));
  });
});

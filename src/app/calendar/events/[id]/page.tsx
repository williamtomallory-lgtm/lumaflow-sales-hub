import { CalendarEventDetails } from "@/components/calendar-event-details";

export default async function CalendarEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CalendarEventDetails eventId={id} />;
}

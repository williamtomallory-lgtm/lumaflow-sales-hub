import { CalendarFollowupDetails } from "@/components/calendar-followup-details";

export default async function CalendarFollowupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CalendarFollowupDetails taskId={id} />;
}

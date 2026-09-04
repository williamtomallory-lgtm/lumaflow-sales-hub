import { getDataSnapshot } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getDataSnapshot();
  return Response.json({
    source: data.source,
    counts: {
      products: data.products.length,
      knowledgeEntries: data.knowledgeEntries.length,
      customers: data.customers.length,
      followupTasks: data.followupTasks.length,
      quoteHistory: data.quoteHistory.length,
      adminUsers: data.adminUsers.length,
    },
  });
}

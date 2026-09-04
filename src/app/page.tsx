import { SalesHub } from "@/components/sales-hub";
import { getDataSnapshot } from "@/lib/server/data-repository";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialData = await getDataSnapshot();
  return <SalesHub initialData={initialData} />;
}

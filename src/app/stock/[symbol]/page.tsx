import { Desk } from "@/components/desk";

export const dynamic = "force-dynamic";

export default async function StockPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;
  return <Desk symbol={decodeURIComponent(symbol).toUpperCase()} />;
}

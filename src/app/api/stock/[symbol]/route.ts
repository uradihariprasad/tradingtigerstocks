import { getEngine } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await ctx.params;
  const clean = String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9&\-]/g, "");
  if (!clean) return Response.json({ error: "missing symbol" }, { status: 400 });
  const engine = getEngine();
  if (!engine.started) engine.start();
  const detail = await engine.getStockDetail(clean).catch(() => null);
  if (!detail) return Response.json({ error: "symbol not in F&O universe" }, { status: 404 });
  return Response.json(detail, { headers: { "Cache-Control": "no-store" } });
}

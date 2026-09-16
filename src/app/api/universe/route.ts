import { getEngine } from "@/lib/engine";
import { getUniverseMeta } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  const engine = getEngine();
  const meta = await getUniverseMeta();
  return Response.json({
    count: engine.universe.length || (meta?.count ?? 0),
    refreshedAt: meta?.refreshedAt ?? null,
    source: meta?.source ?? null,
    error: meta?.error ?? null,
    symbols: engine.universe.slice(0, 500).map((u) => u.symbol),
  });
}

/** POST — force refresh from the official Upstox instrument master. */
export async function POST() {
  const engine = getEngine();
  const res = await engine.loadUniverse(true);
  const meta = await getUniverseMeta();
  return Response.json({
    ok: !res.error,
    count: res.count,
    refreshedAt: meta?.refreshedAt ?? null,
    error: res.error ?? null,
  });
}

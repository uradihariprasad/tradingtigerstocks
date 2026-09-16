import { getEngine } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** GET — latest published scan payload (never blocks on a scan cycle). */
export async function GET() {
  const engine = getEngine();
  if (!engine.started) engine.start();
  if (!engine.payload) engine.triggerScan(); // background; payload arrives on next poll
  return Response.json(
    engine.payload ?? { meta: null, rows: [], trades: [], warming: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** POST — kick a scan cycle in the background, return immediately. */
export async function POST() {
  const engine = getEngine();
  if (!engine.started) engine.start();
  engine.triggerScan();
  return Response.json({ ok: true, scanning: engine.scanning, payload: engine.payload });
}

import { getEngine } from "@/lib/engine";
import { getConfig } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = await getConfig();
  return Response.json({ config: cfg });
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const engine = getEngine();
  const merged = await engine.applyConfig(body);
  return Response.json({ ok: true, config: merged });
}

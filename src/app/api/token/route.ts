import { getEngine } from "@/lib/engine";
import { getSetting } from "@/lib/repo";

export const dynamic = "force-dynamic";

/** GET — token presence (masked). The raw token is never returned. */
export async function GET() {
  try {
    const engine = getEngine();
    const user = await getSetting<string>("upstox_token_user");
    const token = await getSetting<string>("upstox_token");
    const configured = typeof token === "string" && token.length > 10;
    return Response.json({
      configured,
      user: configured ? (user ?? null) : null,
      masked: configured ? `••••${token.slice(-4)}` : null,
      active: configured ? engine.tokenUser != null || user != null : false,
    });
  } catch (e) {
    return Response.json({ configured: false, user: null, masked: null, active: false, error: (e as Error).message });
  }
}

/** POST — set + validate a new Upstox access token. Always responds with JSON. */
export async function POST(req: Request) {
  try {
    let body: { token?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token.length < 20) {
      return Response.json({ ok: false, error: "token looks too short" }, { status: 400 });
    }
    const engine = getEngine();
    if (!engine.started) engine.start();
    const res = await engine.setToken(token);
    if (!res.ok) {
      return Response.json({ ok: false, error: res.error ?? "validation failed" }, { status: 401 });
    }
    return Response.json({ ok: true, user: res.user, persisted: res.persisted === true });
  } catch (e) {
    return Response.json(
      { ok: false, error: `token handler failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}

/** DELETE — remove the stored token. */
export async function DELETE() {
  try {
    const engine = getEngine();
    await engine.clearToken();
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

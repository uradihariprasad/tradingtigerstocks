/** Persistence helpers (server-side only). All functions fail soft — the
 *  scanner must keep working even if a table is briefly unavailable. */

import { db } from "@/db";
import { instruments, oiBaselines, scanSnapshots, settings, universeMeta } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import type { UniverseEntry } from "@/lib/upstox";
import { mergeConfig, type ScannerConfig } from "@/lib/config";
import { ensureSchema } from "@/lib/bootstrap";

export async function getSetting<T>(key: string): Promise<T | null> {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return rows.length ? (rows[0].value as T) : null;
  } catch {
    return null;
  }
}

export async function setSetting(key: string, value: unknown): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await db
        .insert(settings)
        .values({ key, value: value as never, updatedAt: new Date() })
        .onConflictDoUpdate({ target: settings.key, set: { value: value as never, updatedAt: new Date() } });
      return true;
    } catch {
      // first failure may be a missing table in a freshly bootstrapped DB
      await ensureSchema().catch(() => false);
    }
  }
  return false;
}

export async function deleteSetting(key: string): Promise<boolean> {
  try {
    await db.delete(settings).where(eq(settings.key, key));
    return true;
  } catch {
    return false;
  }
}

export async function getToken(): Promise<string | null> {
  let v = await getSetting<string>("upstox_token");
  if (v == null) {
    // possible missing table in a fresh environment — heal and retry once
    try {
      await ensureSchema();
      v = await getSetting<string>("upstox_token");
    } catch {
      /* ignore */
    }
  }
  return typeof v === "string" && v.length > 10 ? v : null;
}

export async function getConfig(): Promise<ScannerConfig> {
  const raw = await getSetting<unknown>("scanner_config");
  return mergeConfig(raw);
}

export async function saveConfig(raw: unknown): Promise<ScannerConfig> {
  const merged = mergeConfig(raw);
  await setSetting("scanner_config", merged);
  return merged;
}

export async function loadUniverse(): Promise<UniverseEntry[]> {
  try {
    const rows = await db.select().from(instruments).where(eq(instruments.active, true));
    return rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      eqKey: r.eqKey,
      eqToken: r.eqToken,
      futKey: r.futKey,
      futSymbol: r.futSymbol,
      futExpiry: r.futExpiry,
      lotSize: r.lotSize,
      tickSize: r.tickSize,
    }));
  } catch {
    return [];
  }
}

export async function replaceUniverse(entries: UniverseEntry[], source: string): Promise<void> {
  try {
    await db.delete(instruments);
    // chunked inserts
    const CHUNK = 100;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      if (slice.length === 0) continue;
      await db.insert(instruments).values(
        slice.map((e) => ({
          symbol: e.symbol,
          name: e.name,
          eqKey: e.eqKey,
          eqToken: e.eqToken,
          futKey: e.futKey,
          futSymbol: e.futSymbol,
          futExpiry: e.futExpiry,
          lotSize: e.lotSize,
          tickSize: e.tickSize,
          isIndex: false,
          active: true,
          updatedAt: new Date(),
        })),
      );
    }
    await db
      .insert(universeMeta)
      .values({ id: 1, count: entries.length, source, refreshedAt: new Date(), error: null })
      .onConflictDoUpdate({
        target: universeMeta.id,
        set: { count: entries.length, source, refreshedAt: new Date(), error: null },
      });
  } catch (e) {
    try {
      await db
        .insert(universeMeta)
        .values({ id: 1, count: 0, source, refreshedAt: new Date(), error: (e as Error).message })
        .onConflictDoUpdate({ target: universeMeta.id, set: { error: (e as Error).message } });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export async function getUniverseMeta(): Promise<{
  count: number;
  refreshedAt: string | null;
  source: string | null;
  error: string | null;
} | null> {
  try {
    const rows = await db.select().from(universeMeta).where(eq(universeMeta.id, 1)).limit(1);
    if (!rows.length) return null;
    return {
      count: rows[0].count,
      refreshedAt: rows[0].refreshedAt?.toISOString() ?? null,
      source: rows[0].source,
      error: rows[0].error,
    };
  } catch {
    return null;
  }
}

export async function persistSnapshot(payload: unknown, durationMs: number, candidateCount: number): Promise<void> {
  try {
    await db.insert(scanSnapshots).values({
      payload: payload as never,
      durationMs,
      candidateCount,
      createdAt: new Date(),
    });
    // keep only the last 400 snapshots (table stays small)
    await db.execute(
      sql`DELETE FROM scan_snapshots WHERE id < (SELECT COALESCE(MAX(id),0) - 400 FROM scan_snapshots)`,
    );
  } catch {
    /* ignore */
  }
}

export async function loadLatestSnapshot<T>(): Promise<T | null> {
  try {
    const rows = await db.select().from(scanSnapshots).orderBy(desc(scanSnapshots.id)).limit(1);
    return rows.length ? (rows[0].payload as T) : null;
  } catch {
    return null;
  }
}

export async function getOiBaseline(
  day: string,
  symbol: string,
  expiry: string,
): Promise<Map<number, { ce: number | null; pe: number | null }> | null> {
  try {
    const rows = await db
      .select()
      .from(oiBaselines)
      .where(eq(oiBaselines.day, day));
    const map = new Map<number, { ce: number | null; pe: number | null }>();
    for (const r of rows) {
      if (r.symbol !== symbol || r.expiry !== expiry) continue;
      map.set(r.strike, { ce: r.ceOi, pe: r.peOi });
    }
    return map.size ? map : null;
  } catch {
    return null;
  }
}

export async function getFutOiBaseline(day: string, symbol: string): Promise<number | null> {
  try {
    const rows = await db.select().from(oiBaselines).where(eq(oiBaselines.day, day));
    for (const r of rows) {
      if (r.symbol === symbol && r.expiry === "__FUT__") return r.futOi;
    }
    return null;
  } catch {
    return null;
  }
}

export async function ensureOiBaseline(
  day: string,
  symbol: string,
  expiry: string,
  rows: Array<{ strike: number; ce: number | null; pe: number | null }>,
): Promise<void> {
  try {
    const existing = await getOiBaseline(day, symbol, expiry);
    if (existing) return;
    const CHUNK = 60;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      if (!slice.length) continue;
      await db.insert(oiBaselines).values(
        slice.map((r) => ({
          day,
          symbol,
          expiry,
          strike: r.strike,
          ceOi: r.ce,
          peOi: r.pe,
          capturedAt: new Date(),
        })),
      );
    }
  } catch {
    /* ignore */
  }
}

export async function ensureFutOiBaseline(day: string, symbol: string, oi: number): Promise<void> {
  try {
    const existing = await getFutOiBaseline(day, symbol);
    if (existing != null) return;
    await db.insert(oiBaselines).values({
      day,
      symbol,
      expiry: "__FUT__",
      strike: 0,
      futOi: oi,
      capturedAt: new Date(),
    });
  } catch {
    /* ignore */
  }
}

/**
 * Idempotent schema bootstrap — runs once at server startup so the app never
 * depends on `drizzle-kit push` having been executed in this environment.
 * All statements are CREATE TABLE IF NOT EXISTS and safe to re-run.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
     key text PRIMARY KEY,
     value jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS instruments (
     id serial PRIMARY KEY,
     symbol text NOT NULL,
     name text,
     eq_key text NOT NULL,
     eq_token text,
     fut_key text,
     fut_symbol text,
     fut_expiry text,
     lot_size integer,
     tick_size real,
     is_index boolean NOT NULL DEFAULT false,
     active boolean NOT NULL DEFAULT true,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS universe_meta (
     id integer PRIMARY KEY,
     count integer NOT NULL DEFAULT 0,
     source text,
     refreshed_at timestamptz,
     error text
   )`,
  `CREATE TABLE IF NOT EXISTS scan_snapshots (
     id serial PRIMARY KEY,
     created_at timestamptz NOT NULL DEFAULT now(),
     duration_ms integer,
     candidate_count integer NOT NULL DEFAULT 0,
     payload jsonb NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS oi_baselines (
     id serial PRIMARY KEY,
     day text NOT NULL,
     symbol text NOT NULL,
     expiry text NOT NULL,
     strike real NOT NULL,
     ce_oi integer,
     pe_oi integer,
     fut_oi integer,
     captured_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS oi_baselines_day_idx ON oi_baselines (day)`,
  `CREATE INDEX IF NOT EXISTS scan_snapshots_id_idx ON scan_snapshots (id)`,
];

const g = globalThis as unknown as { __schemaEnsured?: Promise<boolean> };

export function ensureSchema(): Promise<boolean> {
  if (!g.__schemaEnsured) {
    g.__schemaEnsured = (async () => {
      try {
        for (const stmt of STATEMENTS) {
          await db.execute(sql.raw(stmt));
        }
        return true;
      } catch {
        // retry on next call if the pool was briefly unavailable
        delete g.__schemaEnsured;
        return false;
      }
    })();
  }
  return g.__schemaEnsured;
}

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Key/value settings store (server-side only).
 *  - "upstox_token"   -> the user's Upstox access token (NEVER sent to the browser)
 *  - "scanner_config" -> configurable weights & thresholds
 *  - misc engine bookkeeping keys
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * NSE F&O universe cached locally so we never rely on a hard-coded list.
 * Refreshed from the official Upstox instrument master file.
 */
export const instruments = pgTable("instruments", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(), // equity trading symbol  e.g. RELIANCE
  name: text("name"), // full instrument name
  eqKey: text("eq_key").notNull(), // NSE_EQ|INE002A01018
  eqToken: text("eq_token"),
  futKey: text("fut_key"), // nearest-expiry stock future (current series)
  futSymbol: text("fut_symbol"),
  futExpiry: text("fut_expiry"), // YYYY-MM-DD as provided by Upstox
  lotSize: integer("lot_size"),
  tickSize: real("tick_size"),
  isIndex: boolean("is_index").notNull().default(false),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Meta row describing when the universe was last refreshed.
 */
export const universeMeta = pgTable("universe_meta", {
  id: integer("id").primaryKey(), // always 1
  count: integer("count").notNull().default(0),
  source: text("source"),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
  error: text("error"),
});

/**
 * Scan snapshots — the full published payload the dashboard renders.
 * Written after every completed scan so state survives restarts.
 */
export const scanSnapshots = pgTable("scan_snapshots", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  durationMs: integer("duration_ms"),
  candidateCount: integer("candidate_count").notNull().default(0),
  payload: jsonb("payload").notNull(),
});

/**
 * Intraday option-OI baseline (session start) per strike.
 * OI change is computed as current OI minus this baseline,
 * strictly from real Upstox values observed during the session.
 */
export const oiBaselines = pgTable("oi_baselines", {
  id: serial("id").primaryKey(),
  day: text("day").notNull(), // YYYY-MM-DD (IST)
  symbol: text("symbol").notNull(),
  expiry: text("expiry").notNull(),
  strike: real("strike").notNull(),
  ceOi: integer("ce_oi"),
  peOi: integer("pe_oi"),
  futOi: integer("fut_oi"),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

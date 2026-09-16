/**
 * Upstox API client (server-side only).
 *
 * Official endpoints used (Upstox API v2):
 *  - GET /v2/user/profile                                     (token validation)
 *  - GET /v2/market-quote/quotes?instrument_key=…             (batch quotes, ≤500 keys)
 *  - GET /v2/historical-candle/{key}/{unit}/{interval}/{to}/{from}
 *  - GET /v2/historical-candle/intraday/{key}/{unit}/{interval}
 *  - GET /v2/option/contract?instrument_key=…                 (option contracts / expiries)
 *  - GET /v2/option/chain?instrument_key=…&expiry_date=…      (option chain w/ OI)
 *  - Instrument master file (public, no auth):
 *      https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz
 *
 * The access token never leaves the server and is never logged.
 */

const API = "https://api.upstox.com/v2";

// ---------------------------------------------------------------- types

export interface Candle {
  t: number; // epoch ms (ascending order guaranteed by normalize)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  oi: number | null;
}

export interface Quote {
  key: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null; // `ohlc.close` in market-quote = previous close
  volume: number | null;
  averagePrice: number | null; // Upstox average traded price (session VWAP basis)
  oi: number | null;
  lastQty: number | null;
  buyQty: number | null;
  sellQty: number | null;
  lowerCircuit: number | null;
  upperCircuit: number | null;
  ts: number | null; // exchange timestamp (ms)
  /** aggregated 5-level depth (quantities) — null when depth is not provided */
  bidDepth: number | null;
  askDepth: number | null;
  /** aggregated order counts across depth levels */
  bidOrders: number | null;
  askOrders: number | null;
}

export interface ChainStrike {
  strike: number;
  ceOi: number | null;
  peOi: number | null;
  ceVol: number | null;
  peVol: number | null;
  ceLtp: number | null;
  peLtp: number | null;
  ceIV: number | null;
  peIV: number | null;
  /** previous OI as reported by Upstox (`market_data.prev_oi`) */
  cePrevOi: number | null;
  pePrevOi: number | null;
  /** ΔOI = oi − prev_oi from real Upstox values; null when prev_oi is absent */
  ceOiChg?: number | null;
  peOiChg?: number | null;
  isAtm?: boolean;
}

export interface InstrumentRow {
  segment: string;
  name?: string;
  exchange?: string;
  expiry?: string | number;
  strike_price?: number;
  lot_size?: number;
  tick_size?: number;
  instrument_type?: string;
  underlying_symbol?: string;
  underlying_key?: string;
  underlying_type?: string;
  asset_type?: string;
  trading_symbol?: string;
  exchange_token?: string | number;
  instrument_key: string;
}

export interface UniverseEntry {
  symbol: string;
  name: string | null;
  eqKey: string;
  eqToken: string | null;
  futKey: string | null;
  futSymbol: string | null;
  futExpiry: string | null;
  lotSize: number | null;
  tickSize: number | null;
}

export class UpstoxError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- rate limiting

export class RateLimiter {
  private tokens: number;
  private last: number = Date.now();
  private queue: Array<() => void> = [];

  constructor(private readonly perSec: number) {
    this.tokens = perSec;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    await new Promise<void>((res) => this.queue.push(res));
    this.tokens = 0;
    this.last = Date.now();
  }

  private refill() {
    const now = Date.now();
    const add = ((now - this.last) / 1000) * this.perSec;
    if (add >= 1) {
      this.tokens = Math.min(this.perSec, this.tokens + add);
      this.last = now;
      const n = Math.floor(this.tokens);
      for (let i = 0; i < n && this.queue.length; i++) {
        this.tokens -= 1;
        this.queue.shift()!();
      }
    }
    if (this.queue.length) {
      setTimeout(() => this.refill(), Math.max(50, Math.floor(1000 / this.perSec)));
    }
  }
}

/** Run async tasks with bounded concurrency. Results keep input order; failures -> null. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | null>> {
  const out: Array<R | null> = new Array(items.length).fill(null);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch {
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- client

export class UpstoxClient {
  constructor(
    private readonly getToken: () => string | null,
    private readonly limiter: RateLimiter,
  ) {}

  private async request<T>(
    path: string,
    opts: { params?: Record<string, string>; rawQuery?: string; auth?: boolean } = {},
    attempt = 0,
  ): Promise<T> {
    // serialize ONCE — never pass pre-encoded strings through URLSearchParams
    let qs = opts.rawQuery ?? "";
    if (!qs && opts.params) {
      qs = Object.entries(opts.params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
    }
    const url = `${API}${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.auth !== false) {
      const token = this.getToken();
      if (!token) throw new UpstoxError("Upstox access token not configured", 401);
      headers.Authorization = `Bearer ${token}`;
    }
    await this.limiter.acquire();
    let res: Response;
    try {
      res = await fetch(url, { headers, cache: "no-store" });
    } catch (e) {
      if (attempt < 2) return this.request<T>(path, opts, attempt + 1);
      throw new UpstoxError(`network error: ${(e as Error).message}`, null);
    }
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(5000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      return this.request<T>(path, opts, attempt + 1);
    }
    const ctype = res.headers.get("content-type") ?? "";
    const text = await res.text();
    interface Envelope {
      status?: string;
      data?: T;
      errors?: Array<{ message?: string }>;
    }
    let body: Envelope | null = null;
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        body = JSON.parse(trimmed) as Envelope;
      } catch {
        body = null;
      }
    }
    if (body == null) {
      // API/WAF returned non-JSON (HTML error page, gateway block, etc.)
      const hint = text
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      throw new UpstoxError(
        `Upstox returned a non-JSON response for ${path} (HTTP ${res.status}, ${ctype || "unknown content-type"})${hint ? `: ${hint}` : ""}`,
        res.status,
      );
    }
    if (!res.ok) {
      const apiMsg = body.errors?.[0]?.message;
      throw new UpstoxError(apiMsg ?? `Upstox HTTP ${res.status} for ${path}`, res.status);
    }
    if (body.status === "error") {
      throw new UpstoxError(body.errors?.[0]?.message ?? `Upstox error for ${path}`, res.status);
    }
    return (body.data ?? body) as T;
  }

  // ------------------------------------------------------------ auth

  async validateToken(): Promise<{ name: string | null }> {
    const d = await this.request<{ user_name?: string }>("/user/profile");
    return { name: d?.user_name ?? null };
  }

  // ------------------------------------------------------------ quotes

  async quotes(keys: string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    const CHUNK = 450;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK).map(encodeURIComponent).join(",");
      const data = await this.request<Record<string, RawQuote>>(
        "/market-quote/quotes",
        { rawQuery: `instrument_key=${chunk}` },
      );
      for (const [k, q] of Object.entries(data ?? {})) {
        const quote = normalizeQuote(k, q);
        // Upstox keys the response map as "EXCHANGE:SYMBOL";
        // `instrument_token` inside carries the canonical "NSE_EQ|…" key.
        out.set(k, quote);
        if (quote.key && quote.key !== k) out.set(quote.key, quote);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ candles
  // Upstox candle routes: /v2/historical-candle[/intraday]/{key}/{interval}[/to/from]
  // with interval ∈ 1minute | 30minute | day | week | month (intraday: 1minute / 30minute)

  /** Intraday (today) candles for one instrument. Ascending by time. */
  async intradayCandles(key: string, interval: "1minute" | "30minute" = "1minute"): Promise<Candle[]> {
    const data = await this.request<{ candles: RawCandle[] }>(
      `/historical-candle/intraday/${encodeURIComponent(key)}/${interval}`,
    );
    return normalizeCandles(data?.candles ?? []);
  }

  /** Historical daily candles in [fromISO, toISO]. */
  async dailyCandles(key: string, fromISO: string, toISO: string): Promise<Candle[]> {
    const data = await this.request<{ candles: RawCandle[] }>(
      `/historical-candle/${encodeURIComponent(key)}/day/${toISO}/${fromISO}`,
    );
    return normalizeCandles(data?.candles ?? []);
  }

  /** Historical 1-minute candles across a date range (for RVOL baseline). */
  async minuteCandles(key: string, fromISO: string, toISO: string): Promise<Candle[]> {
    const data = await this.request<{ candles: RawCandle[] }>(
      `/historical-candle/${encodeURIComponent(key)}/1minute/${toISO}/${fromISO}`,
    );
    return normalizeCandles(data?.candles ?? []);
  }

  // ------------------------------------------------------------ options

  /** Earliest upcoming option expiry for an underlying (YYYY-MM-DD) or null. */
  async nearestExpiry(underlyingKey: string): Promise<string | null> {
    const data = await this.request<Array<{ expiry?: number | string }>>(
      "/option/contract",
      { rawQuery: `instrument_key=${encodeURIComponent(underlyingKey)}` },
    );
    const expiries = new Set<string>();
    for (const c of data ?? []) {
      if (c.expiry == null) continue;
      const d = typeof c.expiry === "number" ? new Date(c.expiry) : new Date(String(c.expiry));
      if (Number.isNaN(d.getTime())) continue;
      expiries.add(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate(),
        ).padStart(2, "0")}`,
      );
    }
    const now = Date.now() - 24 * 3600 * 1000;
    const sorted = [...expiries].filter((e) => new Date(`${e}T23:59:59+05:30`).getTime() >= now).sort();
    return sorted[0] ?? null;
  }

  /** Option chain for an underlying + expiry. */
  async optionChain(underlyingKey: string, expiry: string): Promise<ChainStrike[]> {
    const data = await this.request<Array<RawChainItem>>("/option/chain", {
      rawQuery: `instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${encodeURIComponent(expiry)}`,
    });
    const strikes: ChainStrike[] = [];
    for (const item of data ?? []) {
      const ce = item.call_options?.market_data;
      const pe = item.put_options?.market_data;
      const ceG = item.call_options?.option_greeks;
      const peG = item.put_options?.option_greeks;
      const ceOi = numOrNull(ce?.oi);
      const peOi = numOrNull(pe?.oi);
      const cePrevOi = numOrNull(ce?.prev_oi);
      const pePrevOi = numOrNull(pe?.prev_oi);
      strikes.push({
        strike: num(item.strike_price),
        ceOi,
        peOi,
        ceVol: numOrNull(ce?.volume),
        peVol: numOrNull(pe?.volume),
        ceLtp: numOrNull(ce?.ltp),
        peLtp: numOrNull(pe?.ltp),
        ceIV: numOrNull(ceG?.iv),
        peIV: numOrNull(peG?.iv),
        cePrevOi,
        pePrevOi,
        // real ΔOI straight from Upstox; N/A when the API omits prev_oi
        ceOiChg: ceOi != null && cePrevOi != null ? ceOi - cePrevOi : null,
        peOiChg: peOi != null && pePrevOi != null ? peOi - pePrevOi : null,
      });
    }
    return strikes.sort((a, b) => a.strike - b.strike);
  }
}

// ---------------------------------------------------------------- parsing helpers

type RawCandle = [string, number, number, number, number, number, number?];

function normalizeCandles(raw: RawCandle[]): Candle[] {
  const out: Candle[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const t = new Date(r[0]).getTime();
    const [o, h, l, c, v] = [r[1], r[2], r[3], r[4], r[5]];
    if (![t, o, h, l, c].every(Number.isFinite) || v == null || !Number.isFinite(v)) continue;
    out.push({ t, o, h, l, c, v, oi: typeof r[6] === "number" ? r[6] : null });
  }
  out.sort((a, b) => a.t - b.t);
  // de-duplicate identical timestamps (keep the last observed)
  const dedup: Candle[] = [];
  for (const c of out) {
    const last = dedup[dedup.length - 1];
    if (last && last.t === c.t) dedup[dedup.length - 1] = c;
    else dedup.push(c);
  }
  return dedup;
}

interface RawDepthLevel {
  quantity?: number;
  price?: number;
  orders?: number;
}
interface RawDepth {
  buy?: RawDepthLevel[];
  sell?: RawDepthLevel[];
}
interface RawQuote {
  instrument_token?: string;
  symbol?: string;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  last_price?: number;
  volume?: number;
  average_price?: number;
  oi?: number;
  last_quantity?: number;
  buy_quantity?: number;
  sell_quantity?: number;
  lower_circuit_limit?: number;
  upper_circuit_limit?: number;
  timestamp?: string | number;
  last_trade_time?: string | number;
  depth?: RawDepth;
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}
function numOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function normalizeQuote(mapKey: string, q: RawQuote): Quote {
  const tsRaw = q.last_trade_time ?? q.timestamp;
  const ts =
    tsRaw == null ? null : typeof tsRaw === "number" ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : new Date(tsRaw).getTime();
  const canonical =
    typeof q.instrument_token === "string" && q.instrument_token.includes("|")
      ? q.instrument_token
      : mapKey;
  return {
    key: canonical,
    ltp: numOrNull(q.last_price),
    open: numOrNull(q.ohlc?.open),
    high: numOrNull(q.ohlc?.high),
    low: numOrNull(q.ohlc?.low),
    prevClose: numOrNull(q.ohlc?.close),
    volume: numOrNull(q.volume),
    averagePrice: numOrNull(q.average_price),
    oi: numOrNull(q.oi),
    lastQty: numOrNull(q.last_quantity),
    buyQty: numOrNull(q.buy_quantity),
    sellQty: numOrNull(q.sell_quantity),
    lowerCircuit: numOrNull(q.lower_circuit_limit),
    upperCircuit: numOrNull(q.upper_circuit_limit),
    ts: ts != null && Number.isFinite(ts) ? ts : null,
    bidDepth: sumDepth(q.depth?.buy, "quantity"),
    askDepth: sumDepth(q.depth?.sell, "quantity"),
    bidOrders: sumDepth(q.depth?.buy, "orders"),
    askOrders: sumDepth(q.depth?.sell, "orders"),
  };
}

/** Sum a field across depth levels; null when no levels are provided. */
function sumDepth(levels: RawDepthLevel[] | undefined, field: "quantity" | "orders"): number | null {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  let sum = 0;
  let any = false;
  for (const l of levels) {
    const v = l?.[field];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

interface RawChainItem {
  strike_price?: number;
  pcr?: number;
  underlying_spot_price?: number;
  call_options?: {
    market_data?: { oi?: number; volume?: number; ltp?: number; prev_oi?: number; close_price?: number };
    option_greeks?: { iv?: number };
  };
  put_options?: {
    market_data?: { oi?: number; volume?: number; ltp?: number; prev_oi?: number; close_price?: number };
    option_greeks?: { iv?: number };
  };
}

// ---------------------------------------------------------------- instruments

const INSTRUMENTS_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";

export const NIFTY_INDEX_KEY = "NSE_INDEX|Nifty 50";

/**
 * Build the live NSE F&O universe from the official Upstox instrument master.
 * Universe = every equity that has an ACTIVE stock future (segment NSE_FO,
 * instrument_type FUT, underlying_type EQUITY). FUT rows carry the equity
 * `underlying_key`, so the EQ↔FUT link survives symbol renames. The nearest
 * active future per stock is kept for futures confirmation. New/removed F&O
 * names, contract and expiry changes are handled automatically on refresh.
 */
export async function fetchUniverseFromInstruments(): Promise<UniverseEntry[]> {
  const res = await fetch(INSTRUMENTS_URL, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip" },
    cache: "no-store",
  });
  if (!res.ok) throw new UpstoxError(`instrument file HTTP ${res.status}`, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  let text: string;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const { gunzipSync } = await import("node:zlib");
    text = gunzipSync(buf).toString("utf8");
  } else {
    text = buf.toString("utf8");
  }
  const rows = JSON.parse(text) as InstrumentRow[];
  if (!Array.isArray(rows)) throw new UpstoxError("instrument file malformed", null);

  const nowMs = Date.now() - 6 * 3600 * 1000; // include contracts expiring today
  const equitiesByKey = new Map<string, InstrumentRow>();
  const equitiesBySym = new Map<string, InstrumentRow>();
  const futuresByUnderlying = new Map<string, InstrumentRow[]>();

  for (const r of rows) {
    if (!r || typeof r.instrument_key !== "string") continue;
    if (r.segment === "NSE_EQ" && (r.instrument_type === "EQ" || r.instrument_type === "" || r.instrument_type == null)) {
      equitiesByKey.set(r.instrument_key, r);
      if (typeof r.trading_symbol === "string" && r.trading_symbol) {
        equitiesBySym.set(r.trading_symbol, r);
      }
    } else if (
      r.segment === "NSE_FO" &&
      r.instrument_type === "FUT" &&
      (r.underlying_type === "EQUITY" || r.asset_type === "EQUITY")
    ) {
      const expMs = expiryMs(r.expiry);
      if (expMs == null || expMs < nowMs) continue;
      const und =
        (typeof r.underlying_key === "string" && r.underlying_key) ||
        (typeof r.underlying_symbol === "string" && r.underlying_symbol) ||
        null;
      if (!und) continue;
      const arr = futuresByUnderlying.get(und) ?? [];
      arr.push(r);
      futuresByUnderlying.set(und, arr);
    }
  }

  const out: UniverseEntry[] = [];
  for (const [und, futs] of futuresByUnderlying) {
    const eq =
      equitiesByKey.get(und) ??
      equitiesBySym.get(und) ??
      equitiesBySym.get(
        typeof futs[0].underlying_symbol === "string" ? futs[0].underlying_symbol : "",
      );
    if (!eq || typeof eq.trading_symbol !== "string") continue; // stock must trade on NSE EQ
    futs.sort((a, b) => (expiryMs(a.expiry) ?? 0) - (expiryMs(b.expiry) ?? 0));
    const fut = futs[0];
    out.push({
      symbol: eq.trading_symbol,
      name: typeof eq.name === "string" ? eq.name : null,
      eqKey: eq.instrument_key,
      eqToken: eq.exchange_token != null ? String(eq.exchange_token) : null,
      futKey: typeof fut.instrument_key === "string" ? fut.instrument_key : null,
      futSymbol: typeof fut.trading_symbol === "string" ? fut.trading_symbol : null,
      futExpiry: fut.expiry != null ? expiryISO(fut.expiry) : null,
      lotSize: typeof fut.lot_size === "number" ? fut.lot_size : null,
      tickSize: typeof fut.tick_size === "number" ? fut.tick_size : null,
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

function expiryMs(exp: string | number | undefined): number | null {
  if (exp === undefined || exp === null || exp === "") return null;
  if (typeof exp === "number") return exp > 1e12 ? exp : exp * 1000;
  const t = new Date(exp).getTime();
  return Number.isFinite(t) ? t : null;
}

function expiryISO(exp: string | number): string | null {
  const ms = expiryMs(exp);
  if (ms == null) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

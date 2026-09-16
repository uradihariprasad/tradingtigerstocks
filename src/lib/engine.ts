/**
 * Scanner engine — singleton orchestrator.
 *
 * Pipeline per scan:
 *   Universe (cached F&O instruments)
 *   → batch quotes (equities + futures + NIFTY)
 *   → 1-min intraday candles for every stock  (STAGE 1, cheap)
 *   → hysteresis / momentum state machine      (signal stability)
 *   → top-K candidates
 *   → deep analysis (option chain, dynamic S/R, setups)  (STAGE 2, expensive, cadence-limited)
 *   → ranked Top-N trade cards + explanation engine
 *
 * All data comes from Upstox. Missing inputs surface as null → UI shows N/A.
 */

import { DEFAULT_CONFIG, type ScannerConfig } from "@/lib/config";
import { getMarketStatus, subDaysIST, minuteOfDayIST, type MarketStatus } from "@/lib/market";
import {
  atr,
  bollinger,
  ema,
  lastEma,
  resample,
  vwapFromCandles,
  vwapSeries,
} from "@/lib/indicators";
import {
  RateLimiter,
  UpstoxClient,
  fetchUniverseFromInstruments,
  mapLimit,
  NIFTY_INDEX_KEY,
  type Candle,
  type ChainStrike,
  type Quote,
  type UniverseEntry,
} from "@/lib/upstox";
import {
  buildExplanation,
  buildLevels,
  buildSetup,
  buildupLabel,
  computeStage1,
  finalScore,
  type DeepInputs,
  type LevelsResult,
  type Momentum,
  type NiftySnapshot,
  type SetupState,
  type Stage1Row,
  type TradeCard,
  type Trend,
} from "@/lib/scanner";
import * as repo from "@/lib/repo";
import {
  computeOrderFlow,
  type FlowObs,
  type OrderFlowEntry,
  type OrderFlowPayload,
} from "@/lib/orderflow";

// ------------------------------------------------------------------ payload types

export interface ScanMeta {
  runAt: string | null;
  durationMs: number | null;
  clockIST: string;
  market: MarketStatus;
  tokenConfigured: boolean;
  tokenUser: string | null;
  universeSize: number;
  universeSource: string | null;
  universeRefreshedAt: string | null;
  scanned: number;
  candidateCount: number;
  deepAnalysed: number;
  suggestionsPaused: boolean;
  transport: string;
  errors: string[];
}

export interface Boards {
  earlyMomentum: Stage1Row[];
  confirmedMomentum: Stage1Row[];
  strongestRS: Stage1Row[];
  strongestRW: Stage1Row[];
  highestRVOL: Stage1Row[];
}

export interface ScanPayload {
  meta: ScanMeta;
  nifty: NiftySnapshot & { prevDayClose: number | null };
  breadth: { advances: number; declines: number; unchanged: number; total: number } | null;
  regime: "RISK-ON" | "RISK-OFF" | "MIXED" | null;
  rows: Stage1Row[];
  candidateSymbols: string[];
  boards: Boards;
  trades: TradeCard[];
  candidatesDetail: TradeCard[];
  watchBreakout: TradeCard[];
  watchBreakdown: TradeCard[];
  /** ORDER FLOW DOMINANCE — independent additive module (may be null on old snapshots) */
  orderFlow: OrderFlowPayload | null;
}

interface SymState {
  lastTrend: Trend | null;
  stableTrend: Trend | null;
  trendAgree: number;
  earlyDir: "LONG" | "SHORT" | null;
  earlyCount: number;
  momentum: Momentum;
  inCandidates: boolean;
  dwell: number;
  dir: "LONG" | "SHORT" | null;
}

interface DeepCache {
  fetchedAt: number;
  expiry: string | null;
  chain: ChainStrike[] | null;
  oiBaseline: Map<number, { ce: number | null; pe: number | null }> | null;
  futCandles5m: Candle[] | null;
  futCandles1m: Candle[] | null; // FIX 5 — futures S/R source series
  futVolumeToday: number | null; // futures liquidity for S/R confidence
}

/** Calendar days to the futures expiry (null when unknown). */
export function daysToExpiry(expiry: string | null | undefined): number | null {
  if (!expiry) return null;
  const t = new Date(`${expiry}T15:30:00+05:30`).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / 86_400_000;
}

interface DayCache {
  day: string | null;
  prevDay: Map<string, Candle | null>;
  futPrevDay: Map<string, Candle | null>; // FIX 5 — previous futures session H/L
  niftyPrevClose: number | null; // previous NIFTY session close (daily candle)
  /** ORDER FLOW DOMINANCE — real per-scan score history for trend detection */
  orderFlowHistory: Map<string, FlowObs[]>;
  volProfiles: Map<string, Map<number, number> | null>;
  warmingPrevDay: boolean;
  warmingProfiles: boolean;
  futOiBase: Map<string, number>;
}

export interface StockDetail {
  symbol: string;
  name: string | null;
  row: Stage1Row | null;
  card: TradeCard | null;
  levels: LevelsResult | null;
  candles5m: Candle[];
  overlays: {
    vwap: Array<number | null>;
    ema9: Array<number | null>;
    ema20: Array<number | null>;
    ema50: Array<number | null>;
    bb: Array<{ mid: number; upper: number; lower: number } | null>;
  } | null;
  futures: {
    symbol: string | null;
    expiry: string | null;
    ltp: number | null;
    changePct: number | null;
    oi: number | null;
    oiChange: number | null;
    oiChangePct: number | null;
    basis: number | null;
    buildup: string | null;
    candles5m: Candle[] | null;
  };
  chain: { expiry: string | null; spot: number | null; strikes: ChainStrike[] } | null;
  meta: { fetchedAt: string; marketOpen: boolean; status: string };
}

// ------------------------------------------------------------------ engine

const state = (): {
  lastTrend: Trend | null;
  stableTrend: Trend | null;
  trendAgree: number;
  earlyDir: "LONG" | "SHORT" | null;
  earlyCount: number;
  momentum: Momentum;
  inCandidates: boolean;
  dwell: number;
  dir: "LONG" | "SHORT" | null;
} => ({
  lastTrend: null,
  stableTrend: null,
  trendAgree: 0,
  earlyDir: null,
  earlyCount: 0,
  momentum: "NONE",
  inCandidates: false,
  dwell: 0,
  dir: null,
});

class Engine {
  cfg: ScannerConfig = DEFAULT_CONFIG;
  private cfgLoadedAt = 0;
  private limiter = new RateLimiter(this.cfg.maxRequestsPerSec);
  private client = new UpstoxClient(() => this.token, this.limiter);
  private token: string | null = null;
  tokenUser: string | null = null;
  private tokenLoadedAt = 0;

  universe: UniverseEntry[] = [];
  private universeLoadedAt = 0;
  private refreshingUniverse = false;

  private symState = new Map<string, SymState>();
  private deep = new Map<string, DeepCache>();
  private dayCache: DayCache = {
    day: null,
    prevDay: new Map(),
    futPrevDay: new Map(),
    niftyPrevClose: null,
    orderFlowHistory: new Map(),
    volProfiles: new Map(),
    warmingPrevDay: false,
    warmingProfiles: false,
    futOiBase: new Map(),
  };

  private candlesCache = new Map<string, Candle[]>();
  private quotesCache = new Map<string, Quote>();
  private niftyCache: NiftySnapshot | null = null;

  payload: ScanPayload | null = null;
  scanning = false;
  started = false;
  lastScanAt: number | null = null;

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.started) return;
    this.started = true;
    void this.boot();
    setInterval(() => {
      void this.scanSafe().catch(() => undefined);
    }, 20_000);
  }

  private async boot() {
    await repo.loadLatestSnapshot<ScanPayload>().then((p) => {
      if (p && !this.payload) this.payload = p;
    });
    await this.refreshConfig();
    await this.refreshToken();
    await this.loadUniverse(false);
    void this.scanSafe();
  }

  private async refreshConfig() {
    this.cfg = await repo.getConfig();
    this.cfgLoadedAt = Date.now();
    this.limiter = new RateLimiter(this.cfg.maxRequestsPerSec);
    this.client = new UpstoxClient(() => this.token, this.limiter);
  }

  /**
   * Load the token from the DB — only when memory is empty. A valid token
   * validated this session is never clobbered by a transient DB read failure.
   */
  private async refreshToken() {
    if (this.token != null) {
      this.tokenLoadedAt = Date.now();
      return;
    }
    const t = await repo.getToken();
    if (t != null) this.token = t;
    this.tokenLoadedAt = Date.now();
    if (this.token != null && this.tokenUser == null) {
      this.tokenUser = await repo.getSetting<string>("upstox_token_user");
    }
  }

  async setToken(
    token: string,
  ): Promise<{ ok: boolean; user: string | null; persisted?: boolean; error?: string }> {
    const probe = new UpstoxClient(() => token, new RateLimiter(4));
    try {
      const { name } = await probe.validateToken();
      const persisted = await repo.setSetting("upstox_token", token);
      if (persisted) await repo.setSetting("upstox_token_user", name ?? "Upstox user");
      this.token = token;
      this.tokenUser = name ?? "Upstox user";
      this.triggerScan();
      return { ok: true, user: this.tokenUser, persisted };
    } catch (e) {
      return { ok: false, user: null, error: (e as Error).message };
    }
  }

  async clearToken() {
    await repo.deleteSetting("upstox_token");
    await repo.deleteSetting("upstox_token_user");
    this.token = null;
    this.tokenUser = null;
  }

  async applyConfig(raw: unknown): Promise<ScannerConfig> {
    const merged = await repo.saveConfig(raw);
    this.cfg = merged;
    return merged;
  }

  // ---------------------------------------------------------------- universe

  async loadUniverse(force: boolean): Promise<{ count: number; error?: string }> {
    if (this.refreshingUniverse) return { count: this.universe.length };
    const hasLocal = this.universe.length > 0 || (await repo.loadUniverse()).length > 0;
    if (this.universe.length === 0) this.universe = await repo.loadUniverse();
    const meta = await repo.getUniverseMeta();
    const stale =
      !meta?.refreshedAt || Date.now() - new Date(meta.refreshedAt).getTime() > 20 * 3600_000;
    if (force || this.universe.length === 0 || (stale && !hasLocal)) {
      this.refreshingUniverse = true;
      try {
        const entries = await fetchUniverseFromInstruments();
        await repo.replaceUniverse(entries, "upstox-instrument-master");
        this.universe = entries;
      } catch (e) {
        this.refreshingUniverse = false;
        if (this.universe.length === 0) this.universe = await repo.loadUniverse();
        return { count: this.universe.length, error: (e as Error).message };
      }
      this.refreshingUniverse = false;
    }
    this.universeLoadedAt = Date.now();
    return { count: this.universe.length };
  }

  // ---------------------------------------------------------------- day caches

  private ensureDayCaches(today: string) {
    if (this.dayCache.day === today) return;
    this.dayCache = {
      day: today,
      prevDay: new Map(),
      futPrevDay: new Map(),
      niftyPrevClose: null,
      orderFlowHistory: new Map(),
      volProfiles: new Map(),
      warmingPrevDay: false,
      warmingProfiles: false,
      futOiBase: new Map(),
    };
    this.deep.clear();
    this.symState.clear();
  }

  /** Background warm: previous-day daily bars (for PDH/PDL/PDC). */
  private warmPrevDay(today: string) {
    if (this.dayCache.warmingPrevDay || !this.token) return;
    this.dayCache.warmingPrevDay = true;
    const from = subDaysIST(today, 20);
    const dayStart = new Date(`${today}T00:00:00+05:30`).getTime();
    void mapLimit(this.universe, 5, async (u) => {
      try {
        const candles = await this.client.dailyCandles(u.eqKey, from, today);
        const prev = [...candles].reverse().find((c) => c.t < dayStart);
        this.dayCache.prevDay.set(u.symbol, prev ?? null);
      } catch {
        this.dayCache.prevDay.set(u.symbol, null);
      }
      // FIX 5 — previous futures session high/low for futures S/R
      if (u.futKey) {
        try {
          const fc = await this.client.dailyCandles(u.futKey, from, today);
          const fprev = [...fc].reverse().find((c) => c.t < dayStart);
          this.dayCache.futPrevDay.set(u.symbol, fprev ?? null);
        } catch {
          this.dayCache.futPrevDay.set(u.symbol, null);
        }
      }
      return true;
    }).catch(() => undefined);
  }

  /** Background warm: time-of-day volume profiles (for RVOL). */
  private warmVolProfiles(today: string) {
    if (this.dayCache.warmingProfiles || !this.token) return;
    this.dayCache.warmingProfiles = true;
    const daysWanted = this.cfg.rvolBaselineDays;
    const from = subDaysIST(today, Math.ceil(daysWanted * 1.7) + 4);
    const to = subDaysIST(today, 1);
    void mapLimit(this.universe, 4, async (u) => {
      try {
        const candles = await this.client.minuteCandles(u.eqKey, from, to);
        const byDay = new Map<string, Candle[]>();
        for (const c of candles) {
          const d = c.t;
          const key = new Date(d).toISOString().slice(0, 10);
          const arr = byDay.get(key) ?? [];
          arr.push(c);
          byDay.set(key, arr);
        }
        const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, daysWanted);
        if (days.length < 3) {
          this.dayCache.volProfiles.set(u.symbol, null);
          return true;
        }
        const sums = new Map<number, { s: number; n: number }>();
        for (const [, cs] of days) {
          cs.sort((a, b) => a.t - b.t);
          let cum = 0;
          for (const c of cs) {
            cum += c.v;
            const m = minuteOfDayIST(c.t);
            const rec = sums.get(m) ?? { s: 0, n: 0 };
            rec.s += cum;
            rec.n += 1;
            sums.set(m, rec);
          }
        }
        const profile = new Map<number, number>();
        for (const [m, rec] of sums) profile.set(m, rec.s / rec.n);
        this.dayCache.volProfiles.set(u.symbol, profile);
      } catch {
        this.dayCache.volProfiles.set(u.symbol, null);
      }
      return true;
    }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- scan

  private async scanSafe(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.scan();
    } catch {
      /* keep last payload */
    } finally {
      this.scanning = false;
    }
  }

  /** Fire-and-forget scan trigger for API routes — must never block a request. */
  triggerScan(): void {
    void this.scanSafe().catch(() => undefined);
  }

  private emptyPayload(ms: MarketStatus, errors: string[]): ScanPayload {
    return {
      meta: {
        runAt: this.payload?.meta.runAt ?? null,
        durationMs: this.payload?.meta.durationMs ?? null,
        clockIST: ms.istNow,
        market: ms,
        tokenConfigured: this.token != null,
        tokenUser: this.tokenUser,
        universeSize: this.universe.length,
        universeSource: null,
        universeRefreshedAt: null,
        scanned: 0,
        candidateCount: 0,
        deepAnalysed: 0,
        suggestionsPaused: true,
        transport: this.token ? "upstox-rest" : "—",
        errors,
      },
      nifty: {
        ltp: null,
        prevClose: null,
        open: null,
        changePct: null,
        candles1m: null,
        trend5m: null,
        aboveVwap: null,
        status: "UNAVAILABLE",
        prevDayClose: null,
      },
      breadth: null,
      regime: null,
      rows: [],
      candidateSymbols: [],
      boards: { earlyMomentum: [], confirmedMomentum: [], strongestRS: [], strongestRW: [], highestRVOL: [] },
      trades: [],
      candidatesDetail: [],
      watchBreakout: [],
      watchBreakdown: [],
      orderFlow: null,
    };
  }

  async scan(): Promise<void> {
    const t0 = Date.now();
    if (Date.now() - this.cfgLoadedAt > 30_000) await this.refreshConfig();
    if (Date.now() - this.tokenLoadedAt > 60_000) await this.refreshToken();

    const ms = getMarketStatus();
    const errors: string[] = [];

    // fresh universe attempt once per hour in the background
    if (Date.now() - this.universeLoadedAt > 3600_000) void this.loadUniverse(false);
    this.ensureDayCaches(ms.istDay);

    if (!this.token) {
      const p = this.emptyPayload(ms, ["Upstox access token not configured"]);
      p.meta.universeSize = this.universe.length;
      this.payload = p;
      return;
    }
    if (this.universe.length === 0) {
      const res = await this.loadUniverse(true);
      if (res.error) errors.push(`Universe refresh failed: ${res.error}`);
      if (this.universe.length === 0) {
        this.payload = this.emptyPayload(ms, [...errors, "F&O universe unavailable"]);
        return;
      }
    }

    const universe =
      this.cfg.universeSize != null ? this.universe.slice(0, this.cfg.universeSize) : this.universe;

    // warm caches in background (non-blocking)
    this.warmPrevDay(ms.istDay);
    this.warmVolProfiles(ms.istDay);

    // ---- batch quotes (equities + futures + NIFTY)
    const keys: string[] = [];
    for (const u of universe) {
      keys.push(u.eqKey);
      if (u.futKey) keys.push(u.futKey);
    }
    keys.push(NIFTY_INDEX_KEY);
    let quotes = new Map<string, Quote>();
    try {
      quotes = await this.client.quotes(keys);
    } catch (e) {
      errors.push(`quote fetch failed: ${(e as Error).message}`);
      quotes = this.quotesCache;
    }
    this.quotesCache = quotes;

    // ---- NIFTY context (quote first; candles are best-effort add-ons)
    let nifty: NiftySnapshot = {
      ltp: null, prevClose: null, open: null, changePct: null,
      candles1m: null, trend5m: null, aboveVwap: null, status: "UNAVAILABLE",
    };
    try {
      const nq = quotes.get(NIFTY_INDEX_KEY) ?? null;
      // real previous NIFTY close from daily candles (cached once per day);
      // the index quote also echoes ohlc.close === ltp
      if (this.dayCache.niftyPrevClose == null) {
        try {
          const nd = await this.client.dailyCandles(NIFTY_INDEX_KEY, subDaysIST(ms.istDay, 10), ms.istDay);
          const dayStart = new Date(`${ms.istDay}T00:00:00+05:30`).getTime();
          const prevBar = [...nd].reverse().find((c) => c.t < dayStart);
          if (prevBar) this.dayCache.niftyPrevClose = prevBar.c;
        } catch {
          /* N/A — day change stays null */
        }
      }
      const nqPrev =
        this.dayCache.niftyPrevClose ??
        (nq?.prevClose != null && nq?.ltp != null && Math.abs(nq.prevClose - nq.ltp) > 1e-9
          ? nq.prevClose
          : null);
      const changePct =
        nq?.ltp != null && nqPrev != null && nqPrev > 0
          ? ((nq.ltp - nqPrev) / nqPrev) * 100
          : null;
      nifty = {
        ltp: nq?.ltp ?? null,
        prevClose: nqPrev,
        open: nq?.open ?? null,
        changePct: changePct != null ? Math.round(changePct * 100) / 100 : null,
        candles1m: null,
        trend5m: null,
        aboveVwap: null,
        status: nq?.ltp != null ? (ms.isOpen ? "LIVE" : "STALE") : "UNAVAILABLE",
      };
      let nCandles: Awaited<ReturnType<typeof this.client.intradayCandles>> = [];
      try {
        nCandles = await this.client.intradayCandles(NIFTY_INDEX_KEY, "1minute");
      } catch (e) {
        errors.push(`NIFTY candles unavailable: ${(e as Error).message}`);
      }
      if (nCandles.length) {
        const closes = nCandles.map((c) => c.c);
        const e9 = lastEma(closes, 9);
        const e20 = lastEma(closes, 20);
        const vwap = vwapFromCandles(nCandles) ?? nq?.averagePrice ?? null;
        const last = closes[closes.length - 1] ?? null;
        nifty.trend5m =
          e9 != null && e20 != null ? (e9 > e20 ? "BULLISH" : e9 < e20 ? "BEARISH" : "NEUTRAL") : null;
        nifty.aboveVwap = (last ?? nifty.ltp) != null && vwap != null ? (last ?? nifty.ltp ?? 0) > vwap : null;
        nifty.candles1m = nCandles;
        nifty.ltp = nifty.ltp ?? last;
        nifty.open = nifty.open ?? nCandles[0].o;
      }
      if (nifty.ltp == null && this.niftyCache?.ltp != null) nifty = this.niftyCache;
    } catch (e) {
      errors.push(`NIFTY data unavailable: ${(e as Error).message}`);
      nifty = this.niftyCache ?? nifty;
    }
    this.niftyCache = nifty;

    // ---- 1-minute intraday candles for the full universe (STAGE 1 input)
    const candleResults = await mapLimit(universe, this.cfg.universeConcurrency, async (u) => {
      const cs = await this.client.intradayCandles(u.eqKey, "1minute");
      return cs;
    });
    universe.forEach((u, i) => {
      const cs = candleResults[i];
      if (cs && cs.length) this.candlesCache.set(u.symbol, cs);
      else if (!this.candlesCache.has(u.symbol)) this.candlesCache.set(u.symbol, []);
    });

    // ---- reference clock for metric staleness.
    // Open market  → wall clock.
    // Closed       → the SESSION clock (newest observed bar close). Quote
    // timestamps are deliberately excluded: after hours many feeds echo the
    // final quote with a fresh request timestamp, which must not mark
    // quote-derived inputs "LIVE" while the session bars look stale.
    const nowMs = Date.now();
    let sessionRef = 0;
    const ncsRef = nifty.candles1m;
    if (ncsRef && ncsRef.length) sessionRef = ncsRef[ncsRef.length - 1].t + 60_000;
    else {
      for (const cs of this.candlesCache.values()) {
        if (cs.length && cs[cs.length - 1].t + 60_000 > sessionRef) sessionRef = cs[cs.length - 1].t + 60_000;
      }
    }
    const stalenessNow =
      ms.isOpen || sessionRef === 0 || sessionRef < nowMs - 36 * 3600_000 ? nowMs : sessionRef;

    // ---- STAGE 1 rows + state machine
    const rows: Stage1Row[] = [];
    for (const u of universe) {
      const quote = quotes.get(u.eqKey) ?? null;
      const futQuote = u.futKey ? quotes.get(u.futKey) ?? null : null;
      const candles = this.candlesCache.get(u.symbol) ?? null;

      // futures session OI baseline (captured from the first real reading of the day)
      let futBase = this.dayCache.futOiBase.get(u.symbol) ?? null;
      if (futBase == null && futQuote?.oi != null) {
        this.dayCache.futOiBase.set(u.symbol, futQuote.oi);
        void repo.ensureFutOiBaseline(ms.istDay, u.symbol, futQuote.oi);
        futBase = futQuote.oi;
      }

      // real previous futures session reference (daily candle: close + OI)
      const futPrevBar = this.dayCache.futPrevDay.get(u.symbol) ?? null;
      // intraday futures OI path when Stage-2 already fetched the series
      const futBars = this.deep.get(u.symbol)?.futCandles1m ?? null;
      const futFirst = futBars && futBars.length ? futBars[0] : null;
      const futLast = futBars && futBars.length ? futBars[futBars.length - 1] : null;

      const s1 = computeStage1({
        symbol: u.symbol,
        name: u.name,
        quote,
        futQuote,
        candles1m: candles && candles.length ? candles : null,
        volProfile: this.dayCache.volProfiles.get(u.symbol) ?? null,
        nifty,
        futOiBaseline: futBase,
        prevDayClose: this.dayCache.prevDay.get(u.symbol)?.c ?? null,
        futPrevClose: futPrevBar?.c ?? null,
        futPrevOi: futPrevBar?.oi ?? null,
        futIntradayOiOpen: futFirst?.oi ?? null,
        futIntradayOiLast: futLast?.oi ?? null,
        futIntradayOpen: futFirst?.o ?? null,
        cfg: this.cfg,
        isOpen: ms.isOpen,
        nowMs,
        asOfMs: stalenessNow,
        rollover: isRollover(u.futExpiry, this.cfg.rolloverDaysBefore),
      });

      // ---- hysteresis / stability state machine
      const st = this.symState.get(u.symbol) ?? state();
      const detected = s1.trend5m;
      if (detected != null && detected === st.lastTrend) st.trendAgree += 1;
      else {
        st.lastTrend = detected;
        st.trendAgree = 1;
      }
      if (st.trendAgree >= 2 && detected != null) st.stableTrend = detected;

      const dir = (s1.dir ?? (st.dir as "LONG" | "SHORT" | null)) ?? null;
      st.dir = dir ?? st.dir;
      const trendAligned =
        (st.dir === "LONG" && st.stableTrend === "BULLISH") ||
        (st.dir === "SHORT" && st.stableTrend === "BEARISH");

      const early = s1.earlyDir != null && s1.earlyDir === (st.dir ?? s1.earlyDir);
      if (early) {
        st.earlyDir = s1.earlyDir;
        st.earlyCount += 1;
      } else {
        st.earlyCount = 0;
        st.earlyDir = null;
      }

      const momentumLive =
        rowMomentumLive(s1, this.cfg, st.dir) || early;
      if (momentumLive && trendAligned && st.earlyCount >= 1) st.momentum = "CONFIRMED";
      else if (early || (momentumLive && st.earlyCount >= 1)) st.momentum = "EARLY";
      else if (st.momentum !== "NONE" && !momentumLive) st.momentum = "NONE";

      // hysteresis candidate membership
      const score = s1.score;
      // liquidity floor is a hard gate: an illiquid name can never enter or
      // remain in the candidate pool regardless of momentum score.
      const liquid = s1.liquidityOk !== false;
      if (!liquid) {
        st.inCandidates = false;
        st.dwell = 0;
      } else if (!st.inCandidates && score != null && score >= this.cfg.enterScore && st.momentum !== "NONE") {
        st.inCandidates = true;
        st.dwell = 0;
      } else if (st.inCandidates) {
        st.dwell += 1;
        const weak = score == null || score < this.cfg.exitScore || st.momentum === "NONE";
        if (weak && st.dwell >= this.cfg.minDwellScans) {
          st.inCandidates = false;
          st.dwell = 0;
        }
      }
      this.symState.set(u.symbol, st);

      rows.push({ ...stripEarly(s1), momentum: st.momentum });
    }

    // ---- ORDER FLOW DOMINANCE (independent module — does not affect
    //      candidates, trades, thresholds or any existing pipeline stage)
    const flowBuy: OrderFlowEntry[] = [];
    const flowSell: OrderFlowEntry[] = [];
    let flowConsidered = 0;
    const uniBySymbol = new Map(universe.map((x) => [x.symbol, x]));
    for (const row of rows) {
      const u = uniBySymbol.get(row.symbol);
      if (!u) continue;
      const quote = quotes.get(u.eqKey) ?? null;
      const candles = this.candlesCache.get(row.symbol) ?? [];
      const hist = this.dayCache.orderFlowHistory.get(row.symbol) ?? [];
      const res = computeOrderFlow({ row, quote, candles, history: hist, cfg: this.cfg, nowMs });
      if (res.buyer) flowBuy.push(res.buyer);
      if (res.seller) flowSell.push(res.seller);
      if (res.buyerScore != null || res.sellerScore != null) flowConsidered++;
      // append real observation for future trend detection (never fabricated)
      if (res.buyerScore != null || res.sellerScore != null) {
        hist.push({ t: nowMs, buyer: res.buyerScore, seller: res.sellerScore });
        if (hist.length > 12) hist.splice(0, hist.length - 12);
        this.dayCache.orderFlowHistory.set(row.symbol, hist);
      }
    }
    const orderFlow: OrderFlowPayload = {
      buySide: flowBuy
        .filter((e) => e.score >= 60 && e.status !== "INSUFFICIENT DATA")
        .sort((a, b) => b.score - a.score)
        .slice(0, 5),
      sellSide: flowSell
        .filter((e) => e.score >= 60 && e.status !== "INSUFFICIENT DATA")
        .sort((a, b) => b.score - a.score)
        .slice(0, 5),
      computedAt: Date.now(),
      universeConsidered: flowConsidered,
    };

    // ---- final candidate union (hysteresis members ∪ top-K by score)
    const ranked = rows
      .filter((r) => r.score != null && r.liquidityOk !== false)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const liquidSymbols = new Set(rows.filter((r) => r.liquidityOk !== false).map((r) => r.symbol));
    const candidateSet = new Set<string>();
    for (const [sym, st] of this.symState) {
      if (st.inCandidates && liquidSymbols.has(sym)) candidateSet.add(sym);
    }
    // top-K by momentum score — Stage 1 deliberately tolerates imperfect
    // evidence; Stage 2 decides whether a real trade exists
    for (const r of ranked) {
      if (candidateSet.size >= this.cfg.candidateTopK) break;
      candidateSet.add(r.symbol);
    }
    const candidates = rows.filter((r) => candidateSet.has(r.symbol)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const candidateSymbols = candidates.map((r) => r.symbol).slice(0, this.cfg.candidateTopK);

    // ---- STAGE 2 deep analysis on candidates only
    const cards: TradeCard[] = [];
    for (const row of candidates.slice(0, this.cfg.candidateTopK)) {
      const card = await this.deepAnalyse(row, universe.find((u) => u.symbol === row.symbol)!, ms);
      if (card) cards.push(card);
    }

    const trades = cards
      .filter((c) => c.setupState !== "NO_TRADE")
      .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
      .slice(0, this.cfg.topTrades);
    const candidatesDetail = cards.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
    const watchBreakout = cards.filter((c) => c.setupState === "WAIT_FOR_BREAKOUT");
    const watchBreakdown = cards.filter((c) => c.setupState === "WAIT_FOR_BREAKDOWN");

    // ---- breadth / regime
    let breadth: ScanPayload["breadth"] = null;
    const withChg = rows.filter((r) => r.changePct != null);
    if (withChg.length > 10) {
      breadth = {
        advances: withChg.filter((r) => (r.changePct ?? 0) > 0.1).length,
        declines: withChg.filter((r) => (r.changePct ?? 0) < -0.1).length,
        unchanged: withChg.filter((r) => Math.abs(r.changePct ?? 0) <= 0.1).length,
        total: withChg.length,
      };
    }
    let regime: ScanPayload["regime"] = null;
    if (nifty.trend5m != null && breadth != null) {
      const bullSide = breadth.advances > breadth.declines;
      if (nifty.trend5m === "BULLISH" && (nifty.aboveVwap ?? true) && bullSide) regime = "RISK-ON";
      else if (nifty.trend5m === "BEARISH" && nifty.aboveVwap === false && !bullSide) regime = "RISK-OFF";
      else regime = "MIXED";
    }

    const boards: Boards = {
      earlyMomentum: rows.filter((r) => r.momentum === "EARLY").sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 8),
      confirmedMomentum: rows.filter((r) => r.momentum === "CONFIRMED").sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 8),
      strongestRS: rows.filter((r) => r.rs != null && r.rs > 0).sort((a, b) => (b.rs ?? 0) - (a.rs ?? 0)).slice(0, 6),
      strongestRW: rows.filter((r) => r.rs != null && r.rs < 0).sort((a, b) => (a.rs ?? 0) - (b.rs ?? 0)).slice(0, 6),
      highestRVOL: rows.filter((r) => r.rvol != null).sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0)).slice(0, 6),
    };

    const meta = await repo.getUniverseMeta();
    const payload: ScanPayload = {
      meta: {
        runAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        clockIST: ms.istNow,
        market: ms,
        tokenConfigured: true,
        tokenUser: this.tokenUser,
        universeSize: universe.length,
        universeSource: meta?.source ?? "upstox-instrument-master",
        universeRefreshedAt: meta?.refreshedAt ?? null,
        scanned: rows.length,
        candidateCount: candidateSymbols.length,
        deepAnalysed: cards.length,
        suggestionsPaused: !ms.isOpen,
        transport: "upstox-rest-stream",
        errors: errors.slice(0, 6),
      },
      nifty: { ...nifty, prevDayClose: nifty.prevClose },
      breadth,
      regime,
      rows: rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
      candidateSymbols,
      boards,
      trades,
      candidatesDetail,
      watchBreakout,
      watchBreakdown,
      orderFlow,
    };

    this.payload = payload;
    this.lastScanAt = Date.now();
    await repo.persistSnapshot(
      // keep snapshot lean — strip candles from nifty
      { ...payload, nifty: { ...payload.nifty, candles1m: null } },
      payload.meta.durationMs ?? 0,
      candidateSymbols.length,
    );
  }

  // ---------------------------------------------------------------- stage 2

  private async getDeep(u: UniverseEntry, spot: number | null, istDay: string): Promise<DeepCache> {
    const cached = this.deep.get(u.symbol);
    if (cached && Date.now() - cached.fetchedAt < this.cfg.deepRefreshSec * 1000) return cached;

    let expiry = cached?.expiry ?? null;
    let chain = cached?.chain ?? null;
    let oiBaseline = cached?.oiBaseline ?? null;
    let futCandles5m = cached?.futCandles5m ?? null;
    let futCandles1m = cached?.futCandles1m ?? null;
    let futVolumeToday = cached?.futVolumeToday ?? null;

    try {
      if (!expiry) expiry = await this.client.nearestExpiry(u.eqKey);
      if (expiry) {
        chain = await this.client.optionChain(u.eqKey, expiry);
        oiBaseline = await repo.getOiBaseline(istDay, u.symbol, expiry);
        if (!oiBaseline && chain) {
          await repo.ensureOiBaseline(
            istDay,
            u.symbol,
            expiry,
            chain.map((s) => ({ strike: s.strike, ce: s.ceOi, pe: s.peOi })),
          );
          oiBaseline = await repo.getOiBaseline(istDay, u.symbol, expiry);
        }
      }
    } catch {
      /* leave chain null when unavailable */
    }
    if (u.futKey) {
      try {
        const fut1m = await this.client.intradayCandles(u.futKey, "1minute");
        futCandles1m = fut1m;
        futCandles5m = resample(fut1m, 5);
        futVolumeToday = fut1m.reduce((a, c) => a + c.v, 0) || null;
      } catch {
        futCandles5m = cached?.futCandles5m ?? null;
        futCandles1m = cached?.futCandles1m ?? null;
      }
    }
    void spot;
    const next: DeepCache = {
      fetchedAt: Date.now(),
      expiry,
      chain,
      oiBaseline,
      futCandles5m,
      futCandles1m,
      futVolumeToday,
    };
    this.deep.set(u.symbol, next);
    return next;
  }

  private async deepAnalyse(row: Stage1Row, u: UniverseEntry, ms: MarketStatus): Promise<TradeCard | null> {
    if (row.ltp == null) return null;
    const candles1m = this.candlesCache.get(u.symbol) ?? [];
    if (candles1m.length < 20) return this.noDataCard(row, "INSUFFICIENT DATA — fewer than 20 one-minute bars");
    const candles5m = resample(candles1m, 5);
    if (candles5m.length < 8) return this.noDataCard(row, "INSUFFICIENT DATA — 5-minute structure not formed");

    const deep = await this.getDeep(u, row.ltp, ms.istDay);
    const prevDay = this.dayCache.prevDay.get(u.symbol) ?? null;
    const futTurnoverCr =
      row.futLtp != null && deep.futVolumeToday != null
        ? (row.futLtp * deep.futVolumeToday) / 1e7
        : null;
    const inputs: DeepInputs = {
      ltp: row.ltp,
      candles1m,
      candles5m,
      prevDay,
      vwap: row.vwap,
      chain: deep.chain,
      chainOiBaseline: deep.oiBaseline,
      chainExpiry: deep.expiry,
      // FIX 5 — futures structural inputs (Stage-2 only)
      futCandles1m: deep.futCandles1m,
      futPrevDay: this.dayCache.futPrevDay.get(u.symbol) ?? null,
      futLtp: row.futLtp,
      futTurnoverCr,
      daysToExpiry: daysToExpiry(u.futExpiry),
      futExpiry: u.futExpiry,
    };
    const levels = buildLevels(inputs, this.cfg);
    const dir: "LONG" | "SHORT" = row.dir ?? (row.trend5m === "BEARISH" ? "SHORT" : "LONG");
    let setup = buildSetup(dir, row.ltp, levels, this.cfg);
    // FIX 1 / FIX 9 — stale or incomplete data must never yield a fresh setup
    const staleData = row.status === "STALE" || row.status === "UNAVAILABLE";
    if (row.incomplete || staleData) {
      setup = {
        ...setup,
        state: "NO_TRADE",
        entryLow: null,
        entryHigh: null,
        stop: null,
        t1: null,
        t2: null,
        t3: null,
        rr1: null,
        rr2: null,
        rrOk: null,
        insufficientData: true,
        reasons: [
          row.incomplete
            ? `INCOMPLETE DATA — ${row.completeness}% completeness (min ${this.cfg.minCompletenessPct}%); missing ${row.missingMetrics.join(", ") || "n/a"}`
            : `DATA ${row.status} — trade suggestions paused`,
          ...setup.reasons,
        ],
      };
    }
    const score = finalScore(row, setup, levels, dir, this.cfg);
    const explanation = buildExplanation(row.symbol, dir, setup, levels, row);
    const paused = !ms.isOpen || staleData || row.incomplete;

    const optionsLabel =
      levels.optionSupport && levels.optionResistance
        ? `PE ${levels.optionSupport.strike} / CE ${levels.optionResistance.strike}`
        : levels.optionSupport
          ? `PE ${levels.optionSupport.strike}`
          : levels.optionResistance
            ? `CE ${levels.optionResistance.strike}`
            : null;

    return {
      symbol: row.symbol,
      name: row.name,
      direction: setup.direction,
      finalScore: score != null ? Math.round(score) : null,
      setupState: setup.state,
      setup,
      ltp: row.ltp,
      changePct: row.changePct,
      support: levels.supports[0] ?? null,
      resistance: levels.resistances[0] ?? null,
      optionSupport: levels.optionSupport,
      optionResistance: levels.optionResistance,
      rvol: row.rvol,
      rs: row.rs,
      rsAccel: row.rsAccel,
      trend5m: row.trend5m,
      futuresLabel: row.futLabel,
      optionsLabel,
      status: row.status,
      momentum: row.momentum,
      vwap: row.vwap,
      turnoverCr: row.turnoverCr,
      completeness: row.completeness,
      incomplete: row.incomplete,
      missingMetrics: row.missingMetrics.map(String),
      metrics: row.metrics,
      futConfirmation: row.futConfirmation,
      futPartial: row.futPartial,
      futRollover: row.futRollover,
      optionBias: levels.optionBias,
      optionBiasLabel: levels.optionBiasLabel,
      futuresLevels: levels.futures,
      secondarySupport: levels.supports[1] ?? null,
      secondaryResistance: levels.resistances[1] ?? null,
      fut: {
        ltp: row.futLtp,
        oi: row.futOi,
        oiChange: row.futOiChange,
        oiChangePct: row.futOiChangePct,
        basis: row.basis,
        expiry: u.futExpiry,
        buildup: row.buildup,
      },
      explanation,
      paused,
      scannedAt: Date.now(),
    };
  }

  private noDataCard(row: Stage1Row, reason: string): TradeCard {
    const setup = {
      state: "NO_TRADE" as SetupState,
      direction: row.dir,
      entryLow: null,
      entryHigh: null,
      entryType: null,
      stop: null,
      stopBasis: null,
      t1: null,
      t2: null,
      t3: null,
      risk: null,
      rr1: null,
      rr2: null,
      rrOk: null,
      reasons: [reason],
      insufficientData: true,
    };
    return {
      symbol: row.symbol,
      name: row.name,
      direction: row.dir,
      finalScore: null,
      setupState: "NO_TRADE",
      setup,
      ltp: row.ltp,
      changePct: row.changePct,
      support: null,
      resistance: null,
      optionSupport: null,
      optionResistance: null,
      rvol: row.rvol,
      rs: row.rs,
      rsAccel: row.rsAccel,
      trend5m: row.trend5m,
      futuresLabel: row.futLabel,
      optionsLabel: null,
      status: row.status,
      momentum: row.momentum,
      vwap: row.vwap,
      turnoverCr: row.turnoverCr,
      completeness: row.completeness,
      incomplete: row.incomplete,
      missingMetrics: row.missingMetrics.map(String),
      metrics: row.metrics,
      futConfirmation: row.futConfirmation,
      futPartial: row.futPartial,
      futRollover: row.futRollover,
      optionBias: "UNAVAILABLE",
      optionBiasLabel: "OPTION CHAIN NOT ANALYSED",
      futuresLevels: null,
      secondarySupport: null,
      secondaryResistance: null,
      fut: { ltp: row.futLtp, oi: row.futOi, oiChange: row.futOiChange, oiChangePct: row.futOiChangePct, basis: row.basis, expiry: null, buildup: row.buildup },
      explanation: { headline: reason, whyNow: "Deep analysis requires more real bars.", confirms: [], invalidates: [] },
      paused: true,
      scannedAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------- detail

  async getStockDetail(symbol: string): Promise<StockDetail | null> {
    const u = this.universe.find((x) => x.symbol === symbol);
    if (!u) return null;
    if (Date.now() - this.tokenLoadedAt > 60_000) await this.refreshToken();
    const ms = getMarketStatus();

    let candles1m: Candle[] = this.candlesCache.get(symbol) ?? [];
    try {
      const fresh = await this.client.intradayCandles(u.eqKey, "1minute");
      if (fresh.length) {
        candles1m = fresh;
        this.candlesCache.set(symbol, fresh);
      }
    } catch {
      /* keep cached */
    }
    const candles5m = resample(candles1m, 5);

    const row = this.payload?.rows.find((r) => r.symbol === symbol) ?? null;
    const card = this.payload?.candidatesDetail.find((c) => c.symbol === symbol) ?? null;

    let levels: LevelsResult | null = null;
    const ltp = row?.ltp ?? (candles1m.length ? candles1m[candles1m.length - 1].c : null);
    const deep = ltp != null ? await this.getDeep(u, ltp, ms.istDay) : null;
    if (ltp != null && candles1m.length >= 20 && candles5m.length >= 8) {
      levels = buildLevels(
        {
          ltp,
          candles1m,
          candles5m,
          prevDay: this.dayCache.prevDay.get(symbol) ?? null,
          vwap: row?.vwap ?? vwapFromCandles(candles1m),
          chain: deep?.chain ?? null,
          chainOiBaseline: deep?.oiBaseline ?? null,
          chainExpiry: deep?.expiry ?? null,
          futCandles1m: deep?.futCandles1m ?? null,
          futPrevDay: this.dayCache.futPrevDay.get(symbol) ?? null,
          futLtp: (u.futKey ? this.quotesCache.get(u.futKey)?.ltp : null) ?? row?.futLtp ?? null,
          futTurnoverCr:
            row?.futLtp != null && deep?.futVolumeToday != null
              ? (row.futLtp * deep.futVolumeToday) / 1e7
              : null,
          daysToExpiry: daysToExpiry(u.futExpiry),
          futExpiry: u.futExpiry,
        },
        this.cfg,
      );
    }

    // indicator overlays on 5-min bars
    let overlays: StockDetail["overlays"] = null;
    if (candles5m.length > 0) {
      const closes = candles5m.map((c) => c.c);
      const vwap1 = vwapSeries(candles1m);
      // session VWAP at each 5-min bucket end (from real 1-min bars)
      const vwap5: Array<number | null> = candles5m.map((b) => {
        let v: number | null = null;
        for (let i = candles1m.length - 1; i >= 0; i--) {
          if (candles1m[i].t <= b.t + 5 * 60_000 - 1) {
            v = vwap1[i];
            break;
          }
        }
        return v;
      });
      overlays = {
        vwap: vwap5,
        ema9: ema(closes, 9),
        ema20: ema(closes, 20),
        ema50: ema(closes, 50),
        bb: bollinger(closes, 20, 2),
      };
    }

    const atrNow = atr(candles5m, 14);
    void atrNow;

    const fq = u.futKey ? this.quotesCache.get(u.futKey) ?? null : null;
    const buildup = row?.buildup ?? null;

    let chainOut: StockDetail["chain"] = null;
    if (deep?.chain && ltp != null) {
      const strikes = deep.chain;
      const atm = strikes.reduce(
        (best, s, i) => (Math.abs(s.strike - ltp) < Math.abs(strikes[best].strike - ltp) ? i : best),
        0,
      );
      const sliced = strikes.slice(Math.max(0, atm - 12), atm + 13).map((s, i2) => {
        const absIdx = Math.max(0, atm - 12) + i2;
        const b = deep.oiBaseline?.get(s.strike);
        // ΔOI priority: real Upstox prev_oi → engine session baseline → N/A
        const ceChg =
          s.ceOiChg != null
            ? s.ceOiChg
            : s.ceOi != null && b?.ce != null
              ? s.ceOi - b.ce
              : null;
        const peChg =
          s.peOiChg != null
            ? s.peOiChg
            : s.peOi != null && b?.pe != null
              ? s.peOi - b.pe
              : null;
        return { ...s, ceOiChg: ceChg, peOiChg: peChg, isAtm: absIdx === atm };
      });
      chainOut = {
        expiry: deep.expiry,
        spot: ltp,
        strikes: sliced,
      };
    }

    return {
      symbol,
      name: u.name,
      row,
      card,
      levels,
      candles5m,
      overlays,
      futures: {
        symbol: u.futSymbol,
        expiry: u.futExpiry,
        ltp: fq?.ltp ?? row?.futLtp ?? null,
        changePct: row?.futChangePct ?? null,
        oi: fq?.oi ?? row?.futOi ?? null,
        oiChange: row?.futOiChange ?? null,
        oiChangePct: row?.futOiChangePct ?? null,
        basis: row?.basis ?? null,
        buildup: buildupLabel(buildup),
        candles5m: deep?.futCandles5m?.slice(-80) ?? null,
      },
      chain: chainOut,
      meta: {
        fetchedAt: new Date().toISOString(),
        marketOpen: ms.isOpen,
        status: row?.status ?? "UNAVAILABLE",
      },
    };
  }
}

// ------------------------------------------------------------------ helpers

function stripEarly<T extends { earlyDir: "LONG" | "SHORT" | null }>(s1: T): Omit<T, "earlyDir"> {
  const { earlyDir: _e, ...rest } = s1;
  void _e;
  return rest;
}

/** FIX 9 — is the current futures contract inside its rollover window? */
export function isRollover(futExpiry: string | null | undefined, daysBefore: number): boolean {
  if (!futExpiry) return false;
  const exp = new Date(`${futExpiry}T15:30:00+05:30`).getTime();
  if (!Number.isFinite(exp)) return false;
  const days = (exp - Date.now()) / 86_400_000;
  return days <= daysBefore;
}

/** 1-minute momentum still alive (used to keep EARLY from vanishing on one flat candle). */
function rowMomentumLive(
  s1: Pick<Stage1Row, "rvol" | "rs" | "rsAccel" | "aboveVwap"> & { ret5m?: number | null },
  cfg: ScannerConfig,
  dir: "LONG" | "SHORT" | null,
): boolean {
  if (s1.rvol == null || s1.rs == null) return false;
  if (s1.rvol < cfg.rvolMin * 0.8) return false;
  if (dir === "LONG") return s1.rs > 0 && s1.aboveVwap !== false;
  if (dir === "SHORT") return s1.rs < 0 && s1.aboveVwap !== true;
  return false;
}

// ------------------------------------------------------------------ singleton

const g = globalThis as unknown as { __foEngine?: Engine };

export function getEngine(): Engine {
  if (!g.__foEngine) {
    g.__foEngine = new Engine();
  }
  return g.__foEngine;
}

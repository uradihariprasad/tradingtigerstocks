/**
 * Two-stage scanning engine.
 *
 * STAGE 1 — fast, market-wide metrics from real Upstox quotes + 1-min candles.
 * STAGE 2 — deep structure: dynamic price S/R, option-chain S/R, confluence
 *           zones, trade setups with real entry/SL/targets and R:R.
 *
 * DATA INTEGRITY: every number is derived from actual Upstox responses.
 * When an input is missing the metric is `null` and the UI renders N/A —
 * no synthetic or estimated values are ever produced.
 */

import type { Candle, ChainStrike, Quote } from "@/lib/upstox";
import type { ScannerConfig } from "@/lib/config";
import {
  atr,
  consolidationZones,
  countTouches,
  lastEma,
  resample,
  swings,
  vwapFromCandles,
} from "@/lib/indicators";
import { minuteOfDayIST } from "@/lib/market";
import type { DataStatus } from "@/lib/market";

// ================================================================== types

export type Direction = "LONG" | "SHORT";
export type Trend = "BULLISH" | "BEARISH" | "NEUTRAL";
export type Momentum = "EARLY" | "CONFIRMED" | "NONE";
export type SetupState =
  | "LONG"
  | "SHORT"
  | "WAIT_FOR_BREAKOUT"
  | "WAIT_FOR_BREAKDOWN"
  | "WAIT_FOR_RETEST"
  | "NO_TRADE";
export type Buildup =
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "SHORT_COVERING"
  | "LONG_UNWINDING"
  | "AMBIGUOUS_OI_UP"
  | "AMBIGUOUS_OI_DOWN"
  | "NONE";

/** FIX 1 — per-metric validity state. Never silently ignore missing inputs. */
export type MetricStatus = "LIVE" | "RECENT" | "STALE" | "MISSING" | "UNAVAILABLE";

/** Required Stage-1 metrics that feed DATA COMPLETENESS %. */
export const REQUIRED_METRICS = [
  "price",
  "volume1m",
  "rvol",
  "rs",
  "rsAccel",
  "trend5m",
  "vwap",
  "futures",
] as const;
export type RequiredMetric = (typeof REQUIRED_METRICS)[number];

/**
 * Critical metrics: if any of these is missing/stale the score can never be a
 * fully valid trading score, regardless of the overall completeness percentage.
 */
export const CRITICAL_METRICS: RequiredMetric[] = ["price", "volume1m", "rvol", "rs"];

export type MetricMap = Record<RequiredMetric, MetricStatus>;

/** FIX 3 — derivatives interpretation, never a bare "FLAT". */
export type FuturesConfirmation = "BULLISH" | "BEARISH" | "NEUTRAL" | "AMBIGUOUS" | "PARTIAL";

export interface FuturesRead {
  buildup: Buildup | null;
  confirmation: FuturesConfirmation;
  label: string; // human text shown in the existing UI slot
  partial: boolean; // some inputs missing → FUTURES DATA PARTIAL
  priceChangePct: number | null;
  oi: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  volume: number | null;
  basis: number | null;
  basisPct: number | null;
  rollover: boolean; // near expiry / distorted contract
  notes: string[];
}

/** FIX 2 — option positioning classification from real OI + ΔOI + volume. */
export type OptionBias =
  | "PUT_BUILDUP"
  | "PUT_UNWINDING"
  | "CALL_BUILDUP"
  | "CALL_UNWINDING"
  | "NEUTRAL_AMBIGUOUS"
  | "UNAVAILABLE";

export interface NiftySnapshot {
  ltp: number | null;
  prevClose: number | null;
  open: number | null;
  changePct: number | null;
  candles1m: Candle[] | null;
  trend5m: Trend | null;
  aboveVwap: boolean | null;
  status: DataStatus;
}

export interface Stage1Row {
  symbol: string;
  name: string | null;
  ltp: number | null;
  prevClose: number | null;
  open: number | null;
  changePct: number | null;
  ret5m: number | null;
  ret15m: number | null;
  accel: number | null; // ret5m − prev 5m ret (price acceleration, % pts)
  volume: number | null;
  turnoverCr: number | null;
  rvol: number | null; // time-of-day-adjusted relative volume
  rs: number | null; // stock − NIFTY (% points)
  rsAccel: number | null; // change in RS over last 15 min (% points)
  sectorRs: number | null; // N/A — sector feeds not provided by Upstox
  vwap: number | null;
  aboveVwap: boolean | null;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  trend5m: Trend | null;
  structure: "HH_HL" | "LH_LL" | "MIXED" | null;
  futLtp: number | null;
  futChangePct: number | null;
  futOi: number | null;
  futOiChange: number | null;
  futOiChangePct: number | null;
  basis: number | null; // futures − spot
  buildup: Buildup | null;
  liquidityOk: boolean | null;
  scoreLong: number | null;
  scoreShort: number | null;
  dir: Direction | null;
  score: number | null; // MOMENTUM SCORE 0-100 (valid inputs only, weights preserved)
  status: DataStatus;
  momentum: Momentum;
  flags: string[]; // e.g. RVOL↑ RS↑ ACC↑
  scannedAt: number;
  // ---- FIX 1 / FIX 4 : data integrity
  metrics: MetricMap; // per-metric validity
  completeness: number; // DATA COMPLETENESS % (0-100)
  incomplete: boolean; // completeness < configured minimum
  missingMetrics: RequiredMetric[];
  // ---- FIX 3 : derivatives interpretation
  futVolume: number | null;
  futConfirmation: FuturesConfirmation;
  futLabel: string;
  futPartial: boolean;
  futRollover: boolean;
}

export type LevelKind =
  | "PDH"
  | "PDL"
  | "PDC"
  | "OPEN"
  | "ORH"
  | "ORL"
  | "SWING_H"
  | "SWING_L"
  | "CONSOL"
  | "VWAP"
  | "CE_OI"
  | "PE_OI"
  // FIX 5 — futures-derived structure (already basis-normalized to spot terms)
  | "FUT_PDH"
  | "FUT_PDL"
  | "FUT_SWING_H"
  | "FUT_SWING_L"
  | "FUT_CONSOL"
  | "FUT_BREAK";

/** Independent evidence family a level came from. */
export type LevelOrigin = "SPOT" | "FUT" | "OPT";

export function originOf(kind: LevelKind): LevelOrigin {
  if (kind === "CE_OI" || kind === "PE_OI") return "OPT";
  if (kind.startsWith("FUT_")) return "FUT";
  return "SPOT";
}

export interface ZoneSource {
  kind: LevelKind;
  price: number; // spot-equivalent price (futures levels are normalized)
  rawPrice?: number; // original futures print before basis normalization
  oi: number | null;
  oiChg: number | null;
  optVol: number | null;
  share: number | null; // OI share within chain window (0-1)
  strikeScore: number | null;
  futStrength?: number | null; // FIX 5 — futures level quality 0-100
  touches?: number | null;
}

export interface Zone {
  id: string;
  low: number;
  high: number;
  mid: number;
  kinds: LevelKind[];
  sources: ZoneSource[];
  touches: number;
  lastTouchAgoMin: number | null;
  strength: number; // 0-100 level strength
  hasOption: boolean;
  optionLabel: string | null; // e.g. "PE OI 2.4L @ 24,500"
  acceptedAbove: boolean;
  acceptedBelow: boolean;
  flipped: "UP" | "DOWN" | null;
  retested: boolean;
  side: "SUPPORT" | "RESISTANCE";
  distancePct: number;
  /** dynamic role derived from real interaction history */
  role: ZoneRole;
  roleLabel: string;
  // ---- FIX 6 : confluence engine
  origins: LevelOrigin[]; // which independent families overlap here
  confluence: number; // 0-100 confluence score
  confluenceReason: string; // e.g. "Spot structure + futures structure + CE positioning"
  hasFutures: boolean;
  futuresLabel: string | null; // e.g. "FUT swing ₹1,258 → ₹1,250 normalized"
  rank?: "PRIMARY" | "SECONDARY";
}

export interface StrikeInfo {
  strike: number;
  score: number; // 0-100
  oi: number | null;
  oiChg: number | null; // FIX 2 — real ΔOI, null when no session baseline
  vol: number | null;
  share: number;
  concentration: number;
  bias: OptionBias; // FIX 2 — buildup / unwinding classification
  biasLabel: string;
}

export interface FuturesLevels {
  available: boolean;
  reason: string | null; // why futures S/R is unavailable / low confidence
  basis: number | null;
  basisPct: number | null;
  rollover: boolean;
  confidence: number; // 0-100 confidence in futures-derived structure
  supportStrength: number | null; // FUTURES SUPPORT STRENGTH
  resistanceStrength: number | null; // FUTURES RESISTANCE STRENGTH
  support: { low: number; high: number; raw: number } | null; // normalized to spot terms
  resistance: { low: number; high: number; raw: number } | null;
}

export interface LevelsResult {
  zones: Zone[];
  supports: Zone[]; // ranked: [0] nearest strong, [1] secondary …
  resistances: Zone[];
  optionSupport: StrikeInfo | null;
  optionResistance: StrikeInfo | null;
  chainExpiry: string | null;
  maxCeOi: StrikeInfo | null;
  maxPeOi: StrikeInfo | null;
  futures: FuturesLevels;
  optionBias: OptionBias;
  optionBiasLabel: string;
}

export interface TradeSetup {
  state: SetupState;
  direction: Direction | null;
  entryLow: number | null;
  entryHigh: number | null;
  entryType: "BREAKOUT" | "BREAKDOWN" | "RETEST" | "CONTINUATION" | "ZONE" | null;
  stop: number | null;
  stopBasis: string | null; // structural invalidation description
  t1: number | null;
  t2: number | null;
  t3: number | null;
  risk: number | null;
  rr1: number | null;
  rr2: number | null;
  rrOk: boolean | null;
  reasons: string[];
  insufficientData: boolean;
}

export interface Explanation {
  headline: string;
  whyNow: string;
  confirms: string[];
  invalidates: string[];
}

export interface TradeCard {
  symbol: string;
  name: string | null;
  direction: Direction | null;
  finalScore: number | null;
  setupState: SetupState;
  setup: TradeSetup;
  ltp: number | null;
  changePct: number | null;
  support: Zone | null;
  resistance: Zone | null;
  optionSupport: StrikeInfo | null;
  optionResistance: StrikeInfo | null;
  rvol: number | null;
  rs: number | null;
  rsAccel: number | null;
  trend5m: Trend | null;
  futuresLabel: string | null;
  optionsLabel: string | null;
  status: DataStatus;
  momentum: Momentum;
  vwap: number | null;
  turnoverCr: number | null;
  // ---- FIX 1 / FIX 4
  completeness: number;
  incomplete: boolean;
  missingMetrics: string[];
  metrics: MetricMap | null;
  // ---- FIX 3
  futConfirmation: FuturesConfirmation;
  futPartial: boolean;
  futRollover: boolean;
  // ---- FIX 2
  optionBias: OptionBias;
  optionBiasLabel: string;
  // ---- FIX 5
  futuresLevels: FuturesLevels | null;
  // ---- FIX 6
  secondarySupport: Zone | null;
  secondaryResistance: Zone | null;
  fut: {
    ltp: number | null;
    oi: number | null;
    oiChange: number | null;
    oiChangePct: number | null;
    basis: number | null;
    expiry: string | null;
    buildup: Buildup | null;
  };
  explanation: Explanation;
  paused: boolean; // market closed / stale → suggestions frozen
  scannedAt: number;
}

// ================================================================== helpers

const nn = (x: number | null | undefined): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

const r2 = (x: number): number => Math.round(x * 100) / 100;
export const fmt = (x: number | null, d = 2): string => (x == null ? "N/A" : x.toFixed(d));

function scoreClamp(x: number): number {
  return Math.max(0, Math.min(100, x));
}

/**
 * FIX 4 — combine sub-scores WITHOUT redistributing the weight of missing
 * metrics. A null input contributes 0 to the numerator while its weight stays
 * in the denominator, so absent data can never inflate a score.
 */
function weightedScore(
  parts: Array<{ weight: number; score: number | null }>,
): number | null {
  let totalWeight = 0;
  let availableWeight = 0;
  let acc = 0;
  for (const p of parts) {
    totalWeight += p.weight;
    if (p.score == null) continue; // weight retained in denominator
    availableWeight += p.weight;
    acc += p.weight * p.score;
  }
  if (totalWeight <= 0 || availableWeight <= 0) return null;
  return scoreClamp(acc / totalWeight);
}

/** Freshness of a single observation, from real timestamps only. */
function freshness(
  valuePresent: boolean,
  ageMs: number | null,
  cfg: ScannerConfig,
): MetricStatus {
  if (!valuePresent) return "MISSING";
  if (ageMs == null) return "RECENT";
  if (ageMs < cfg.staleAfterSec * 1000) return "LIVE";
  if (ageMs < cfg.missingAfterSec * 1000) return "RECENT";
  return "STALE";
}

const METRIC_USABLE = (s: MetricStatus): boolean => s === "LIVE" || s === "RECENT";

/**
 * FIX 3 — interpret futures price + OI + volume together.
 * Never forces a directional read when price movement is insignificant.
 */
export function interpretFutures(args: {
  priceChangePct: number | null;
  oi: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  volume: number | null;
  basis: number | null;
  spot: number | null;
  rollover: boolean;
  cfg: ScannerConfig;
}): FuturesRead {
  const { priceChangePct: dp, oi, oiChange, oiChangePct, volume, basis, spot, rollover, cfg } = args;
  const notes: string[] = [];
  const basisPct = basis != null && spot != null && spot > 0 ? r2((basis / spot) * 100) : null;

  // partial when any core derivative input is unavailable
  const partial = dp == null || oi == null || oiChange == null;
  if (partial) {
    const missing: string[] = [];
    if (dp == null) missing.push("price change");
    if (oi == null) missing.push("OI");
    if (oiChange == null) missing.push("OI change");
    notes.push(`FUTURES DATA PARTIAL — missing ${missing.join(", ")}`);
    return {
      buildup: null,
      confirmation: "PARTIAL",
      label: "FUTURES DATA PARTIAL",
      partial: true,
      priceChangePct: dp,
      oi,
      oiChange,
      oiChangePct,
      volume,
      basis,
      basisPct,
      rollover,
      notes,
    };
  }

  const oiPct = oiChangePct ?? (oi > 0 ? (oiChange / oi) * 100 : 0);
  const priceFlat = Math.abs(dp) < cfg.futFlatPct;
  const oiFlat = Math.abs(oiPct) < cfg.futOiFlatPct;
  const oiUp = oiPct > 0;

  let buildup: Buildup;
  let confirmation: FuturesConfirmation;
  let label: string;

  if (oiFlat && priceFlat) {
    buildup = "NONE";
    confirmation = "NEUTRAL";
    label = "NEUTRAL — no meaningful price or OI shift";
  } else if (priceFlat) {
    buildup = oiUp ? "AMBIGUOUS_OI_UP" : "AMBIGUOUS_OI_DOWN";
    confirmation = "AMBIGUOUS";
    label = oiUp ? "AMBIGUOUS — OI INCREASE (price flat)" : "AMBIGUOUS — OI DECREASE (price flat)";
  } else if (dp > 0 && oiUp && !oiFlat) {
    buildup = "LONG_BUILDUP";
    confirmation = "BULLISH";
    label = "LONG BUILDUP CHARACTERISTICS";
  } else if (dp < 0 && oiUp && !oiFlat) {
    buildup = "SHORT_BUILDUP";
    confirmation = "BEARISH";
    label = "SHORT BUILDUP CHARACTERISTICS";
  } else if (dp > 0 && !oiUp && !oiFlat) {
    buildup = "SHORT_COVERING";
    confirmation = "BULLISH";
    label = "SHORT COVERING CHARACTERISTICS";
  } else if (dp < 0 && !oiUp && !oiFlat) {
    buildup = "LONG_UNWINDING";
    confirmation = "BEARISH";
    label = "LONG UNWINDING CHARACTERISTICS";
  } else {
    // price moved meaningfully but OI did not: a real, describable state —
    // the move is not backed by fresh derivative positioning.
    buildup = "NONE";
    confirmation = "NEUTRAL";
    label =
      dp > 0
        ? "PRICE UP · OI FLAT — move without fresh positioning"
        : "PRICE DOWN · OI FLAT — move without fresh positioning";
  }

  // FIX 9 — rollover distortion must not read as clean directional positioning
  if (rollover && buildup !== "NONE") {
    confirmation = confirmation === "NEUTRAL" ? "NEUTRAL" : "AMBIGUOUS";
    label = `${label} · ROLLOVER PERIOD — OI shift not treated as directional`;
    notes.push("Near-expiry rollover detected: futures OI change may reflect contract migration.");
  }
  if (oiChange !== 0) {
    notes.push(
      `OI ${oiChange > 0 ? "+" : ""}${oiChange.toLocaleString("en-IN")} (${oiPct > 0 ? "+" : ""}${oiPct.toFixed(2)}%) vs previous session`,
    );
  }
  if (volume != null) notes.push(`futures volume ${volume.toLocaleString("en-IN")}`);
  if (basisPct != null && Math.abs(basisPct) > 1.5) {
    notes.push(`Unusual basis ${basisPct > 0 ? "premium" : "discount"} ${Math.abs(basisPct).toFixed(2)}%`);
  }

  return {
    buildup,
    confirmation,
    label,
    partial: false,
    priceChangePct: dp,
    oi,
    oiChange,
    oiChangePct: oiChangePct ?? r2(oiPct),
    volume,
    basis,
    basisPct,
    rollover,
    notes,
  };
}

function pct(a: number, b: number): number {
  return ((a - b) / b) * 100;
}

/** Return close of the candle at or before `targetTs`. */
function closeAt(candles: Candle[], targetTs: number): number | null {
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.t <= targetTs) best = c;
    else break;
  }
  return best ? best.c : null;
}

// ================================================================== STAGE 1

export interface Stage1Input {
  symbol: string;
  name: string | null;
  quote: Quote | null;
  futQuote: Quote | null;
  candles1m: Candle[] | null;
  volProfile: Map<number, number> | null; // minuteOfDay -> avg cumulative session volume
  nifty: NiftySnapshot | null;
  futOiBaseline: number | null;
  /** previous futures session close (daily candle) — the correct change base */
  futPrevClose?: number | null;
  /** previous equity session close (daily candle) — the correct day-change base */
  prevDayClose?: number | null;
  /** previous futures session OI (daily candle) — same units as quote OI */
  futPrevOi?: number | null;
  /** intraday futures OI path (first → latest bar) when available (Stage 2) */
  futIntradayOiOpen?: number | null;
  futIntradayOiLast?: number | null;
  futIntradayOpen?: number | null;
  cfg: ScannerConfig;
  isOpen: boolean;
  nowMs: number;
  /**
   * Reference clock for staleness *of metrics*. During open market this equals
   * nowMs; when closed, the engine passes the feed's newest observation time
   * (session end) so freshness measures "did the feed deliver it", not
   * "how long ago did the user open the app".
   */
  asOfMs?: number;
  /** FIX 9 — near-expiry / distorted futures contract */
  rollover?: boolean;
}

export function computeStage1(inp: Stage1Input): Omit<Stage1Row, "momentum"> & { earlyDir: Direction | null } {
  const { cfg } = inp;
  const candles = inp.candles1m && inp.candles1m.length > 0 ? inp.candles1m : null;
  const lastCandle = candles ? candles[candles.length - 1] : null;

  const ltp = nn(inp.quote?.ltp) ?? (lastCandle ? lastCandle.c : null);
  // The equity/index quote echoes ohlc.close === ltp, which would fabricate a
  // 0% day change for every stock. Prefer the previous SESSION close from real
  // daily candles; ignore a quote prevClose identical to ltp (not a reference).
  const quotePrevClose = nn(inp.quote?.prevClose);
  const prevClose =
    nn(inp.prevDayClose) ??
    (quotePrevClose != null && ltp != null && Math.abs(quotePrevClose - ltp) > 1e-9
      ? quotePrevClose
      : null);
  const open = nn(inp.quote?.open) ?? (candles ? candles[0].o : null);
  const changePct = ltp != null && prevClose != null && prevClose > 0 ? pct(ltp, prevClose) : null;

  // --- momentum windows from real 1-min bars
  let ret5m: number | null = null;
  let ret15m: number | null = null;
  let accel: number | null = null;
  if (candles && candles.length >= 7) {
    const tLast = candles[candles.length - 1].t;
    const c5 = closeAt(candles, tLast - 5 * 60_000);
    const c10 = closeAt(candles, tLast - 10 * 60_000);
    const c15 = closeAt(candles, tLast - 15 * 60_000);
    const cNow = candles[candles.length - 1].c;
    if (c5 && c5 > 0) ret5m = pct(cNow, c5);
    if (c15 && c15 > 0) ret15m = pct(cNow, c15);
    if (c5 && c10 && c10 > 0 && c5 > 0) accel = pct(cNow, c5) - pct(c5, c10);
  }

  // --- volume / liquidity
  const dayVolume =
    nn(inp.quote?.volume) ??
    (candles ? candles.reduce((a, c) => a + c.v, 0) : null);
  const turnoverCr = dayVolume != null && ltp != null ? (dayVolume * ltp) / 1e7 : null;
  const liquidityOk = turnoverCr != null ? turnoverCr >= cfg.minTurnoverCr : null;

  // --- RVOL (time-of-day adjusted)
  let rvol: number | null = null;
  if (dayVolume != null && inp.volProfile && lastCandle) {
    const minute = minuteOfDayIST(lastCandle.t);
    const expected = inp.volProfile.get(minute) ?? inp.volProfile.get(minuteOfDayIST(Date.now()));
    if (expected != null && expected > 0) rvol = r2(dayVolume / expected);
  }

  // --- relative strength vs NIFTY (session return vs NIFTY session return,
  //     both from real 1-min candles; falls back to quote day-change)
  let sessionRet: number | null = null;
  if (candles && candles.length >= 2) {
    const o = candles[0].o;
    const cLast = ltp ?? candles[candles.length - 1].c;
    if (o > 0 && cLast != null) sessionRet = pct(cLast, o);
  }
  let niftySessionRet: number | null = null;
  const ncArr = inp.nifty?.candles1m;
  if (ncArr && ncArr.length >= 2) {
    const no = ncArr[0].o;
    const nl = ncArr[ncArr.length - 1].c;
    if (no > 0) niftySessionRet = pct(nl, no);
  }
  const niftyChg = nn(inp.nifty?.changePct);
  const stockRet = sessionRet ?? changePct;
  const niftyRet = niftySessionRet ?? niftyChg;
  const rs = stockRet != null && niftyRet != null ? r2(stockRet - niftyRet) : null;

  // --- RS acceleration: RS now vs RS 15 minutes ago, candle-based
  let rsAccel: number | null = null;
  if (candles && candles.length >= 20 && inp.nifty?.candles1m && inp.nifty.candles1m.length >= 20) {
    const so = open;
    const nc = inp.nifty.candles1m;
    const no = nc[0].o;
    if (so && no) {
      const tLast = candles[candles.length - 1].t;
      const sNow = closeAt(candles, tLast);
      const sPrev = closeAt(candles, tLast - 15 * 60_000);
      const nNow = closeAt(nc, tLast);
      const nPrev = closeAt(nc, tLast - 15 * 60_000);
      if (sNow && sPrev && nNow && nPrev) {
        const rsNow = pct(sNow, so) - pct(nNow, no);
        const rsPrev = pct(sPrev, so) - pct(nPrev, no);
        rsAccel = r2(rsNow - rsPrev);
      }
    }
  }

  // --- VWAP (Upstox average trade price preferred; else candle-derived)
  const vwap = nn(inp.quote?.averagePrice) ?? (candles ? vwapFromCandles(candles) : null);
  const aboveVwap = ltp != null && vwap != null && vwap > 0 ? ltp > vwap : null;

  // --- 5-min trend structure
  let ema9v: number | null = null;
  let ema20v: number | null = null;
  let ema50v: number | null = null;
  let trend5m: Trend | null = null;
  let structure: Stage1Row["structure"] = null;
  if (candles && candles.length >= 40) {
    const c5 = resample(candles, 5);
    const closes = c5.map((c) => c.c);
    ema9v = lastEma(closes, 9);
    ema20v = lastEma(closes, 20);
    ema50v = lastEma(closes, 50);
    const sw = swings(c5, 2, 2);
    const hh = sw.highs.length >= 2 && sw.highs[sw.highs.length - 1].price > sw.highs[sw.highs.length - 2].price;
    const hl = sw.lows.length >= 2 && sw.lows[sw.lows.length - 1].price > sw.lows[sw.lows.length - 2].price;
    const lh = sw.highs.length >= 2 && sw.highs[sw.highs.length - 1].price < sw.highs[sw.highs.length - 2].price;
    const ll = sw.lows.length >= 2 && sw.lows[sw.lows.length - 1].price < sw.lows[sw.lows.length - 2].price;
    if (hh && hl) structure = "HH_HL";
    else if (lh && ll) structure = "LH_LL";
    else structure = "MIXED";
    const bullStack = ema9v != null && ema20v != null && ema9v > ema20v && (ema50v == null || ema20v > ema50v);
    const bearStack = ema9v != null && ema20v != null && ema9v < ema20v && (ema50v == null || ema20v < ema50v);
    const last5 = closes[closes.length - 1];
    if (bullStack && structure === "HH_HL" && (ema9v == null || last5 > ema9v * 0.999)) trend5m = "BULLISH";
    else if (bearStack && structure === "LH_LL" && (ema9v == null || last5 < ema9v * 1.001)) trend5m = "BEARISH";
    else if (bullStack) trend5m = aboveVwap === true ? "BULLISH" : "NEUTRAL";
    else if (bearStack) trend5m = aboveVwap === false ? "BEARISH" : "NEUTRAL";
    else trend5m = "NEUTRAL";
  }

  // --- futures confirmation (price + OI + volume together)
  const futLtp = nn(inp.futQuote?.ltp);
  const quotePrev = nn(inp.futQuote?.prevClose);
  // The futures quote echoes ohlc.close === ltp after/at times during the
  // session, which would fabricate a 0% change. Prefer the previous futures
  // SESSION close from real daily candles; ignore a quote prevClose that is
  // identical to ltp (not a real reference), then fall back to today's open.
  const futPrevRef =
    nn(inp.futPrevClose) ??
    (quotePrev != null && futLtp != null && Math.abs(quotePrev - futLtp) > 1e-9 ? quotePrev : null) ??
    nn(inp.futIntradayOpen);
  const futChangePct =
    futLtp != null && futPrevRef != null && futPrevRef > 0 ? r2(pct(futLtp, futPrevRef)) : null;

  const futOi = nn(inp.futQuote?.oi) ?? nn(inp.futIntradayOiLast);
  // OI reference priority: previous SESSION OI (daily candle, same units as the
  // quote) → intraday first-bar OI → engine session baseline. Never estimated.
  const futOiRef =
    nn(inp.futPrevOi) ?? nn(inp.futIntradayOiOpen) ?? nn(inp.futOiBaseline);
  const futOiChange = futOi != null && futOiRef != null ? futOi - futOiRef : null;
  const futOiChangePct =
    futOiChange != null && futOiRef != null && futOiRef > 0
      ? r2((futOiChange / futOiRef) * 100)
      : null;
  const basis = futLtp != null && ltp != null ? r2(futLtp - ltp) : null;
  const futVolume = nn(inp.futQuote?.volume);
  const futRead = interpretFutures({
    priceChangePct: futChangePct,
    oi: futOi,
    oiChange: futOiChange,
    oiChangePct: futOiChangePct,
    volume: futVolume,
    basis,
    spot: ltp,
    rollover: inp.rollover === true,
    cfg,
  });
  const buildup: Buildup | null = futRead.buildup;

  // --- data status
  let status: DataStatus = "UNAVAILABLE";
  if (ltp != null) {
    const age = inp.quote?.ts != null ? inp.nowMs - inp.quote.ts : 0;
    if (!inp.isOpen) status = candles ? "STALE" : "PARTIAL";
    else if (age != null && age >= 0 && age < 60_000) status = candles ? "LIVE" : "PARTIAL";
    else if (age != null && age >= 0 && age < 5 * 60_000) status = "RECENT";
    else status = "STALE";
  }

  // --- sub-scores (0-100); null when the underlying data is unavailable
  const rvolScore =
    rvol != null ? scoreClamp(((rvol - 1) / Math.max(0.0001, cfg.rvolHigh - 1)) * 100) : null;
  const longRsScore = rs != null ? scoreClamp(((rs + 1) / (cfg.rsHigh + 1)) * 100) : null;
  const shortRsScore = rs != null ? scoreClamp(((1 - rs) / (cfg.rsHigh + 1)) * 100) : null;
  const longAccelScore = rsAccel != null ? scoreClamp(50 + rsAccel * 66) : null;
  const shortAccelScore = rsAccel != null ? scoreClamp(50 - rsAccel * 66) : null;
  const longTrendScore = trend5m != null ? (trend5m === "BULLISH" ? 100 : trend5m === "NEUTRAL" ? 45 : 0) : null;
  const shortTrendScore = trend5m != null ? (trend5m === "BEARISH" ? 100 : trend5m === "NEUTRAL" ? 45 : 0) : null;
  const longVwapScore = aboveVwap != null ? (aboveVwap ? 100 : 20) : null;
  const shortVwapScore = aboveVwap != null ? (aboveVwap ? 20 : 100) : null;
  // futures sub-score: only a real, unambiguous read scores directionally.
  // PARTIAL / ambiguous data yields null (weight retained, no credit) or 50.
  const futDirScore = (dir: Direction): number | null => {
    if (futRead.partial || buildup == null) return null;
    if (buildup === "AMBIGUOUS_OI_UP" || buildup === "AMBIGUOUS_OI_DOWN") return 50;
    if (buildup === "NONE") return 50;
    if (dir === "LONG") {
      return buildup === "LONG_BUILDUP" ? 100 : buildup === "SHORT_COVERING" ? 65 : buildup === "LONG_UNWINDING" ? 15 : 0;
    }
    return buildup === "SHORT_BUILDUP" ? 100 : buildup === "LONG_UNWINDING" ? 65 : buildup === "SHORT_COVERING" ? 15 : 0;
  };
  const futLongScore = futDirScore("LONG");
  const futShortScore = futDirScore("SHORT");
  const liqScore =
    turnoverCr != null ? scoreClamp((Math.log10(1 + turnoverCr) / Math.log10(1 + cfg.minTurnoverCr * 40)) * 100) : null;

  const w = cfg.stage1Weights;
  const scoreLong = weightedScore([
    { weight: w.rvol, score: rvolScore },
    { weight: w.relativeStrength, score: longRsScore },
    { weight: w.rsAcceleration, score: longAccelScore },
    { weight: w.trend5m, score: longTrendScore },
    { weight: w.vwap, score: longVwapScore },
    { weight: w.futures, score: futLongScore },
    { weight: w.liquidity, score: liqScore },
  ]);
  const scoreShort = weightedScore([
    { weight: w.rvol, score: rvolScore },
    { weight: w.relativeStrength, score: shortRsScore },
    { weight: w.rsAcceleration, score: shortAccelScore },
    { weight: w.trend5m, score: shortTrendScore },
    { weight: w.vwap, score: shortVwapScore },
    { weight: w.futures, score: futShortScore },
    { weight: w.liquidity, score: liqScore },
  ]);

  let dir: Direction | null = null;
  if (scoreLong != null && scoreShort != null) dir = scoreLong >= scoreShort ? "LONG" : "SHORT";
  const score = dir === "LONG" ? scoreLong : scoreShort;

  // --- EARLY momentum flags (1-minute detection)
  const flags: string[] = [];
  if (rvol != null && rvol >= cfg.rvolMin) flags.push("RVOL↑");
  if (rs != null && rs > 0) flags.push("RS+");
  if (rs != null && rs < 0) flags.push("RS-");
  if (rsAccel != null && rsAccel > 0.1) flags.push("ACC↑");
  if (rsAccel != null && rsAccel < -0.1) flags.push("ACC↓");
  if (aboveVwap === true) flags.push(">VWAP");
  if (aboveVwap === false) flags.push("<VWAP");

  let earlyDir: Direction | null = null;
  const earlyLong =
    rvol != null &&
    rvol >= cfg.rvolMin &&
    rs != null &&
    rs > 0 &&
    (rsAccel == null || rsAccel > 0) &&
    aboveVwap === true &&
    (ret5m == null || ret5m > 0);
  const earlyShort =
    rvol != null &&
    rvol >= cfg.rvolMin &&
    rs != null &&
    rs < 0 &&
    (rsAccel == null || rsAccel < 0) &&
    aboveVwap === false &&
    (ret5m == null || ret5m < 0);
  if (earlyLong && !earlyShort) earlyDir = "LONG";
  else if (earlyShort && !earlyLong) earlyDir = "SHORT";

  // ---- FIX 1 : per-metric validity + DATA COMPLETENESS %
  const asOf = inp.asOfMs ?? inp.nowMs;
  // quote timestamps stamped AFTER the session end collapse onto the session
  // clock when the market is closed (final quote = session snapshot)
  const sessionClamped = (ts: number): number =>
    !inp.isOpen && inp.asOfMs != null && ts > asOf ? asOf : ts;
  const quoteAge =
    inp.quote?.ts != null ? Math.max(0, asOf - sessionClamped(inp.quote.ts)) : null;
  const lastBarAge = lastCandle ? Math.max(0, asOf - (lastCandle.t + 60_000)) : null;
  const metrics: MetricMap = {
    price: freshness(ltp != null, quoteAge, cfg),
    volume1m: freshness(lastCandle != null && dayVolume != null, lastBarAge, cfg),
    // derived metrics inherit the freshness of the bar series they came from
    rvol: rvol == null ? (inp.volProfile ? "MISSING" : "UNAVAILABLE") : freshness(true, lastBarAge, cfg),
    rs: rs == null ? (inp.nifty?.ltp == null ? "UNAVAILABLE" : "MISSING") : freshness(true, lastBarAge, cfg),
    rsAccel: rsAccel == null ? "MISSING" : freshness(true, lastBarAge, cfg),
    trend5m: trend5m == null ? "MISSING" : freshness(true, lastBarAge, cfg),
    vwap: vwap == null ? "MISSING" : freshness(true, lastBarAge, cfg),
    futures:
      inp.futQuote == null
        ? "UNAVAILABLE"
        : futRead.partial
          ? "MISSING"
          : freshness(
              true,
              inp.futQuote.ts != null ? Math.max(0, asOf - sessionClamped(inp.futQuote.ts)) : null,
              cfg,
            ),
  };
  const missingMetrics = REQUIRED_METRICS.filter((m) => !METRIC_USABLE(metrics[m]));
  const completeness = r2(((REQUIRED_METRICS.length - missingMetrics.length) / REQUIRED_METRICS.length) * 100);
  const missingCritical = CRITICAL_METRICS.filter((m) => !METRIC_USABLE(metrics[m]));
  const incomplete = completeness < cfg.minCompletenessPct || missingCritical.length > 0;

  return {
    symbol: inp.symbol,
    name: inp.name,
    ltp,
    prevClose,
    open,
    changePct: changePct != null ? r2(changePct) : null,
    ret5m: ret5m != null ? r2(ret5m) : null,
    ret15m: ret15m != null ? r2(ret15m) : null,
    accel: accel != null ? r2(accel) : null,
    volume: dayVolume,
    turnoverCr: turnoverCr != null ? r2(turnoverCr) : null,
    rvol,
    rs,
    rsAccel,
    sectorRs: null, // sector index data is not provided by Upstox → N/A
    vwap: vwap != null ? r2(vwap) : null,
    aboveVwap,
    ema9: ema9v != null ? r2(ema9v) : null,
    ema20: ema20v != null ? r2(ema20v) : null,
    ema50: ema50v != null ? r2(ema50v) : null,
    trend5m,
    structure,
    futLtp,
    futChangePct: futChangePct != null ? r2(futChangePct) : null,
    futOi,
    futOiChange,
    futOiChangePct,
    basis,
    buildup,
    liquidityOk,
    scoreLong: scoreLong != null ? r2(scoreLong) : null,
    scoreShort: scoreShort != null ? r2(scoreShort) : null,
    dir,
    score: score != null ? r2(score) : null,
    status,
    flags,
    scannedAt: Date.now(),
    metrics,
    completeness,
    incomplete,
    missingMetrics: [...missingMetrics],
    futVolume,
    futConfirmation: futRead.confirmation,
    futLabel: futRead.label,
    futPartial: futRead.partial,
    futRollover: futRead.rollover,
    earlyDir,
  };
}

// ================================================================== STAGE 2 — levels

const KIND_WEIGHT: Record<LevelKind, number> = {
  PDH: 16,
  PDL: 16,
  PDC: 10,
  OPEN: 8,
  ORH: 10,
  ORL: 10,
  SWING_H: 8,
  SWING_L: 8,
  CONSOL: 10,
  VWAP: 12,
  CE_OI: 0,
  PE_OI: 0,
  // futures structure contributes through its own confidence-weighted term
  FUT_PDH: 0,
  FUT_PDL: 0,
  FUT_SWING_H: 0,
  FUT_SWING_L: 0,
  FUT_CONSOL: 0,
  FUT_BREAK: 0,
};

/**
 * Dynamic role of a level, derived only from real interaction history
 * (how price actually behaved at the zone) plus real option positioning.
 */
export type ZoneRole =
  | "STRONG_SUPPORT"
  | "SUPPORT_HOLDING"
  | "SUPPORT_FORMING"
  | "SUPPORT_WEAKENING"
  | "BROKEN_RESISTANCE_NOW_SUPPORT"
  | "STRONG_RESISTANCE"
  | "RESISTANCE_CAPPING"
  | "RESISTANCE_FORMING"
  | "RESISTANCE_WEAKENING"
  | "BROKEN_SUPPORT_NOW_RESISTANCE"
  | "RETESTING"
  | "UNTESTED"
  | "INSUFFICIENT_DATA";

export const ZONE_ROLE_LABEL: Record<ZoneRole, string> = {
  STRONG_SUPPORT: "STRONG SUPPORT",
  SUPPORT_HOLDING: "SUPPORT HOLDING",
  SUPPORT_FORMING: "SUPPORT FORMING",
  SUPPORT_WEAKENING: "SUPPORT WEAKENING",
  BROKEN_RESISTANCE_NOW_SUPPORT: "BROKEN RESISTANCE → SUPPORT",
  STRONG_RESISTANCE: "STRONG RESISTANCE",
  RESISTANCE_CAPPING: "RESISTANCE CAPPING",
  RESISTANCE_FORMING: "RESISTANCE FORMING",
  RESISTANCE_WEAKENING: "RESISTANCE WEAKENING",
  BROKEN_SUPPORT_NOW_RESISTANCE: "BROKEN SUPPORT → RESISTANCE",
  RETESTING: "RETESTING NOW",
  UNTESTED: "UNTESTED",
  INSUFFICIENT_DATA: "INSUFFICIENT DATA",
};

interface ZoneBehaviour {
  hasData: boolean;
  flipped: "UP" | "DOWN" | null;
  acceptedAbove: boolean;
  acceptedBelow: boolean;
  retested: boolean;
  holdsAbove: number; // traded into the zone and closed back above (support defended)
  holdsBelow: number; // traded into the zone and closed back below (resistance defended)
  recentHoldsAbove: number;
  recentHoldsBelow: number;
  recentInside: number; // recent closes stuck inside the zone (level being eaten into)
  recentTouch: boolean;
  recentlyFormed: boolean;
  everTouched: boolean;
}

/**
 * Last genuine regime change: price must have been SUSTAINED on one side of
 * the zone and then SUSTAINED on the other. Simply being on one side for the
 * whole session is NOT a break — that was the old bug which labelled every
 * level "broken".
 */
function lastSustainedFlip(
  sides: number[],
  sustain: number,
): { dir: "UP" | "DOWN"; index: number } | null {
  const runs: Array<{ s: number; start: number; end: number }> = [];
  for (let i = 0; i < sides.length; i++) {
    const s = sides[i];
    if (s === 0) continue; // inside the zone — not a side
    const last = runs[runs.length - 1];
    if (last && last.s === s) last.end = i;
    else runs.push({ s, start: i, end: i });
  }
  for (let i = runs.length - 1; i > 0; i--) {
    const cur = runs[i];
    const prev = runs[i - 1];
    if (cur.s === prev.s) continue;
    if (cur.end - cur.start + 1 >= sustain && prev.end - prev.start + 1 >= sustain) {
      return { dir: cur.s > 0 ? "UP" : "DOWN", index: cur.start };
    }
  }
  return null;
}

/** Measure how price actually interacted with the zone (real candles only). */
function zoneBehaviour(low: number, high: number, c1: Candle[], c5: Candle[]): ZoneBehaviour {
  const empty: ZoneBehaviour = {
    hasData: false,
    flipped: null,
    acceptedAbove: false,
    acceptedBelow: false,
    retested: false,
    holdsAbove: 0,
    holdsBelow: 0,
    recentHoldsAbove: 0,
    recentHoldsBelow: 0,
    recentInside: 0,
    recentTouch: false,
    recentlyFormed: false,
    everTouched: false,
  };
  if (c5.length < 4 || c1.length < 10) return empty;

  const sides = c5.map((c) => (c.c > high ? 1 : c.c < low ? -1 : 0));
  const flip = lastSustainedFlip(sides, 2);
  const lastClose = c5[c5.length - 1].c;
  const nowSide = lastClose > high ? 1 : lastClose < low ? -1 : 0;
  // a flip only stands while price is still on (or at) the new side
  const flipped: "UP" | "DOWN" | null =
    flip && ((flip.dir === "UP" && nowSide >= 0) || (flip.dir === "DOWN" && nowSide <= 0))
      ? flip.dir
      : null;

  let holdsAbove = 0;
  let holdsBelow = 0;
  let firstTouch = -1;
  let everTouched = false;
  for (let i = 0; i < c1.length; i++) {
    const c = c1[i];
    const entered = c.l <= high && c.h >= low;
    if (!entered) continue;
    everTouched = true;
    if (firstTouch < 0) firstTouch = i;
    if (c.c > high) holdsAbove++;
    else if (c.c < low) holdsBelow++;
  }

  const win = Math.min(30, Math.max(10, Math.floor(c1.length * 0.15)));
  const recent = c1.slice(-win);
  let recentHoldsAbove = 0;
  let recentHoldsBelow = 0;
  let recentInside = 0;
  let recentTouch = false;
  for (const c of recent) {
    const entered = c.l <= high && c.h >= low;
    if (entered) recentTouch = true;
    if (c.c >= low && c.c <= high) recentInside++;
    else if (entered && c.c > high) recentHoldsAbove++;
    else if (entered && c.c < low) recentHoldsBelow++;
  }

  let retested = false;
  if (flip) {
    retested = c5.slice(flip.index).some((c) => c.l <= high && c.h >= low);
  }

  return {
    hasData: true,
    flipped,
    acceptedAbove: flipped === "UP",
    acceptedBelow: flipped === "DOWN",
    retested,
    holdsAbove,
    holdsBelow,
    recentHoldsAbove,
    recentHoldsBelow,
    recentInside,
    recentTouch,
    recentlyFormed: firstTouch >= 0 && firstTouch > c1.length * 0.6,
    everTouched,
  };
}

/** Assign the dynamic role from behaviour + level quality + option positioning. */
function classifyZoneRole(
  b: ZoneBehaviour,
  side: "SUPPORT" | "RESISTANCE",
  strength: number,
  confluence: number,
  touches: number,
  optionBias: OptionBias | null,
  strongAt: number,
): ZoneRole {
  if (!b.hasData) return "INSUFFICIENT_DATA";
  if (b.flipped === "UP") return "BROKEN_RESISTANCE_NOW_SUPPORT";
  if (b.flipped === "DOWN") return "BROKEN_SUPPORT_NOW_RESISTANCE";

  const isSup = side === "SUPPORT";
  const holds = isSup ? b.holdsAbove : b.holdsBelow;
  const recentHolds = isSup ? b.recentHoldsAbove : b.recentHoldsBelow;
  const unwinding = isSup ? optionBias === "PUT_UNWINDING" : optionBias === "CALL_UNWINDING";
  const writing = isSup ? optionBias === "PUT_BUILDUP" : optionBias === "CALL_BUILDUP";

  if (!b.everTouched && touches === 0) return "UNTESTED";
  if (b.recentTouch && b.recentInside >= 1 && recentHolds === 0) return "RETESTING";

  // being eaten into / positioning leaving the level → weakening
  const weakening =
    unwinding ||
    (b.recentInside >= 2 && recentHolds === 0) ||
    (touches >= 4 && holds <= 1);
  if (weakening) return isSup ? "SUPPORT_WEAKENING" : "RESISTANCE_WEAKENING";

  // repeatedly defended + high quality → strong
  const strong =
    strength >= strongAt &&
    confluence >= 60 &&
    (holds >= 2 || (holds >= 1 && writing));
  if (strong) return isSup ? "STRONG_SUPPORT" : "STRONG_RESISTANCE";

  if (holds >= 1) return isSup ? "SUPPORT_HOLDING" : "RESISTANCE_CAPPING";
  if (b.recentlyFormed || touches <= 1) return isSup ? "SUPPORT_FORMING" : "RESISTANCE_FORMING";
  return isSup ? "SUPPORT_HOLDING" : "RESISTANCE_CAPPING";
}

/** FIX 2 — classify option positioning at a strike from OI + ΔOI + volume. */
function classifyStrike(
  side: "ce" | "pe",
  oi: number | null,
  oiChg: number | null,
  vol: number | null,
): { bias: OptionBias; label: string } {
  if (oi == null) return { bias: "UNAVAILABLE", label: "OI unavailable" };
  if (oiChg == null) {
    // ΔOI genuinely unavailable — never estimated
    return { bias: "NEUTRAL_AMBIGUOUS", label: "ΔOI = N/A — positioning not classifiable" };
  }
  const material = Math.abs(oiChg) >= Math.max(1, oi * 0.03);
  if (!material) return { bias: "NEUTRAL_AMBIGUOUS", label: "NEUTRAL / AMBIGUOUS — no material OI shift" };
  const hasVol = vol != null && vol > 0;
  if (side === "pe") {
    return oiChg > 0
      ? { bias: "PUT_BUILDUP", label: `PUT BUILDUP CHARACTERISTICS${hasVol ? "" : " (volume N/A)"}` }
      : { bias: "PUT_UNWINDING", label: `PUT UNWINDING${hasVol ? "" : " (volume N/A)"}` };
  }
  return oiChg > 0
    ? { bias: "CALL_BUILDUP", label: `CALL BUILDUP CHARACTERISTICS${hasVol ? "" : " (volume N/A)"}` }
    : { bias: "CALL_UNWINDING", label: `CALL UNWINDING${hasVol ? "" : " (volume N/A)"}` };
}

export interface DeepInputs {
  ltp: number;
  candles1m: Candle[];
  candles5m: Candle[];
  prevDay: Candle | null;
  vwap: number | null;
  chain: ChainStrike[] | null;
  chainOiBaseline: Map<number, { ce: number | null; pe: number | null }> | null;
  chainExpiry: string | null;
  // ---- FIX 5 : futures structural inputs (Stage-2 only)
  futCandles1m?: Candle[] | null;
  futPrevDay?: Candle | null;
  futLtp?: number | null;
  futTurnoverCr?: number | null;
  daysToExpiry?: number | null;
  futExpiry?: string | null;
}

/**
 * FIX 5 + FIX 9 — derive support/resistance from the actual futures contract and
 * normalize every level into spot-equivalent terms using the live basis.
 * No averaging of spot and futures prices is performed.
 */
function buildFuturesLevels(inp: DeepInputs, cfg: ScannerConfig): {
  meta: FuturesLevels;
  sources: ZoneSource[];
} {
  const spot = inp.ltp;
  const futLtp = nn(inp.futLtp ?? null);
  const fc1 = inp.futCandles1m ?? null;
  const none = (reason: string): { meta: FuturesLevels; sources: ZoneSource[] } => ({
    meta: {
      available: false,
      reason,
      basis: futLtp != null ? r2(futLtp - spot) : null,
      basisPct: futLtp != null && spot > 0 ? r2(((futLtp - spot) / spot) * 100) : null,
      rollover: (inp.daysToExpiry ?? 99) <= cfg.rolloverDaysBefore,
      confidence: 0,
      supportStrength: null,
      resistanceStrength: null,
      support: null,
      resistance: null,
    },
    sources: [],
  });

  if (futLtp == null) return none("FUTURES DATA UNAVAILABLE — no futures quote");
  if (!fc1 || fc1.length < 30) return none("INSUFFICIENT DATA — futures candles unavailable");

  const basis = futLtp - spot;
  const basisPct = spot > 0 ? (basis / spot) * 100 : 0;
  const rollover = (inp.daysToExpiry ?? 99) <= cfg.rolloverDaysBefore;
  const thinLiquidity =
    inp.futTurnoverCr != null && inp.futTurnoverCr < cfg.futMinTurnoverCr;

  // normalize a futures print into spot-equivalent terms (subtract basis)
  const toSpot = (p: number): number => p - basis;

  const fc5 = resample(fc1, 5);
  const sw = swings(fc5, 2, 2);
  const totalFutVol = fc1.reduce((a, c) => a + c.v, 0);

  const raw: Array<{ kind: LevelKind; price: number; touches: number; vol: number }> = [];
  for (const s of sw.highs.slice(-5)) {
    const t = countTouches(fc1, s.price, cfg.zoneTolerancePct / 2);
    raw.push({ kind: "FUT_SWING_H", price: s.price, touches: t.touches, vol: 0 });
  }
  for (const s of sw.lows.slice(-5)) {
    const t = countTouches(fc1, s.price, cfg.zoneTolerancePct / 2);
    raw.push({ kind: "FUT_SWING_L", price: s.price, touches: t.touches, vol: 0 });
  }
  if (inp.futPrevDay) {
    raw.push({ kind: "FUT_PDH", price: inp.futPrevDay.h, touches: 0, vol: 0 });
    raw.push({ kind: "FUT_PDL", price: inp.futPrevDay.l, touches: 0, vol: 0 });
  }
  for (const z of consolidationZones(fc1, 0.25).sort((a, b) => b.timeCount - a.timeCount).slice(0, 2)) {
    raw.push({ kind: "FUT_CONSOL", price: z.mid, touches: 0, vol: totalFutVol > 0 ? z.volume / totalFutVol : 0 });
  }

  if (raw.length === 0) return none("INSUFFICIENT DATA — no futures structure formed");

  // confidence: liquidity + basis stability + rollover state
  let confidence = 100;
  const notes: string[] = [];
  if (rollover) {
    confidence -= 40;
    notes.push("rollover period");
  }
  if (thinLiquidity) {
    confidence -= 30;
    notes.push("thin futures turnover");
  }
  if (Math.abs(basisPct) > 1.5) {
    confidence -= 20;
    notes.push("distorted basis");
  }
  confidence = Math.max(0, confidence);

  // strength of each futures level from real reactions/recency/volume
  const now = Date.now();
  const scored = raw.map((r) => {
    const touch = countTouches(fc1, r.price, cfg.zoneTolerancePct / 2);
    const recency =
      touch.lastTouchT != null
        ? now - touch.lastTouchT < 20 * 60_000
          ? 18
          : now - touch.lastTouchT < 60 * 60_000
            ? 12
            : 6
        : 0;
    const swingPart = r.kind === "FUT_SWING_H" || r.kind === "FUT_SWING_L" ? 22 : r.kind === "FUT_PDH" || r.kind === "FUT_PDL" ? 26 : 16;
    const volPart = Math.min(20, r.vol * 90);
    const touchPart = Math.min(24, touch.touches * 8);
    const strength = scoreClamp((swingPart + volPart + touchPart + recency) * (confidence / 100));
    return { ...r, strength, touches: touch.touches };
  });

  const tol = Math.max((spot * cfg.zoneTolerancePct) / 100, spot * 0.002);
  const normSupports = scored
    .map((s) => ({ ...s, norm: toSpot(s.price) }))
    .filter((s) => s.norm < spot)
    .sort((a, b) => b.strength - a.strength);
  const normResists = scored
    .map((s) => ({ ...s, norm: toSpot(s.price) }))
    .filter((s) => s.norm >= spot)
    .sort((a, b) => b.strength - a.strength);

  const bestS = normSupports[0] ?? null;
  const bestR = normResists[0] ?? null;

  const sources: ZoneSource[] = scored.map((s) => ({
    kind: s.kind,
    price: r2(toSpot(s.price)), // spot-equivalent
    rawPrice: r2(s.price),
    oi: null,
    oiChg: null,
    optVol: null,
    share: null,
    strikeScore: null,
    futStrength: Math.round(s.strength),
    touches: s.touches,
  }));

  return {
    meta: {
      available: true,
      reason: notes.length ? `Reduced confidence: ${notes.join(", ")}` : null,
      basis: r2(basis),
      basisPct: r2(basisPct),
      rollover,
      confidence: Math.round(confidence),
      supportStrength: bestS ? Math.round(bestS.strength) : null,
      resistanceStrength: bestR ? Math.round(bestR.strength) : null,
      support: bestS ? { low: r2(bestS.norm - tol / 2), high: r2(bestS.norm + tol / 2), raw: r2(bestS.price) } : null,
      resistance: bestR ? { low: r2(bestR.norm - tol / 2), high: r2(bestR.norm + tol / 2), raw: r2(bestR.price) } : null,
    },
    sources,
  };
}

function strikeScores(
  chain: ChainStrike[] | null,
  spot: number,
  windowPct: number,
  baseline: Map<number, { ce: number | null; pe: number | null }> | null,
): { ce: StrikeInfo[]; pe: StrikeInfo[] } {
  const empty = { ce: [] as StrikeInfo[], pe: [] as StrikeInfo[] };
  if (!chain || chain.length === 0 || !(spot > 0)) return empty;
  const win = chain.filter(
    (s) => Math.abs(s.strike - spot) / spot <= windowPct / 100,
  );
  if (win.length === 0) return empty;
  const maxCeOi = Math.max(...win.map((s) => s.ceOi ?? 0), 1);
  const maxPeOi = Math.max(...win.map((s) => s.peOi ?? 0), 1);
  const maxCeVol = Math.max(...win.map((s) => s.ceVol ?? 0), 1);
  const maxPeVol = Math.max(...win.map((s) => s.peVol ?? 0), 1);
  // ΔOI source priority: Upstox `prev_oi` (real, always present intraday)
  // → intraday session baseline captured by this engine → N/A.
  const deltaOf = (st: ChainStrike, side: "ce" | "pe"): number | null => {
    const apiChg = side === "ce" ? st.ceOiChg : st.peOiChg;
    if (apiChg != null && Number.isFinite(apiChg)) return apiChg;
    const b = baseline?.get(st.strike);
    const oiNow = side === "ce" ? st.ceOi : st.peOi;
    const bb = side === "ce" ? b?.ce : b?.pe;
    if (oiNow != null && bb != null) return oiNow - bb;
    return null;
  };
  let maxCeChg = 1;
  let maxPeChg = 1;
  for (const st of win) {
    const dce = deltaOf(st, "ce");
    const dpe = deltaOf(st, "pe");
    if (dce != null) maxCeChg = Math.max(maxCeChg, Math.abs(dce));
    if (dpe != null) maxPeChg = Math.max(maxPeChg, Math.abs(dpe));
  }

  const build = (side: "ce" | "pe"): StrikeInfo[] => {
    return win.map((s, i) => {
      const oi = side === "ce" ? s.ceOi : s.peOi;
      const vol = side === "ce" ? s.ceVol : s.peVol;
      const maxOi = side === "ce" ? maxCeOi : maxPeOi;
      const maxVol = side === "ce" ? maxCeVol : maxPeVol;
      const neighbors: number[] = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(win.length - 1, i + 2); j++) {
        if (j === i) continue;
        const noi = side === "ce" ? win[j].ceOi : win[j].peOi;
        if (noi != null) neighbors.push(noi);
      }
      const avgN = neighbors.length ? neighbors.reduce((a, b) => a + b, 0) / neighbors.length : 0;
      const share = oi != null ? oi / maxOi : 0;
      const concentration = avgN > 0 && oi != null ? oi / avgN : 1;
      const oiChg: number | null = deltaOf(s, side);
      const maxChg = side === "ce" ? maxCeChg : maxPeChg;
      const dist = Math.abs(s.strike - spot) / spot;
      const distScore = dist <= 0.005 ? 10 : dist <= 0.01 ? 8 : dist <= 0.02 ? 5 : dist <= 0.05 ? 2 : 0;
      const { bias, label } = classifyStrike(side, oi, oiChg, vol);
      // fresh writing strengthens the level, unwinding weakens it (spec §11)
      const buildupMult =
        bias === "PUT_BUILDUP" || bias === "CALL_BUILDUP"
          ? 1.12
          : bias === "PUT_UNWINDING" || bias === "CALL_UNWINDING"
            ? 0.72
            : 1;
      const score = scoreClamp(
        (share * 42 +
          Math.min(1, Math.max(0, (concentration - 1) / 1.5)) * 14 +
          (vol != null ? (vol / maxVol) * 14 : 0) +
          // ΔOI magnitude is a first-class component of level strength
          (oiChg != null ? (Math.abs(oiChg) / maxChg) * 20 : 0) +
          distScore) *
          buildupMult,
      );
      return {
        strike: s.strike,
        score: r2(score),
        oi,
        oiChg,
        vol,
        share: r2(share * 100) / 100,
        concentration: r2(concentration * 100) / 100,
        bias,
        biasLabel: label,
      };
    });
  };

  const ce = build("ce").sort((a, b) => b.score - a.score);
  const pe = build("pe").sort((a, b) => b.score - a.score);
  return { ce, pe };
}

export function buildLevels(inp: DeepInputs, cfg: ScannerConfig): LevelsResult {
  const spot = inp.ltp;
  const atr5 = atr(inp.candles5m, 14);
  const tol = Math.max((spot * cfg.zoneTolerancePct) / 100, atr5 != null ? atr5 * 0.5 : spot * 0.002);

  const sources: ZoneSource[] = [];
  const push = (kind: LevelKind, price: number | null, extra?: Partial<ZoneSource>) => {
    if (price == null || !(price > 0)) return;
    sources.push({
      kind,
      price,
      oi: extra?.oi ?? null,
      oiChg: extra?.oiChg ?? null,
      optVol: extra?.optVol ?? null,
      share: extra?.share ?? null,
      strikeScore: extra?.strikeScore ?? null,
    });
  };

  // ---- previous day levels
  if (inp.prevDay) {
    push("PDH", inp.prevDay.h);
    push("PDL", inp.prevDay.l);
    push("PDC", inp.prevDay.c);
  }

  // ---- opening structure
  if (inp.candles1m.length > 0) {
    push("OPEN", inp.candles1m[0].o);
    const orEnd = inp.candles1m[0].t + cfg.openingRangeMinutes * 60_000;
    const orBars = inp.candles1m.filter((c) => c.t <= orEnd);
    if (orBars.length >= Math.min(5, cfg.openingRangeMinutes)) {
      push("ORH", Math.max(...orBars.map((c) => c.h)));
      push("ORL", Math.min(...orBars.map((c) => c.l)));
    }
  }

  // ---- intraday swings (5-min fractals)
  const sw = swings(inp.candles5m, 2, 2);
  for (const s of sw.highs.slice(-6)) push("SWING_H", s.price);
  for (const s of sw.lows.slice(-6)) push("SWING_L", s.price);

  // ---- consolidation / volume-at-price zones
  const consol = consolidationZones(inp.candles1m, 0.25)
    .sort((a, b) => b.timeCount - a.timeCount)
    .slice(0, 3);
  const totalV = inp.candles1m.reduce((a, c) => a + c.v, 0);
  for (const z of consol) {
    push("CONSOL", z.mid, { share: totalV > 0 ? z.volume / totalV : null });
  }

  // ---- VWAP
  push("VWAP", inp.vwap);

  // ---- FIX 5 : futures structure, basis-normalized into spot terms
  const futures = buildFuturesLevels(inp, cfg);
  for (const fs of futures.sources) sources.push(fs);

  // ---- option chain strikes
  const { ce, pe } = strikeScores(inp.chain, spot, cfg.chainWindowPct, inp.chainOiBaseline);
  const ceByStrike = new Map(ce.map((s) => [s.strike, s]));
  const peByStrike = new Map(pe.map((s) => [s.strike, s]));
  for (const info of ce.slice(0, 3)) {
    push("CE_OI", info.strike, { oi: info.oi, oiChg: info.oiChg, optVol: info.vol, share: info.share, strikeScore: info.score });
  }
  for (const info of pe.slice(0, 3)) {
    push("PE_OI", info.strike, { oi: info.oi, oiChg: info.oiChg, optVol: info.vol, share: info.share, strikeScore: info.score });
  }

  // ---- cluster into zones
  const sorted = [...sources].sort((a, b) => a.price - b.price);
  const clusters: ZoneSource[][] = [];
  for (const s of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur) {
      const cMax = Math.max(...cur.map((x) => x.price));
      const cMin = Math.min(...cur.map((x) => x.price));
      const mid = (cMax + cMin) / 2;
      if (Math.max(s.price, cMax) - Math.min(s.price, cMin) <= tol * 2) {
        cur.push(s);
        void mid;
        continue;
      }
    }
    clusters.push([s]);
  }

  const now = Date.now();
  const zones: Zone[] = [];
  for (let zi = 0; zi < clusters.length; zi++) {
    const cl = clusters[zi];
    const low = Math.min(...cl.map((s) => s.price));
    const high = Math.max(...cl.map((s) => s.price));
    const mid = (low + high) / 2;
    const kinds = [...new Set(cl.map((s) => s.kind))];
    const { touches, lastTouchT } = countTouches(inp.candles1m, mid, cfg.zoneTolerancePct / 2);

    // option part
    const optSources = cl.filter((s) => s.kind === "CE_OI" || s.kind === "PE_OI");
    const bestOpt = optSources.reduce<ZoneSource | null>(
      (acc, s) => (acc == null || (s.strikeScore ?? 0) > (acc.strikeScore ?? 0) ? s : acc),
      null,
    );

    // structure part (distinct kinds only)
    const structPart = Math.min(
      35,
      kinds.filter((k) => k !== "CE_OI" && k !== "PE_OI").reduce((a, k) => a + KIND_WEIGHT[k], 0),
    );
    const touchPart = Math.min(20, touches * 5);
    const optPart = Math.min(
      25,
      bestOpt?.strikeScore != null ? bestOpt.strikeScore * 0.25 : 0,
    );
    const consolSrc = cl.find((s) => s.kind === "CONSOL");
    const volPart = Math.min(10, (consolSrc?.share ?? 0) * 60);

    // real interaction history: sustained-regime flip detection + defence counts.
    // (Previously any zone below price counted as a "break", which mislabelled
    //  every level as broken support/resistance.)
    const behaviour = zoneBehaviour(low, high, inp.candles1m, inp.candles5m);
    const acceptedAbove = behaviour.acceptedAbove;
    const acceptedBelow = behaviour.acceptedBelow;
    const retested = behaviour.retested;

    const recencyPart =
      lastTouchT != null
        ? now - lastTouchT < 20 * 60_000
          ? 8
          : now - lastTouchT < 60 * 60_000
            ? 5
            : 2
        : 0;
    const breakoutPart = (acceptedAbove || acceptedBelow ? 6 : 0) + (retested ? 4 : 0);

    // ---- FIX 5/6 : futures evidence inside this cluster (already normalized)
    const futSources = cl.filter((s) => originOf(s.kind) === "FUT");
    const bestFut = futSources.reduce<ZoneSource | null>(
      (acc, s) => (acc == null || (s.futStrength ?? 0) > (acc.futStrength ?? 0) ? s : acc),
      null,
    );
    const futPart = Math.min(
      20,
      bestFut?.futStrength != null ? (bestFut.futStrength * futures.meta.confidence) / 100 / 5 : 0,
    );

    const strength = scoreClamp(
      structPart + touchPart + optPart + volPart + recencyPart + breakoutPart + futPart,
    );

    // ---- FIX 6 : confluence across INDEPENDENT families (no averaging of prices)
    const origins = [...new Set(cl.map((s) => originOf(s.kind)))];
    const originNames: string[] = [];
    if (origins.includes("SPOT")) originNames.push("Spot structure");
    if (origins.includes("FUT")) originNames.push("futures structure");
    if (origins.includes("OPT")) {
      originNames.push(
        optSources.some((s) => s.kind === "CE_OI") && mid >= spot
          ? "CE positioning"
          : optSources.some((s) => s.kind === "PE_OI") && mid < spot
            ? "PE positioning"
            : "option positioning",
      );
    }
    if (consolSrc || touches >= 2) originNames.push("volume/price reaction");
    // base 40 for a single family, +25 per additional independent family
    const confluence = scoreClamp(
      40 * Math.min(1, origins.length) +
        25 * Math.max(0, origins.length - 1) +
        (touches >= 2 ? 8 : 0) +
        (consolSrc ? 6 : 0) +
        (retested ? 6 : 0) +
        (strength >= 60 ? 5 : 0),
    );

    const optLabel = bestOpt
      ? `${bestOpt.kind === "CE_OI" ? "CE" : "PE"} OI ${bestOpt.oi != null ? compactNum(bestOpt.oi) : "N/A"} @ ${trimNum(bestOpt.price)}`
      : null;
    const futLabel = bestFut
      ? `FUT ${bestFut.kind.replace("FUT_", "").toLowerCase()} ₹${trimNum(bestFut.rawPrice ?? bestFut.price)} → ₹${trimNum(bestFut.price)} normalized`
      : null;

    const zoneSide: "SUPPORT" | "RESISTANCE" = mid >= spot ? "RESISTANCE" : "SUPPORT";
    const zoneOptBias: OptionBias | null = bestOpt
      ? (bestOpt.kind === "CE_OI" ? ceByStrike.get(bestOpt.price) : peByStrike.get(bestOpt.price))?.bias ?? null
      : null;
    const strongAt = Math.max(60, cfg.levelMinStrength + 20);
    const role = classifyZoneRole(
      behaviour,
      zoneSide,
      strength,
      confluence,
      touches,
      zoneOptBias,
      strongAt,
    );

    zones.push({
      id: `z${zi}`,
      low: r2(low),
      high: r2(high),
      mid: r2(mid),
      kinds,
      sources: cl,
      touches,
      lastTouchAgoMin: lastTouchT != null ? Math.round((now - lastTouchT) / 60000) : null,
      strength: Math.round(strength),
      hasOption: optSources.length > 0,
      optionLabel: optLabel,
      acceptedAbove,
      acceptedBelow,
      flipped: acceptedAbove ? "UP" : acceptedBelow ? "DOWN" : null,
      retested,
      side: zoneSide,
      distancePct: r2(Math.abs(mid - spot) / spot * 100),
      role,
      roleLabel: ZONE_ROLE_LABEL[role],
      origins,
      confluence: Math.round(confluence),
      confluenceReason: originNames.join(" + ") || "single source",
      hasFutures: futSources.length > 0,
      futuresLabel: futLabel,
    });
  }

  // FIX 6 — hierarchy ranked by (strength × confluence) with distance decay
  const rankScore = (z: Zone) =>
    ((z.strength * 0.6 + z.confluence * 0.4) as number) * decay(z.distancePct);
  const supports = zones.filter((z) => z.mid < spot).sort((a, b) => rankScore(b) - rankScore(a));
  const resistances = zones.filter((z) => z.mid >= spot).sort((a, b) => rankScore(b) - rankScore(a));
  supports.forEach((z, i) => (z.rank = i === 0 ? "PRIMARY" : i === 1 ? "SECONDARY" : undefined));
  resistances.forEach((z, i) => (z.rank = i === 0 ? "PRIMARY" : i === 1 ? "SECONDARY" : undefined));

  // option-only S/R — highest OI is NOT assumed to be the level; the ranked
  // score already blends OI, ΔOI, volume, concentration and distance, and
  // unwinding strikes are demoted before this selection.
  const aboveCe = ce.filter((s) => s.strike >= spot).sort((a, b) => b.score - a.score);
  const belowPe = pe.filter((s) => s.strike <= spot).sort((a, b) => b.score - a.score);
  const optionResistance = aboveCe[0] ?? ce[0] ?? null;
  const optionSupport = belowPe[0] ?? pe[0] ?? null;

  // FIX 2 — overall option positioning read (never assumes max OI = level)
  let optionBias: OptionBias = "UNAVAILABLE";
  let optionBiasLabel = "OPTION CHAIN UNAVAILABLE";
  if (optionSupport || optionResistance) {
    const cands = [optionSupport, optionResistance].filter(Boolean) as StrikeInfo[];
    const strongest = cands.reduce((a, b) => (b.score > a.score ? b : a));
    optionBias = strongest.bias;
    optionBiasLabel = strongest.biasLabel;
    if (cands.every((c) => c.oiChg == null)) {
      optionBias = "NEUTRAL_AMBIGUOUS";
      optionBiasLabel = "ΔOI = N/A — positioning not classifiable";
    }
  }

  return {
    zones: zones.sort((a, b) => a.low - b.low),
    supports,
    resistances,
    optionSupport,
    optionResistance,
    chainExpiry: inp.chainExpiry,
    maxCeOi: ce[0] ?? null,
    maxPeOi: pe[0] ?? null,
    futures: futures.meta,
    optionBias,
    optionBiasLabel,
  };
}

function decay(distPct: number): number {
  return 1 / (1 + distPct * 0.9);
}

export function compactNum(n: number): string {
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export function trimNum(n: number): string {
  return n % 1 === 0 ? n.toLocaleString("en-IN") : n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// ================================================================== STAGE 2 — setups

export function buildSetup(
  dir: Direction,
  ltp: number,
  levels: LevelsResult,
  cfg: ScannerConfig,
): TradeSetup {
  const reasons: string[] = [];
  const buf = cfg.breakoutBufferBps / 10_000;
  const slBuf = cfg.slBufferBps / 10_000;

  const empty: TradeSetup = {
    state: "NO_TRADE",
    direction: dir,
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
    reasons,
    insufficientData: false,
  };

  const strong = (z: Zone) => z.strength >= cfg.levelMinStrength;
  const supports = levels.supports.filter(strong);
  const resistances = levels.resistances.filter(strong);

  if (supports.length === 0 && resistances.length === 0) {
    empty.reasons.push("INSUFFICIENT DATA — no dynamic S/R zones identified");
    empty.insufficientData = true;
    return empty;
  }

  const S = supports[0] ?? null; // nearest strong support (strength×distance ranked)
  const R = resistances[0] ?? null;

  const pickTargets = (list: Zone[], entry: number, above: boolean): number[] => {
    return list
      .map((z) => z.mid)
      .filter((p) => (above ? p > entry * 1.001 : p < entry * 0.999))
      .sort((a, b) => (above ? a - b : b - a))
      .slice(0, 3);
  };

  const finalize = (
    state: SetupState,
    entry: number,
    entryLow: number,
    entryHigh: number,
    entryType: TradeSetup["entryType"],
    stop: number,
    stopBasis: string,
  ): TradeSetup => {
    const longSide = dir === "LONG";
    const targets = pickTargets(longSide ? resistances : supports, entry, longSide);
    const risk = longSide ? entry - stop : stop - entry;
    const rr1 = risk > 0 && targets[0] != null ? Math.abs(targets[0] - entry) / risk : null;
    const rr2 = risk > 0 && targets[1] != null ? Math.abs(targets[1] - entry) / risk : null;
    const rrOk = rr1 != null ? rr1 >= cfg.minRR : null;
    if (risk <= 0) {
      empty.reasons.push("Stop placement not beyond entry — structure invalid");
      return empty;
    }
    if (rr1 == null) {
      empty.reasons.push(`No measurable ${longSide ? "resistance" : "support"} beyond entry — cannot compute R:R`);
      empty.insufficientData = true;
      return empty;
    }
    if (rr1 < cfg.minRR) {
      // FIX 7 — tradeability rule: momentum never overrides structural room
      const roomPct = Math.abs(targets[0] - entry) / entry * 100;
      empty.reasons.push(
        roomPct < 0.5
          ? `NO TRADE — INSUFFICIENT ROOM: nearest ${longSide ? "resistance" : "support"} only ${roomPct.toFixed(2)}% away (R:R ${rr1.toFixed(1)} < ${cfg.minRR.toFixed(1)})`
          : `NO TRADE — R:R ${rr1.toFixed(1)} below required ${cfg.minRR.toFixed(1)}`,
      );
      return empty;
    }
    // option-derived ceiling/floor must leave room too (FIX 7)
    const optCap = longSide ? levels.optionResistance : levels.optionSupport;
    if (optCap != null && optCap.score >= 60) {
      const capRoomPct = ((longSide ? optCap.strike - entry : entry - optCap.strike) / entry) * 100;
      if (capRoomPct > 0 && capRoomPct < 0.25) {
        empty.reasons.push(
          `NO TRADE — INSUFFICIENT ROOM: heavy ${longSide ? "CE" : "PE"} positioning at ${trimNum(optCap.strike)} caps upside (${capRoomPct.toFixed(2)}%)`,
        );
        return empty;
      }
    }
    return {
      state,
      direction: dir,
      entryLow: r2(entryLow),
      entryHigh: r2(entryHigh),
      entryType,
      stop: r2(stop),
      stopBasis,
      t1: targets[0] != null ? r2(targets[0]) : null,
      t2: targets[1] != null ? r2(targets[1]) : null,
      t3: targets[2] != null ? r2(targets[2]) : null,
      risk: r2(risk),
      rr1: rr1 != null ? r2(rr1) : null,
      rr2: rr2 != null ? r2(rr2) : null,
      rrOk,
      reasons,
      insufficientData: false,
    };
  };

  if (dir === "LONG") {
    // 1) retest of a broken resistance (flipped up + retest) → LONG at the shelf
    const flipped = levels.supports.find((z) => z.flipped === "UP");
    if (flipped && flipped.retested && spotNear(ltp, flipped.high, 0.6)) {
      const entry = flipped.high * (1 + buf);
      const stop = flipped.low * (1 - slBuf);
      return finalize("LONG", entry, flipped.mid, entry, "RETEST", stop, `broken resistance ₹${trimNum(flipped.low)}–₹${trimNum(flipped.high)} reclaimed as support`);
    }
    if (flipped && !flipped.retested) {
      const entry = flipped.high * (1 + buf);
      const stop = flipped.low * (1 - slBuf);
      return finalize("WAIT_FOR_RETEST", entry, flipped.mid, entry, "RETEST", stop, `retest shelf ₹${trimNum(flipped.low)}–₹${trimNum(flipped.high)}`);
    }
    // 2) parked under resistance → wait for breakout
    if (R && nearPct(ltp, R, cfg.breakoutProximityPct)) {
      const entry = R.high * (1 + buf);
      const stopBase = Math.max(R.low, S ? S.low : R.low);
      const stop = stopBase * (1 - slBuf);
      return finalize("WAIT_FOR_BREAKOUT", entry, R.mid, entry, "BREAKOUT", stop, `structure below breakout zone ₹${trimNum(stopBase)}`);
    }
    // 3) continuation above strong support
    if (S) {
      if (!R) {
        // clear air above — but need a measurable target; use 2R projection ONLY as T1? No: integrity — no synthetic target.
        const stop = S.low * (1 - slBuf);
        const risk = ltp - stop;
        if (risk > 0) {
          empty.reasons.push("INSUFFICIENT DATA — no resistance above to target");
          empty.insufficientData = true;
        }
        return empty;
      }
      const stop = S.low * (1 - slBuf);
      return finalize("LONG", ltp, Math.min(ltp, (S.high + ltp) / 2), ltp, "CONTINUATION", stop, `dynamic support ₹${trimNum(S.low)}–₹${trimNum(S.high)} (strength ${S.strength}/100)`);
    }
    empty.reasons.push("No strong dynamic support below price");
    return empty;
  }

  // SHORT — mirror
  const flippedDown = levels.resistances.find((z) => z.flipped === "DOWN");
  if (flippedDown && flippedDown.retested && spotNear(ltp, flippedDown.low, 0.6)) {
    const entry = flippedDown.low * (1 - buf);
    const stop = flippedDown.high * (1 + slBuf);
    return finalize("SHORT", entry, entry, flippedDown.mid, "RETEST", stop, `broken support ₹${trimNum(flippedDown.low)}–₹${trimNum(flippedDown.high)} flipped to resistance`);
  }
  if (flippedDown && !flippedDown.retested) {
    const entry = flippedDown.low * (1 - buf);
    const stop = flippedDown.high * (1 + slBuf);
    return finalize("WAIT_FOR_RETEST", entry, entry, flippedDown.low, "RETEST", stop, `retest lid ₹${trimNum(flippedDown.low)}–₹${trimNum(flippedDown.high)}`);
  }
  if (S && nearSupport(ltp, S, cfg.breakoutProximityPct)) {
    const entry = S.low * (1 - buf);
    const stopBase = Math.min(S.high, R ? R.high : S.high);
    const stop = stopBase * (1 + slBuf);
    return finalize("WAIT_FOR_BREAKDOWN", entry, entry, S.mid, "BREAKDOWN", stop, `structure above breakdown zone ₹${trimNum(stopBase)}`);
  }
  if (R) {
    if (!S) {
      empty.reasons.push("INSUFFICIENT DATA — no support below to target");
      empty.insufficientData = true;
      return empty;
    }
    const stop = R.high * (1 + slBuf);
    return finalize("SHORT", ltp, ltp, Math.max(ltp, (R.low + ltp) / 2), "CONTINUATION", stop, `dynamic resistance ₹${trimNum(R.low)}–₹${trimNum(R.high)} (strength ${R.strength}/100)`);
  }
  empty.reasons.push("No strong dynamic resistance above price");
  return empty;
}

function nearPct(ltp: number, z: Zone, pctRange: number): boolean {
  // price parked just under resistance
  return z.low >= ltp * 0.997 && ((z.low - ltp) / ltp) * 100 <= pctRange + 0.3;
}
function nearSupport(ltp: number, z: Zone, pctRange: number): boolean {
  return z.high <= ltp * 1.003 && ((ltp - z.high) / ltp) * 100 <= pctRange + 0.3;
}
function spotNear(ltp: number, price: number, pctRange: number): boolean {
  return Math.abs(ltp - price) / price <= pctRange / 100;
}

// ================================================================== STAGE 2 — final score + explanation

export function finalScore(
  row: Pick<Stage1Row, "rvol" | "rs" | "rsAccel" | "trend5m" | "buildup">,
  setup: TradeSetup,
  levels: LevelsResult,
  dir: Direction,
  cfg: ScannerConfig,
): number | null {
  const rvolScore = row.rvol != null ? scoreClamp(((row.rvol - 1) / Math.max(0.0001, cfg.rvolHigh - 1)) * 100) : null;
  const rsScore = row.rs != null ? scoreClamp(50 + (dir === "LONG" ? row.rs : -row.rs) * 25) : null;
  const accScore = row.rsAccel != null ? scoreClamp(50 + (dir === "LONG" ? row.rsAccel : -row.rsAccel) * 66) : null;
  const trendScore =
    row.trend5m != null
      ? (dir === "LONG" ? row.trend5m === "BULLISH" : row.trend5m === "BEARISH")
        ? 100
        : row.trend5m === "NEUTRAL"
          ? 40
          : 0
      : null;
  const usedZones = [setup.state.includes("BREAK") || setup.entryType === "BREAKOUT" || setup.entryType === "BREAKDOWN"
    ? levels.resistances[0]
    : levels.supports[0], dir === "LONG" ? levels.supports[0] : levels.resistances[0]]
    .filter(Boolean) as Zone[];
  const structScore = usedZones.length ? usedZones.reduce((a, z) => a + z.strength, 0) / usedZones.length : null;
  const srQuality = usedZones.length ? Math.min(100, usedZones.reduce((a, z) => a + z.strength, 0) / usedZones.length + (levels.zones.length >= 3 ? 10 : 0)) : null;
  const optConf =
    levels.optionSupport || levels.optionResistance
      ? Math.max(levels.optionSupport?.score ?? 0, levels.optionResistance?.score ?? 0) +
        (usedZones.some((z) => z.hasOption) ? 15 : 0)
      : null;
  const futScore =
    row.buildup != null
      ? dir === "LONG"
        ? row.buildup === "LONG_BUILDUP"
          ? 100
          : row.buildup === "SHORT_COVERING"
            ? 60
            : 20
        : row.buildup === "SHORT_BUILDUP"
          ? 100
          : row.buildup === "LONG_UNWINDING"
            ? 60
            : 20
      : null;
  const rrScore =
    setup.rr1 != null ? scoreClamp(((setup.rr1 - 1) / Math.max(0.0001, cfg.rrFullScore - 1)) * 100) : null;

  const w = cfg.stage2Weights;
  return weightedScore([
    { weight: w.priceStructure, score: structScore },
    { weight: w.rvol, score: rvolScore },
    { weight: w.relativeStrength, score: rsScore },
    { weight: w.rsAcceleration, score: accScore },
    { weight: w.srQuality, score: srQuality != null ? scoreClamp(srQuality) : null },
    { weight: w.optionConfluence, score: optConf != null ? scoreClamp(optConf) : null },
    { weight: w.futures, score: futScore },
    { weight: w.trend5m, score: trendScore },
    { weight: w.riskReward, score: rrScore },
  ]);
}

export function buildExplanation(
  symbol: string,
  dir: Direction,
  setup: TradeSetup,
  levels: LevelsResult,
  row: Pick<Stage1Row, "rvol" | "rs" | "rsAccel" | "trend5m" | "aboveVwap" | "buildup" | "futOiChangePct" | "ret5m" | "structure">,
): Explanation {
  const confirms: string[] = [];
  const invalidates: string[] = [];
  if (row.rvol != null) {
    if (row.rvol >= 1.5) confirms.push(`RVOL ${row.rvol.toFixed(1)}× time-of-day average volume`);
    else if (row.rvol < 1) invalidates.push(`RVOL only ${row.rvol.toFixed(2)}× — thin participation`);
  }
  if (row.rs != null) {
    if (dir === "LONG" && row.rs > 0) confirms.push(`outperforming NIFTY by +${row.rs.toFixed(2)}%`);
    else if (dir === "SHORT" && row.rs < 0) confirms.push(`underperforming NIFTY by ${row.rs.toFixed(2)}%`);
    else if (Math.abs(row.rs) > 0.3) invalidates.push(`RS ${row.rs >= 0 ? "+" : ""}${row.rs.toFixed(2)}% works against the direction`);
  }
  if (row.rsAccel != null) {
    if ((dir === "LONG" && row.rsAccel > 0.1) || (dir === "SHORT" && row.rsAccel < -0.1)) {
      confirms.push(`RS ${dir === "LONG" ? "accelerating" : "decaying"} (${row.rsAccel > 0 ? "+" : ""}${row.rsAccel.toFixed(2)} pts / 15 min)`);
    } else if ((dir === "LONG" && row.rsAccel < -0.2) || (dir === "SHORT" && row.rsAccel > 0.2)) {
      invalidates.push("relative strength is deteriorating");
    }
  }
  if (row.trend5m != null) {
    if ((dir === "LONG" && row.trend5m === "BULLISH") || (dir === "SHORT" && row.trend5m === "BEARISH")) {
      confirms.push(`5-minute trend ${row.trend5m.toLowerCase()} (${row.structure === "HH_HL" ? "higher highs / higher lows" : row.structure === "LH_LL" ? "lower highs / lower lows" : "EMA structure"})`);
    } else if (row.trend5m === "NEUTRAL") {
      invalidates.push("5-minute trend is not aligned");
    }
  }
  if (row.aboveVwap != null && ((dir === "LONG" && row.aboveVwap) || (dir === "SHORT" && !row.aboveVwap))) {
    confirms.push(`price ${row.aboveVwap ? "above" : "below"} VWAP`);
  }
  if (row.buildup && row.buildup !== "NONE") {
    const label =
      row.buildup === "LONG_BUILDUP" ? "long buildup" : row.buildup === "SHORT_BUILDUP" ? "short buildup" : row.buildup === "SHORT_COVERING" ? "short covering" : "long unwinding";
    const oiTxt = row.futOiChangePct != null ? ` (OI ${row.futOiChangePct > 0 ? "+" : ""}${row.futOiChangePct}%)` : "";
    const aligned = (dir === "LONG" && (row.buildup === "LONG_BUILDUP" || row.buildup === "SHORT_COVERING")) || (dir === "SHORT" && (row.buildup === "SHORT_BUILDUP" || row.buildup === "LONG_UNWINDING"));
    if (aligned) confirms.push(`futures show ${label}${oiTxt}`);
    else invalidates.push(`futures show ${label}${oiTxt} — contradicatory positioning`);
  }
  const optS = levels.optionSupport;
  const optR = levels.optionResistance;
  if (dir === "LONG" && optS?.oi != null) {
    confirms.push(`put writing base ${compactNum(optS.oi)} PE OI @ ${trimNum(optS.strike)}${optS.oiChg != null && optS.oiChg > 0 ? " (adding)" : ""}`);
  }
  if (dir === "SHORT" && optR?.oi != null) {
    confirms.push(`call writing ${compactNum(optR.oi)} CE OI @ ${trimNum(optR.strike)}${optR.oiChg != null && optR.oiChg > 0 ? " (adding)" : ""}`);
  }
  if (dir === "LONG" && optR != null && levels.resistances[0] && Math.abs(optR.strike - levels.resistances[0].mid) / levels.resistances[0].mid < 0.004) {
    confirms.push(`resistance zone overlaps the heaviest call strike ${trimNum(optR.strike)} — confluence`);
  }
  if (dir === "SHORT" && optS != null && levels.supports[0] && Math.abs(optS.strike - levels.supports[0].mid) / levels.supports[0].mid < 0.004) {
    confirms.push(`support zone overlaps the heaviest put strike ${trimNum(optS.strike)} — confluence`);
  }
  for (const r of setup.reasons) invalidates.push(r);

  const S = levels.supports[0];
  const R = levels.resistances[0];
  let headline: string;
  if (setup.state === "LONG" || setup.state === "SHORT") {
    headline = `${symbol} ${setup.state} — ${setup.entryType === "RETEST" ? "retest hold" : "continuation"} from ${dir === "LONG" && S ? `support ₹${trimNum(S.low)}–₹${trimNum(S.high)} (${S.strength}/100)` : dir === "SHORT" && R ? `resistance ₹${trimNum(R.low)}–₹${trimNum(R.high)} (${R.strength}/100)` : "dynamic structure"}.`;
  } else if (setup.state === "WAIT_FOR_BREAKOUT" && R) {
    headline = `${symbol} parked under resistance ₹${trimNum(R.low)}–₹${trimNum(R.high)} (${R.strength}/100) — breakout trigger armed.`;
  } else if (setup.state === "WAIT_FOR_BREAKDOWN" && S) {
    headline = `${symbol} sitting on support ₹${trimNum(S.low)}–₹${trimNum(S.high)} (${S.strength}/100) — breakdown trigger armed.`;
  } else if (setup.state === "WAIT_FOR_RETEST") {
    headline = `${symbol} broke the level — waiting for a successful retest before entry.`;
  } else {
    headline = `${symbol} filtered out — ${setup.reasons[0] ?? "structure does not support a quality trade"}.`;
  }

  let whyNow: string;
  switch (setup.entryType) {
    case "BREAKOUT":
      whyNow = `Price is compressing under ${trimNum(R?.high ?? 0)} after ${R?.touches ?? "N/A"} touches; a 5-min acceptance above the zone with volume completes the trigger at ₹${fmt(setup.entryHigh)}.`;
      break;
    case "BREAKDOWN":
      whyNow = `Price is pressing into ${trimNum(S?.low ?? 0)} after ${S?.touches ?? "N/A"} touches; a 5-min acceptance below the zone completes the trigger at ₹${fmt(setup.entryLow)}.`;
      break;
    case "RETEST":
      whyNow = "The level already broke and price is revisiting it; order-flow acceptance at the shelf is the live trigger.";
      break;
    case "CONTINUATION":
      whyNow = `Directional flow is already established (5-min ret ${row.ret5m != null ? `${row.ret5m > 0 ? "+" : ""}${row.ret5m}%` : "n/a"}) and next measured objective offers ≥ ${setup.rr1 != null ? setup.rr1.toFixed(1) : "?"}R.`;
      break;
    default:
      whyNow = "No immediate trigger — waiting for structure.";
  }

  if (setup.stop != null) {
    invalidates.unshift(
      `5-min close ${dir === "LONG" ? "below" : "above"} ₹${trimNum(setup.stop)}${setup.stopBasis ? ` — ${setup.stopBasis}` : ""}`,
    );
  }

  return {
    headline,
    whyNow,
    confirms: confirms.slice(0, 6),
    invalidates: invalidates.slice(0, 6),
  };
}

export function buildupLabel(b: Buildup | null): string | null {
  if (b == null) return null;
  return b === "LONG_BUILDUP"
    ? "Long buildup"
    : b === "SHORT_BUILDUP"
      ? "Short buildup"
      : b === "SHORT_COVERING"
        ? "Short covering"
        : b === "LONG_UNWINDING"
          ? "Long unwinding"
          : "Flat";
}

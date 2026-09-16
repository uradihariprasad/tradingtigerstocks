/**
 * ORDER FLOW DOMINANCE — independent additive module.
 *
 * Ranks the top buyer-dominating and seller-dominating F&O stocks from real
 * Upstox data only: 5-level bid/ask depth, order counts, total buy/sell
 * quantities, 1-minute candles, RVOL, VWAP, futures price+OI positioning and
 * existing momentum metrics.
 *
 * This measures MARKET PRESSURE, never participant identity. Missing inputs
 * are N/A (weight retained, never redistributed); stale or insufficient
 * critical data produces no dominance score.
 */

import type { Candle, Quote } from "@/lib/upstox";
import type { ScannerConfig } from "@/lib/config";
import type { Stage1Row } from "@/lib/scanner";
import type { DataStatus } from "@/lib/market";

// ------------------------------------------------------------------ types

export interface FlowObs {
  t: number;
  buyer: number | null;
  seller: number | null;
}

export type FlowTrend =
  | "ACCELERATING"
  | "WEAKENING"
  | "STABLE"
  | "REVERSING"
  | "COLLECTING DATA";

export interface FlowComponents {
  depth: number | null;
  orders: number | null;
  priceAction: number | null;
  volume: number | null;
  futures: number | null;
  vwap: number | null;
  accel: number | null;
}

export interface OrderFlowEntry {
  symbol: string;
  name: string | null;
  side: "BUYER" | "SELLER";
  ltp: number | null;
  changePct: number | null;
  score: number; // 0-100
  interpretation: "VERY STRONG" | "STRONG" | "MODERATE";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  conflicting: boolean;
  trend: FlowTrend;
  components: FlowComponents;
  depth: { bid: number | null; ask: number | null; imb: number | null };
  orders: { bid: number | null; ask: number | null; imb: number | null };
  totals: { buy: number | null; sell: number | null; imb: number | null };
  rvol: number | null;
  futLabel: string | null;
  vwap: number | null;
  vwapSustain: number | null; // fraction of recent closes on this side of VWAP
  vwapCrossings: number | null; // repeated crossings reduce confidence
  rsAccel: number | null;
  priceAccel: number | null;
  ret5m: number | null;
  status: DataStatus | "INSUFFICIENT DATA";
  completeness: number; // 0-100 over this module's inputs
  reason: string | null;
  scannedAt: number;
}

export interface OrderFlowResult {
  buyerScore: number | null;
  sellerScore: number | null;
  buyer: OrderFlowEntry | null;
  seller: OrderFlowEntry | null;
}

export interface OrderFlowPayload {
  buySide: OrderFlowEntry[];
  sellSide: OrderFlowEntry[];
  computedAt: number;
  universeConsidered: number;
}

// ------------------------------------------------------------------ helpers

const clamp = (x: number): number => Math.max(0, Math.min(100, x));
const nn = (x: number | null | undefined): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

/** Weighted score with weights preserved — missing parts keep their weight. */
function weighted(parts: Array<{ weight: number; score: number | null }>): number | null {
  let total = 0;
  let acc = 0;
  let any = false;
  for (const p of parts) {
    total += p.weight;
    if (p.score == null) continue;
    any = true;
    acc += p.weight * p.score;
  }
  if (total <= 0 || !any) return null;
  return clamp(acc / total);
}

function interpret(score: number): "VERY STRONG" | "STRONG" | "MODERATE" {
  if (score >= 80) return "VERY STRONG";
  if (score >= 70) return "STRONG";
  return "MODERATE";
}

/** Dominance trend from real previous observations only (never fabricated). */
export function dominanceTrend(side: "buyer" | "seller", history: FlowObs[]): FlowTrend {
  const pts = history
    .map((h) => (side === "buyer" ? h.buyer : h.seller))
    .filter((x): x is number => x != null);
  if (pts.length < 3) return "COLLECTING DATA";
  const [a, b, c] = pts.slice(-3);
  const d1 = b - a;
  const d2 = c - b;
  if (d1 >= 3 && d2 >= 3) return "ACCELERATING";
  if (d1 <= -3 && d2 <= -3) return "WEAKENING";
  if (Math.abs(d1) < 3 && Math.abs(d2) < 3) return "STABLE";
  if ((d1 > 3 && d2 < -3) || (d1 < -3 && d2 > 3)) return "REVERSING";
  return "STABLE";
}

// ------------------------------------------------------------------ engine

export function computeOrderFlow(args: {
  row: Stage1Row;
  quote: Quote | null;
  candles: Candle[];
  history: FlowObs[];
  cfg: ScannerConfig;
  nowMs: number;
}): OrderFlowResult {
  const { row, quote, candles, history, cfg, nowMs } = args;
  const none: OrderFlowResult = { buyerScore: null, sellerScore: null, buyer: null, seller: null };

  const stale = row.status === "STALE" || row.status === "UNAVAILABLE";
  const ltp = nn(row.ltp);
  const bidDepth = nn(quote?.bidDepth);
  const askDepth = nn(quote?.askDepth);
  const bidOrders = nn(quote?.bidOrders);
  const askOrders = nn(quote?.askOrders);
  const tbq = nn(quote?.buyQty);
  const tsq = nn(quote?.sellQty);
  const recent = candles.slice(-15);

  // ---- critical inputs for this module: price, depth, recent candles
  const missing: string[] = [];
  if (ltp == null) missing.push("price");
  if (bidDepth == null || askDepth == null) missing.push("depth");
  if (recent.length < 5) missing.push("1-min candles");

  const mkStatus = (): DataStatus | "INSUFFICIENT DATA" =>
    stale ? row.status : missing.length ? "INSUFFICIENT DATA" : row.status === "PARTIAL" ? "PARTIAL" : row.status;

  if (stale || missing.length > 0) {
    const reason = stale
      ? `DATA ${row.status} — dominance scoring paused`
      : `INSUFFICIENT DATA — missing ${missing.join(", ")}`;
    const emptyEntry = (side: "BUYER" | "SELLER"): OrderFlowEntry => ({
      symbol: row.symbol,
      name: row.name,
      side,
      ltp,
      changePct: nn(row.changePct),
      score: 0,
      interpretation: "MODERATE",
      confidence: "LOW",
      conflicting: false,
      trend: dominanceTrend(side === "BUYER" ? "buyer" : "seller", history),
      components: { depth: null, orders: null, priceAction: null, volume: null, futures: null, vwap: null, accel: null },
      depth: { bid: bidDepth, ask: askDepth, imb: null },
      orders: { bid: bidOrders, ask: askOrders, imb: null },
      totals: { buy: tbq, sell: tsq, imb: null },
      rvol: nn(row.rvol),
      futLabel: row.futLabel,
      vwap: nn(row.vwap),
      vwapSustain: null,
      vwapCrossings: null,
      rsAccel: nn(row.rsAccel),
      priceAccel: nn(row.accel),
      ret5m: nn(row.ret5m),
      status: mkStatus(),
      completeness: 0,
      reason,
      scannedAt: nowMs,
    });
    return {
      buyerScore: null,
      sellerScore: null,
      buyer: stale || missing.length ? emptyEntry("BUYER") : null,
      seller: stale || missing.length ? emptyEntry("SELLER") : null,
    };
  }

  // ---- 1) depth imbalance (20%) — 5-level depth + total quantity evidence
  const bd = bidDepth as number; // guaranteed by the critical-input guard above
  const ad = askDepth as number;
  const levelImb = bd + ad > 0 ? (bd - ad) / (bd + ad) : null;
  const totalImb = tbq != null && tsq != null && tbq + tsq > 0 ? (tbq - tsq) / (tbq + tsq) : null;
  const depthImb =
    levelImb != null && totalImb != null
      ? 0.6 * levelImb + 0.4 * totalImb
      : (levelImb ?? totalImb);
  const buyerDepthScore = depthImb != null ? clamp(50 + depthImb * 50) : null;

  // ---- 2) order-count imbalance (10%)
  const ordImb = bidOrders != null && askOrders != null && bidOrders + askOrders > 0 ? (bidOrders - askOrders) / (bidOrders + askOrders) : null;
  const buyerOrdersScore = ordImb != null ? clamp(50 + ordImb * 50) : null;

  // ---- 3) price-action pressure (20%) — real 1-min behaviour
  const upBars = recent.filter((c) => c.c >= c.o).length;
  const dirRatio = recent.length ? upBars / recent.length : null;
  const ret5m = nn(row.ret5m);
  const retScore = ret5m != null ? clamp(50 + ret5m * 60) : null;
  const win = candles.slice(-30);
  let mn = Infinity;
  let mx = -Infinity;
  for (const c of win) {
    mn = Math.min(mn, c.l);
    mx = Math.max(mx, c.h);
  }
  const lastClose = candles[candles.length - 1].c;
  const rangePos = mx > mn ? (lastClose - mn) / (mx - mn) : null; // 0 = low, 1 = high
  const buyerPriceAction = weighted([
    { weight: 40, score: retScore },
    { weight: 35, score: dirRatio != null ? dirRatio * 100 : null },
    { weight: 25, score: rangePos != null ? rangePos * 100 : null },
  ]);

  // ---- 4) volume / RVOL (15%) — direction-neutral participation
  const rvol = nn(row.rvol);
  const volumeScore = rvol != null ? clamp(((rvol - 1) / Math.max(0.0001, cfg.rvolHigh - 1)) * 100) : null;

  // ---- 5) futures positioning (20%) — characteristics only, never identity
  const futConf = row.futConfirmation;
  const buyerFutScore =
    futConf === "BULLISH" ? 100 : futConf === "BEARISH" ? 0 : futConf === "NEUTRAL" || futConf === "AMBIGUOUS" ? 50 : null;

  // ---- 6) VWAP / intraday structure (10%)
  const vwap = nn(row.vwap);
  let vwapSustain: number | null = null;
  let crossings = 0;
  if (vwap != null) {
    const vwin = candles.slice(-20);
    if (vwin.length >= 5) {
      let above = 0;
      let prevSide: number | null = null;
      for (const c of vwin) {
        const s = c.c > vwap ? 1 : -1;
        if (s > 0) above++;
        if (prevSide != null && s !== prevSide) crossings++;
        prevSide = s;
      }
      vwapSustain = above / vwin.length;
    }
  }
  const buyerVwapScore = vwapSustain != null ? vwapSustain * 100 : null;

  // ---- 7) momentum acceleration (5%)
  const rsAcc = nn(row.rsAccel);
  const pAcc = nn(row.accel);
  const buyerAccelScore =
    rsAcc != null || pAcc != null ? clamp(50 + (rsAcc ?? 0) * 45 + (pAcc ?? 0) * 30) : null;

  // ---- assemble BUYER
  const buyerComponents: FlowComponents = {
    depth: buyerDepthScore,
    orders: buyerOrdersScore,
    priceAction: buyerPriceAction,
    volume: volumeScore,
    futures: buyerFutScore,
    vwap: buyerVwapScore,
    accel: buyerAccelScore,
  };
  let buyerScore = weighted([
    { weight: 20, score: buyerDepthScore },
    { weight: 10, score: buyerOrdersScore },
    { weight: 20, score: buyerPriceAction },
    { weight: 15, score: volumeScore },
    { weight: 20, score: buyerFutScore },
    { weight: 10, score: buyerVwapScore },
    { weight: 5, score: buyerAccelScore },
  ]);

  // ---- assemble SELLER (mirror of directional components)
  const mirror = (x: number | null): number | null => (x == null ? null : 100 - x);
  const sellerComponents: FlowComponents = {
    depth: mirror(buyerDepthScore),
    orders: mirror(buyerOrdersScore),
    priceAction: mirror(buyerPriceAction),
    volume: volumeScore,
    futures: mirror(buyerFutScore),
    vwap: mirror(buyerVwapScore),
    accel: mirror(buyerAccelScore),
  };
  let sellerScore = weighted([
    { weight: 20, score: sellerComponents.depth },
    { weight: 10, score: sellerComponents.orders },
    { weight: 20, score: sellerComponents.priceAction },
    { weight: 15, score: volumeScore },
    { weight: 20, score: sellerComponents.futures },
    { weight: 10, score: sellerComponents.vwap },
    { weight: 5, score: sellerComponents.accel },
  ]);

  // ---- data completeness over this module's inputs
  const fields: Array<string | null> = [
    ltp != null ? "price" : null,
    bidDepth != null && askDepth != null ? "depth" : null,
    bidOrders != null && askOrders != null ? "orders" : null,
    buyerPriceAction != null ? "priceAction" : null,
    rvol != null ? "volume" : null,
    buyerFutScore != null ? "futures" : null,
    vwapSustain != null ? "vwap" : null,
    buyerAccelScore != null ? "accel" : null,
  ];
  const present = fields.filter(Boolean).length;
  const completeness = Math.round((present / fields.length) * 100);

  // ---- SIGNAL AGREEMENT: independent components must agree for high scores
  const agreementFor = (comps: FlowComponents): { ratio: number; n: number } => {
    const vals = Object.values(comps).filter((v): v is number => v != null);
    const agreeing = vals.filter((v) => v >= 55).length;
    return { ratio: vals.length ? agreeing / vals.length : 0, n: vals.length };
  };
  const buyerAgree = agreementFor(buyerComponents);
  const sellerAgree = agreementFor(sellerComponents);

  // repeated VWAP crossing reduces confidence (choppy, not sustained pressure)
  const chopPenalty = crossings >= 4 ? 0.85 : 1;

  let buyerConfidence: "HIGH" | "MEDIUM" | "LOW";
  let buyerConflicting = false;
  if (buyerScore != null && buyerScore >= 70 && buyerAgree.ratio < 0.5) {
    buyerScore = Math.min(buyerScore, 65); // CONFLICTING FLOW — cap
    buyerConflicting = true;
  }
  const buyerAgreeAdj = buyerAgree.ratio * chopPenalty;
  buyerConfidence =
    buyerAgreeAdj >= 0.7 && completeness >= 80 ? "HIGH" : buyerAgreeAdj >= 0.5 ? "MEDIUM" : "LOW";

  let sellerConfidence: "HIGH" | "MEDIUM" | "LOW";
  let sellerConflicting = false;
  if (sellerScore != null && sellerScore >= 70 && sellerAgree.ratio < 0.5) {
    sellerScore = Math.min(sellerScore, 65);
    sellerConflicting = true;
  }
  const sellerAgreeAdj = sellerAgree.ratio * chopPenalty;
  sellerConfidence =
    sellerAgreeAdj >= 0.7 && completeness >= 80 ? "HIGH" : sellerAgreeAdj >= 0.5 ? "MEDIUM" : "LOW";

  const mkEntry = (
    side: "BUYER" | "SELLER",
    score: number | null,
    comps: FlowComponents,
    confidence: "HIGH" | "MEDIUM" | "LOW",
    conflicting: boolean,
    sustain: number | null,
  ): OrderFlowEntry => ({
    symbol: row.symbol,
    name: row.name,
    side,
    ltp,
    changePct: nn(row.changePct),
    score: score ?? 0,
    interpretation: score != null ? interpret(score) : "MODERATE",
    confidence,
    conflicting,
    trend: dominanceTrend(side === "BUYER" ? "buyer" : "seller", history),
    components: comps,
    depth: { bid: bidDepth, ask: askDepth, imb: depthImb != null ? Math.round(depthImb * 1000) / 10 : null },
    orders: { bid: bidOrders, ask: askOrders, imb: ordImb != null ? Math.round(ordImb * 1000) / 10 : null },
    totals: {
      buy: tbq,
      sell: tsq,
      imb: totalImb != null ? Math.round(totalImb * 1000) / 10 : null,
    },
    rvol,
    futLabel: row.futLabel,
    vwap,
    vwapSustain: sustain,
    vwapCrossings: vwap != null ? crossings : null,
    rsAccel: rsAcc,
    priceAccel: pAcc,
    ret5m,
    status: mkStatus(),
    completeness,
    reason: null,
    scannedAt: nowMs,
  });

  return {
    buyerScore,
    sellerScore,
    buyer: buyerScore != null ? mkEntry("BUYER", buyerScore, buyerComponents, buyerConfidence, buyerConflicting, vwapSustain) : null,
    seller: sellerScore != null ? mkEntry("SELLER", sellerScore, sellerComponents, sellerConfidence, sellerConflicting, vwapSustain != null ? 1 - vwapSustain : null) : null,
  };
}

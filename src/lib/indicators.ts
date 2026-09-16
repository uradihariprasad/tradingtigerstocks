import type { Candle } from "@/lib/upstox";

/** Simple moving average series (null until enough points). */
export function sma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average series, seeded with the first value. */
export function ema(values: number[], period: number): Array<number | null> {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: Array<number | null> = new Array(values.length).fill(null);
  let e = values[0];
  out[0] = e;
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    if (i >= period - 2) out[i] = e; // consider "warmed up" slightly early for intraday use
    else out[i] = e;
  }
  return out;
}

export function lastEma(values: number[], period: number): number | null {
  if (values.length < Math.min(3, period)) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Session VWAP from 1-minute candles (typical price × volume). */
export function vwapFromCandles(candles: Candle[]): number | null {
  let pv = 0;
  let vv = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vv += c.v;
  }
  return vv > 0 ? pv / vv : null;
}

/** Full VWAP series aligned to candles. */
export function vwapSeries(candles: Candle[]): Array<number | null> {
  let pv = 0;
  let vv = 0;
  return candles.map((c) => {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vv += c.v;
    return vv > 0 ? pv / vv : null;
  });
}

export interface BollingerPoint {
  mid: number;
  upper: number;
  lower: number;
}

export function bollinger(values: number[], period = 20, mult = 2): Array<BollingerPoint | null> {
  const out: Array<BollingerPoint | null> = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j];
      sq += values[j] * values[j];
    }
    const mid = sum / period;
    const variance = Math.max(0, sq / period - mid * mid);
    const sd = Math.sqrt(variance);
    out[i] = { mid, upper: mid + mult * sd, lower: mid - mult * sd };
  }
  return out;
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

export interface Swing {
  index: number;
  t: number;
  price: number;
}

/** Fractal swings on a candle series. */
export function swings(candles: Candle[], left = 2, right = 2): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isHigh = false;
      if (candles[j].l <= c.l) isLow = false;
    }
    if (isHigh) highs.push({ index: i, t: c.t, price: c.h });
    if (isLow) lows.push({ index: i, t: c.t, price: c.l });
  }
  return { highs, lows };
}

/** Aggregate 1-minute candles into 5-minute candles. */
export function resample(candles: Candle[], bucketMin: number): Candle[] {
  if (candles.length === 0) return [];
  const bucketMs = bucketMin * 60_000;
  const out: Candle[] = [];
  for (const c of candles) {
    const bucket = Math.floor(c.t / bucketMs) * bucketMs;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
      if (c.oi != null) last.oi = c.oi;
    } else {
      out.push({ t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, oi: c.oi });
    }
  }
  return out;
}

export interface ConsolidationZone {
  low: number;
  high: number;
  mid: number;
  timeCount: number; // bars spent inside
  volume: number; // volume traded inside
}

/**
 * Detect price areas where the stock repeatedly traded & transacted
 * (time-at-price and volume-at-price histograms from real candles).
 */
export function consolidationZones(candles: Candle[], binPct = 0.25): ConsolidationZone[] {
  if (candles.length < 10) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    min = Math.min(min, c.l);
    max = Math.max(max, c.h);
  }
  if (!(max > min)) return [];
  const binSize = Math.max((min * binPct) / 100, (max - min) / 40, 0.01);
  const nBins = Math.min(120, Math.ceil((max - min) / binSize) + 1);
  const time = new Array<number>(nBins).fill(0);
  const vol = new Array<number>(nBins).fill(0);
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    const b = Math.min(nBins - 1, Math.floor((tp - min) / binSize));
    time[b] += 1;
    vol[b] += c.v;
  }
  const totalV = vol.reduce((a, b) => a + b, 0);
  const avgT = time.reduce((a, b) => a + b, 0) / nBins;
  const zones: ConsolidationZone[] = [];
  let i = 0;
  while (i < nBins) {
    if (time[i] > avgT * 1.6 || (totalV > 0 && vol[i] / totalV > 0.06)) {
      let j = i;
      let t = 0;
      let v = 0;
      while (
        j < nBins &&
        (time[j] > avgT * 1.2 || (totalV > 0 && vol[j] / totalV > 0.04))
      ) {
        t += time[j];
        v += vol[j];
        j++;
      }
      const low = min + i * binSize;
      const high = min + (j - 1) * binSize + binSize;
      zones.push({ low, high, mid: (low + high) / 2, timeCount: t, volume: v });
      i = j;
    } else i++;
  }
  return zones;
}

/** Count touches (price coming within tolPct of level) over candles. */
export function countTouches(
  candles: Candle[],
  level: number,
  tolPct: number,
): { touches: number; lastTouchT: number | null } {
  const tol = (level * tolPct) / 100;
  let touches = 0;
  let lastTouchT: number | null = null;
  let inside = false;
  for (const c of candles) {
    const touched = c.l <= level + tol && c.h >= level - tol;
    if (touched && !inside) {
      touches++;
      lastTouchT = c.t;
    }
    inside = touched;
  }
  return { touches, lastTouchT };
}

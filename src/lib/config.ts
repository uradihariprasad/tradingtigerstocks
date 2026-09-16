/**
 * Scanner configuration — every weight / threshold is user-configurable
 * and persisted in the `settings` table under key "scanner_config".
 */

export interface Stage1Weights {
  rvol: number;
  relativeStrength: number;
  rsAcceleration: number;
  trend5m: number;
  vwap: number;
  futures: number;
  liquidity: number;
}

export interface Stage2Weights {
  priceStructure: number;
  rvol: number;
  relativeStrength: number;
  rsAcceleration: number;
  srQuality: number;
  optionConfluence: number;
  futures: number;
  trend5m: number;
  riskReward: number;
}

export interface ScannerConfig {
  // cadence
  scanIntervalSec: number;
  deepRefreshSec: number;
  maxRequestsPerSec: number;
  universeConcurrency: number;

  // universe / candidates
  candidateTopK: number; // stage-2 budget (combined long+short)
  topTrades: number; // final Top-N
  universeSize: number | null; // null = all F&O

  // hysteresis (signal stability)
  enterScore: number; // enter candidate list at score >=
  exitScore: number; // leave only below this
  minDwellScans: number; // minimum scans before removal

  // stage-1 thresholds
  rvolMin: number; // minimum RVOL to flag momentum
  rvolHigh: number; // RVOL that maps to score 100
  rsHigh: number; // RS (% pts) that maps to score 100
  minTurnoverCr: number; // liquidity threshold (₹ Cr traded today)
  rvolBaselineDays: number; // sessions used for time-of-day volume profile

  // levels / zones
  zoneTolerancePct: number; // merge tolerance for level confluence
  levelMinStrength: number; // min zone strength to act on (0-100)
  openingRangeMinutes: number;
  chainWindowPct: number; // option strikes within ±x% of spot

  // data integrity (FIX 1 / FIX 4)
  minCompletenessPct: number; // below this → INCOMPLETE DATA, score not tradable
  staleAfterSec: number; // quote age → RECENT boundary
  missingAfterSec: number; // quote age → STALE boundary

  // futures structure (FIX 3 / FIX 5 / FIX 9)
  futFlatPct: number; // |price change| below this = "approximately flat"
  futOiFlatPct: number; // |OI change| below this = no meaningful OI shift
  rolloverDaysBefore: number; // days to expiry that trigger rollover caution
  futMinTurnoverCr: number; // futures liquidity floor for S/R confidence

  // trade setups
  minRR: number; // minimum acceptable reward:risk
  breakoutBufferBps: number; // entry buffer above/below trigger (bps)
  slBufferBps: number; // stop buffer beyond invalidation (bps)
  breakoutProximityPct: number; // consider "at breakout level" within x%
  rrFullScore: number; // RR that maps to score 100

  stage1Weights: Stage1Weights;
  stage2Weights: Stage2Weights;
}

export const DEFAULT_CONFIG: ScannerConfig = {
  scanIntervalSec: 60,
  deepRefreshSec: 180,
  maxRequestsPerSec: 12,
  universeConcurrency: 8,

  candidateTopK: 25,
  topTrades: 10,
  universeSize: null,

  enterScore: 62,
  exitScore: 45,
  minDwellScans: 3,

  rvolMin: 1.5,
  rvolHigh: 4,
  rsHigh: 2,
  minTurnoverCr: 150,
  rvolBaselineDays: 10,

  zoneTolerancePct: 0.35,
  levelMinStrength: 35,
  openingRangeMinutes: 15,
  chainWindowPct: 10,

  minCompletenessPct: 80,
  staleAfterSec: 60,
  missingAfterSec: 300,

  futFlatPct: 0.15,
  futOiFlatPct: 0.25,
  rolloverDaysBefore: 3,
  futMinTurnoverCr: 5,

  minRR: 2,
  breakoutBufferBps: 6,
  slBufferBps: 5,
  breakoutProximityPct: 0.4,
  rrFullScore: 4,

  stage1Weights: {
    rvol: 20,
    relativeStrength: 10,
    rsAcceleration: 20,
    trend5m: 15,
    vwap: 10,
    futures: 10,
    liquidity: 15,
  },
  stage2Weights: {
    priceStructure: 20,
    rvol: 15,
    relativeStrength: 15,
    rsAcceleration: 10,
    srQuality: 15,
    optionConfluence: 10,
    futures: 5,
    trend5m: 5,
    riskReward: 5,
  },
};

/** Deep-merge user overrides over defaults, coercing numbers safely. */
export function mergeConfig(raw: unknown): ScannerConfig {
  const base: ScannerConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!raw || typeof raw !== "object") return base;
  const src = raw as Record<string, unknown>;
  const out = base as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    const cur = out[k];
    if (typeof v === "number" && Number.isFinite(v) && typeof cur === "number") {
      out[k] = v;
    } else if (typeof v === "boolean" && typeof cur === "boolean") {
      out[k] = v;
    } else if (typeof cur === "object" && cur && typeof v === "object") {
      const sub = v as Record<string, unknown>;
      const curSub = cur as Record<string, unknown>;
      for (const [sk, sv] of Object.entries(sub)) {
        if (typeof sv === "number" && Number.isFinite(sv) && typeof curSub[sk] === "number") {
          curSub[sk] = sv;
        }
      }
    } else if (k === "universeSize" && v === null) {
      out[k] = null;
    }
  }
  return base;
}

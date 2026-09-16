/**
 * NSE market calendar / clock utilities.
 * All wall-clock comparisons are done in Asia/Kolkata regardless of server TZ.
 */

export type MarketPhase = "PRE_OPEN" | "OPEN" | "CLOSED" | "WEEKEND";

export interface MarketStatus {
  phase: MarketPhase;
  isOpen: boolean;
  istNow: string; // formatted IST clock
  istDay: string; // YYYY-MM-DD (IST)
  minuteOfDay: number; // minutes since 00:00 IST
}

const IST = "Asia/Kolkata";

function istParts(now: Date) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const wd = parts.weekday; // Mon..Sun
  const hour = Number(parts.hour === "24" ? 0 : parts.hour);
  const minute = Number(parts.minute);
  return {
    wd,
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + minute,
    clock: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

export function getMarketStatus(now = new Date()): MarketStatus {
  const p = istParts(now);
  let phase: MarketPhase = "CLOSED";
  if (p.wd === "Sat" || p.wd === "Sun") {
    phase = "WEEKEND";
  } else if (p.minuteOfDay >= 9 * 60 && p.minuteOfDay < 9 * 60 + 15) {
    phase = "PRE_OPEN";
  } else if (p.minuteOfDay >= 9 * 60 + 15 && p.minuteOfDay <= 15 * 60 + 30) {
    phase = "OPEN";
  }
  return {
    phase,
    isOpen: phase === "OPEN",
    istNow: p.clock,
    istDay: p.day,
    minuteOfDay: p.minuteOfDay,
  };
}

export function todayIST(now = new Date()): string {
  return istParts(now).day;
}

export function minuteOfDayIST(tsMs: number): number {
  return istParts(new Date(tsMs)).minuteOfDay;
}

export function ymdIST(tsMs: number): string {
  return istParts(new Date(tsMs)).day;
}

export function subDaysIST(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() - n);
  return ymdIST(d.getTime());
}

export type DataStatus = "LIVE" | "RECENT" | "STALE" | "PARTIAL" | "UNAVAILABLE";

export function classifyStatus(
  tsMs: number | null,
  isOpen: boolean,
  hasCandles: boolean,
): DataStatus {
  if (tsMs == null) return "UNAVAILABLE";
  const age = Date.now() - tsMs;
  let s: DataStatus;
  if (!isOpen) s = age < 20 * 60 * 1000 ? "STALE" : "STALE";
  else if (age < 60_000) s = "LIVE";
  else if (age < 5 * 60_000) s = "RECENT";
  else s = "STALE";
  if (!hasCandles && s === "LIVE") return "PARTIAL";
  if (!hasCandles && (s === "RECENT" || s === "STALE")) return s;
  return s;
}

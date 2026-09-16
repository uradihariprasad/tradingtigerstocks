"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { StockDetail } from "@/lib/engine";
import type { TradeCard } from "@/lib/scanner";
import type { DataStatus } from "@/lib/market";
import { CandleChart } from "@/components/chart";
import { TradeCardView } from "@/components/tradecard";
import {
  DirectionBadge,
  Metric,
  MomentumBadge,
  SetupBadge,
  StatusBadge,
  TrendBadge,
  fmtCompact,
  fmtINR,
  fmtSigned,
  signColor,
} from "@/components/ui";
import { ArrowLeft, CandlestickChart, Layers3, ListOrdered, RefreshCw, Sigma } from "lucide-react";

async function safeParse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as T;
  }
  throw new Error(res.ok ? "unexpected non-JSON response" : `server error (HTTP ${res.status})`);
}

function useDetail(symbol: string) {
  const [data, setData] = useState<StockDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stock/${encodeURIComponent(symbol)}`, { cache: "no-store" });
      if (res.status === 404) {
        setErr("Symbol not part of the active F&O universe");
        setLoading(false);
        return;
      }
      const j = await safeParse<StockDetail>(res);
      setData(j);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [symbol]);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);
  return { data, err, loading, reload: load };
}

function OiSpark({ candles }: { candles: Array<{ t: number; oi: number | null; c: number }> | null }) {
  const pts = (candles ?? []).filter((c) => c.oi != null).map((c) => ({ t: c.t, oi: c.oi as number }));
  if (pts.length < 3) return <div className="mono text-[10px] text-[var(--faint)] py-4">OI series unavailable</div>;
  const w = 260;
  const h = 56;
  const los = Math.min(...pts.map((p) => p.oi));
  const his = Math.max(...pts.map((p) => p.oi));
  const span = Math.max(1, his - los);
  const d = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 6 - ((p.oi - los) / span) * (h - 12)).toFixed(1)}`)
    .join(" ");
  const trend = pts[pts.length - 1].oi - pts[0].oi;
  return (
    <div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <path d={d} fill="none" stroke={trend >= 0 ? "#a78bfa" : "#64748e"} strokeWidth={1.6} />
      </svg>
      <div className="flex justify-between mono text-[9px] text-[var(--faint)] -mt-1">
        <span>{fmtCompact(los)}</span>
        <span className={signColor(trend)}>{fmtSigned(trend / 1, 0)} contracts today</span>
        <span>{fmtCompact(his)}</span>
      </div>
    </div>
  );
}

/** Colour a dynamic level role using the existing palette. */
function roleTone(role: string): string {
  if (role.startsWith("STRONG_SUPPORT") || role === "SUPPORT_HOLDING" || role === "BROKEN_RESISTANCE_NOW_SUPPORT")
    return "var(--long)";
  if (role.startsWith("STRONG_RESISTANCE") || role === "RESISTANCE_CAPPING" || role === "BROKEN_SUPPORT_NOW_RESISTANCE")
    return "var(--short)";
  if (role.endsWith("WEAKENING")) return "var(--wait)";
  if (role === "RETESTING") return "var(--cyan)";
  if (role.endsWith("FORMING")) return "var(--violet)";
  return "var(--faint)";
}

function ZonesTable({ d }: { d: StockDetail }) {
  const zones = d.levels?.zones ?? [];
  return (
    <div className="panel p-2.5 sm:p-3 overflow-x-auto mobile-scroll">
      <div className="flex items-center gap-1.5 px-1 pb-2 text-[10px] tracking-[0.16em] font-bold text-[var(--violet)] flex-wrap">
        <Layers3 size={12} /> COMBINED DYNAMIC ZONES
        <span className="sm:ml-auto basis-full sm:basis-auto mono text-[var(--faint)] normal-case tracking-normal text-[9px] sm:text-[10px]">
          price structure × option OI × volume × VWAP
        </span>
      </div>
      <div className="sm:hidden px-1 pb-1 mono text-[8.5px] text-[var(--faint)]">SWIPE TABLE →</div>
      {zones.length === 0 ? (
        <div className="mono text-[11px] text-[var(--faint)] px-2 py-4">INSUFFICIENT DATA — no zones computed</div>
      ) : (
        <table className="w-full min-w-[720px] mono text-[11px]">
          <thead>
            <tr className="text-left text-[9px] tracking-[0.12em] text-[var(--faint)] border-b border-[var(--line-soft)]">
              {["SIDE", "ZONE", "STRENGTH", "SOURCES", "TOUCHES", "LAST TEST", "ROLE"].map((h) => (
                <th key={h} className="py-1.5 pr-4 font-semibold whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...zones].reverse().map((z) => (
              <tr key={z.id} className="border-b border-[var(--line-soft)]">
                <td className={`py-2 pr-4 font-bold ${z.side === "RESISTANCE" ? "text-[var(--short)]" : "text-[var(--long)]"}`}>
                  {z.side === "RESISTANCE" ? "▲ R" : "▼ S"}
                </td>
                <td className="pr-4 font-semibold">₹{fmtINR(z.low)} – ₹{fmtINR(z.high)}</td>
                <td className="pr-4">
                  <span className="mr-2">{z.strength}</span>
                  <span className="inline-block h-1 w-16 rounded-full bg-[#1a2436] overflow-hidden align-middle">
                    <span className="block h-full" style={{ width: `${z.strength}%`, background: z.strength >= 65 ? "var(--long)" : z.strength >= 40 ? "var(--wait)" : "var(--faint)" }} />
                  </span>
                </td>
                <td className="pr-4 text-[var(--muted)]">
                  <span style={{ color: z.origins.length > 1 ? "var(--cyan)" : undefined }}>
                    [{z.origins.join("+")}] conf {z.confluence}/100
                  </span>
                  {" · "}
                  {z.kinds.join(" + ")}
                  {z.optionLabel ? <span className="text-[var(--violet)]"> · {z.optionLabel}</span> : null}
                  {z.futuresLabel ? <span className="text-[var(--cyan)]"> · {z.futuresLabel}</span> : null}
                  <div className="text-[9px] text-[var(--faint)]">{z.confluenceReason}</div>
                </td>
                <td className="pr-4">{z.touches || "—"}</td>
                <td className="pr-4 text-[var(--muted)]">{z.lastTouchAgoMin != null ? `${z.lastTouchAgoMin}m ago` : "—"}</td>
                <td>
                  <span className="font-semibold" style={{ color: roleTone(z.role) }}>
                    {z.roleLabel}
                  </span>
                  {z.retested && !z.role.startsWith("BROKEN") && (
                    <span className="text-[var(--faint)]"> · retested</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OptionChain({ d }: { d: StockDetail }) {
  const chain = d.chain;
  const card = d.card;
  if (!chain) {
    return (
      <div className="panel p-3 mono text-[11px] text-[var(--faint)]">
        OPTION CHAIN — N/A (unavailable from Upstox for this underlying right now)
      </div>
    );
  }
  const maxCe = Math.max(...chain.strikes.map((s) => s.ceOi ?? 0), 1);
  const maxPe = Math.max(...chain.strikes.map((s) => s.peOi ?? 0), 1);
  const optS = card?.optionSupport?.strike ?? d.levels?.optionSupport?.strike ?? null;
  const optR = card?.optionResistance?.strike ?? d.levels?.optionResistance?.strike ?? null;
  const hasBaseline = chain.strikes.some((s) => s.ceOiChg != null || s.peOiChg != null);
  return (
    <div className="panel p-2.5 sm:p-3 overflow-x-auto mobile-scroll">
      <div className="flex items-center gap-1.5 px-1 pb-2 text-[10px] tracking-[0.16em] font-bold text-[var(--violet)]">
        <ListOrdered size={12} /> OPTION CHAIN
        <span className="mono text-[var(--faint)] normal-case tracking-normal text-[10px]">
          expiry {chain.expiry ?? "N/A"} · spot ₹{fmtINR(chain.spot)}
          {card?.optionBiasLabel ? ` · ${card.optionBiasLabel}` : ""}
        </span>
      </div>
      <table className="w-full mono text-[10.5px] min-w-[720px]">
        <thead>
          <tr className="text-[9px] tracking-[0.1em] text-[var(--faint)] border-b border-[var(--line-soft)]">
            <th className="py-1.5 text-right pr-3 font-semibold">CE OI</th>
            <th className="text-right pr-3 font-semibold">CE ΔOI</th>
            <th className="text-right pr-3 font-semibold">CE VOL</th>
            <th className="text-right pr-3 font-semibold">CE LTP</th>
            <th className="text-center px-3 font-semibold">STRIKE</th>
            <th className="text-left pl-3 font-semibold">PE LTP</th>
            <th className="text-left pl-3 font-semibold">PE VOL</th>
            <th className="text-left pl-3 font-semibold">PE ΔOI</th>
            <th className="text-left pl-3 font-semibold">PE OI</th>
          </tr>
        </thead>
        <tbody>
          {chain.strikes.map((s) => {
            const atm = s.isAtm === true;
            const isOptS = optS != null && s.strike === optS;
            const isOptR = optR != null && s.strike === optR;
            return (
              <tr
                key={s.strike}
                className="border-b border-[var(--line-soft)]"
                style={{
                  background: isOptS
                    ? "rgba(52,211,153,.07)"
                    : isOptR
                      ? "rgba(248,113,113,.07)"
                      : atm
                        ? "rgba(34,211,238,.05)"
                        : undefined,
                }}
              >
                <td className="py-1.5 text-right pr-3 relative">
                  <span className="absolute left-0 inset-y-1 rounded-r" style={{ width: `${((s.ceOi ?? 0) / maxCe) * 100}%`, background: "rgba(248,113,113,.08)" }} />
                  <span className="relative">{s.ceOi != null ? fmtCompact(s.ceOi) : "N/A"}</span>
                </td>
                <td className={`text-right pr-3 ${signColor(s.ceOiChg)}`}>
                  {s.ceOiChg == null ? "N/A" : `${s.ceOiChg > 0 ? "+" : "-"}${fmtCompact(Math.abs(s.ceOiChg))}`}
                </td>
                <td className="text-right pr-3 text-[var(--muted)]">{s.ceVol != null ? fmtCompact(s.ceVol) : "N/A"}</td>
                <td className="text-right pr-3 text-[var(--muted)]">{s.ceLtp != null ? fmtINR(s.ceLtp) : "N/A"}</td>
                <td className={`text-center px-3 font-bold ${atm ? "text-[var(--cyan)]" : ""}`}>
                  {fmtINR(s.strike, 0)}
                  {isOptS && <span className="text-[var(--long)] text-[9px]"> SUP</span>}
                  {isOptR && <span className="text-[var(--short)] text-[9px]"> RES</span>}
                </td>
                <td className="text-left pl-3 text-[var(--muted)]">{s.peLtp != null ? fmtINR(s.peLtp) : "N/A"}</td>
                <td className="text-left pl-3 text-[var(--muted)]">{s.peVol != null ? fmtCompact(s.peVol) : "N/A"}</td>
                <td className={`text-left pl-3 ${signColor(s.peOiChg)}`}>
                  {s.peOiChg == null ? "N/A" : `${s.peOiChg > 0 ? "+" : "-"}${fmtCompact(Math.abs(s.peOiChg))}`}
                </td>
                <td className="text-left pl-3 relative">
                  <span className="absolute right-0 inset-y-1 rounded-l" style={{ width: `${((s.peOi ?? 0) / maxPe) * 100}%`, background: "rgba(52,211,153,.08)" }} />
                  <span className="relative">{s.peOi != null ? fmtCompact(s.peOi) : "N/A"}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 mono text-[9.5px] text-[var(--faint)] px-1">
        {hasBaseline
          ? "ΔOI = current OI − previous OI, both reported by Upstox (market_data.prev_oi); N/A when the API omits prev_oi. ΔOI feeds strike scoring, option S/R selection and the confluence engine. Bars scaled to the heaviest strike in view."
          : "ΔOI = N/A — Upstox did not return prev_oi for these strikes and no session baseline exists yet. Values are never estimated."}
      </div>
    </div>
  );
}

// ΔOI display helper needs baseline data — rendered via zones/cards; shown as "—" when not in payload.

export function Desk({ symbol }: { symbol: string }) {
  const { data: d, err, loading, reload } = useDetail(symbol);
  const card: TradeCard | null = d?.card ?? null;

  return (
    <div className="max-w-[1720px] mx-auto px-2.5 sm:px-5 pb-12 sm:pb-16">
      <header className="sticky top-0 z-40 -mx-2.5 sm:-mx-5 px-2.5 sm:px-5 py-2 sm:py-2.5 border-b border-[var(--line)] backdrop-blur-md" style={{ background: "rgba(4,6,11,.82)" }}>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <Link href="/" className="chip !py-1.5 hover:text-[var(--cyan)] hover:border-[var(--cyan)]">
            <ArrowLeft size={12} /> SCANNER
          </Link>
          <div className="flex items-center gap-2">
            <CandlestickChart size={16} className="text-[var(--cyan)]" />
            <span className="text-[16px] font-bold tracking-tight">{symbol}</span>
            <span className="text-[11px] text-[var(--faint)] hidden sm:inline max-w-[220px] truncate">{d?.name ?? ""}</span>
          </div>
          {card && <DirectionBadge dir={card.direction} />}
          {card && <SetupBadge state={card.setupState} />}
          {card && <MomentumBadge m={card.momentum} />}
          <div className="ml-auto flex items-center gap-2">
            <StatusBadge status={(d?.row?.status ?? d?.meta.status) as DataStatus | undefined} pulse={d?.row?.status === "LIVE"} />
            <button onClick={() => void reload()} className="chip !py-1.5 hover:border-[var(--cyan)] hover:text-[var(--cyan)]">
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>
      </header>

      {err && <div className="mt-4 panel px-4 py-3 mono text-[12px] text-[var(--short)]">{err}</div>}
      {!d && !err && <div className="mt-4 panel h-96 skeleton" />}

      {d && (
        <div className="mt-3 sm:mt-4 grid grid-cols-12 gap-3 sm:gap-4">
          {/* price row */}
          <div className="col-span-12 panel px-3 sm:px-5 py-3 sm:py-4 flex items-end gap-3 sm:gap-6 flex-wrap">
            <div>
              <div className="label">LAST TRADED PRICE</div>
              <div className="flex items-baseline gap-3">
                <span className="mono text-[27px] sm:text-[34px] font-bold leading-none">₹{fmtINR(d.row?.ltp ?? d.card?.ltp ?? null)}</span>
                <span className={`mono text-[15px] font-semibold ${signColor(d.row?.changePct ?? d.card?.changePct)}`}>
                  {fmtSigned(d.row?.changePct ?? d.card?.changePct ?? null, 2, "%")}
                </span>
              </div>
            </div>
            <Metric label="RVOL" value={d.row?.rvol != null ? `${d.row.rvol.toFixed(2)}×` : "N/A"} tone={d.row?.rvol != null && d.row.rvol >= 1.5 ? "var(--cyan)" : undefined} />
            <Metric label="RS vs NIFTY" value={fmtSigned(d.row?.rs ?? null, 2, "%")} tone={d.row?.rs != null ? (d.row.rs > 0 ? "var(--long)" : "var(--short)") : undefined} />
            <Metric label="RS ACCEL" value={fmtSigned(d.row?.rsAccel ?? null, 2)} tone={d.row?.rsAccel != null ? (d.row.rsAccel > 0 ? "var(--long)" : "var(--short)") : undefined} />
            <Metric label="VWAP" value={d.row?.vwap != null ? `₹${fmtINR(d.row.vwap)}` : "N/A"} />
            <Metric label="5M TREND" value={<TrendBadge trend={d.row?.trend5m ?? null} />} />
            {!d.meta.marketOpen && (
              <span className="chip text-[var(--wait)] border-[rgba(251,191,36,.35)] ml-auto">MARKET CLOSED — analysis from last real session data</span>
            )}
          </div>

          {/* chart */}
          <div className="col-span-12 xl:col-span-8 panel p-1.5 sm:p-2 overflow-hidden">
            <div className="flex items-center gap-2 px-2 pt-1.5 pb-2 text-[10px] flex-wrap tracking-[0.16em] font-bold text-[var(--txt)]">
              <CandlestickChart size={12} className="text-[var(--cyan)]" /> SPOT · 5-MIN
              <span className="mono text-[9px] sm:text-[9.5px] text-[var(--faint)] font-normal normal-case tracking-normal basis-full sm:basis-auto">
                bands = combined dynamic zones · dashed = option-derived · lines = trade plan
              </span>
            </div>
            <CandleChart
              candles={d.candles5m}
              overlays={d.overlays}
              zones={d.levels?.zones ?? []}
              plan={
                card
                  ? {
                      entryLow: card.setup.entryLow,
                      entryHigh: card.setup.entryHigh,
                      stop: card.setup.stop,
                      t1: card.setup.t1,
                      t2: card.setup.t2,
                      t3: card.setup.t3,
                      ltp: d.row?.ltp ?? card.ltp,
                    }
                  : { entryLow: null, entryHigh: null, stop: null, t1: null, t2: null, t3: null, ltp: d.row?.ltp ?? null }
              }
              height={470}
            />
          </div>

          {/* futures */}
          <div className="col-span-12 xl:col-span-4 space-y-4">
            <div className="panel p-3.5">
              <div className="flex items-center gap-1.5 pb-2.5 text-[10px] tracking-[0.16em] font-bold text-[var(--cyan)]">
                <Sigma size={12} /> FUTURES CONFIRMATION
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Metric label="FUT LTP" value={d.futures.ltp != null ? `₹${fmtINR(d.futures.ltp)}` : "N/A"} small />
                <Metric label="CHANGE" value={fmtSigned(d.futures.changePct ?? null, 2, "%")} tone={signColor(d.futures.changePct)} small />
                <Metric label="BASIS" value={d.futures.basis != null ? fmtSigned(d.futures.basis, 2) : "N/A"} small />
                <Metric label="OPEN INTEREST" value={d.futures.oi != null ? fmtCompact(d.futures.oi) : "N/A"} small />
                <Metric label="OI CHANGE" value={d.futures.oiChangePct != null ? fmtSigned(d.futures.oiChangePct, 1, "%") : "N/A"} tone={signColor(d.futures.oiChangePct)} small />
                <Metric label="EXPIRY" value={d.futures.expiry ?? "N/A"} small />
              </div>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="label">POSITIONING</span>
                <span
                  className="chip"
                  style={{
                    color:
                      d.row?.futConfirmation === "BULLISH"
                        ? "var(--long)"
                        : d.row?.futConfirmation === "BEARISH"
                          ? "var(--short)"
                          : d.row?.futConfirmation === "AMBIGUOUS" || d.row?.futConfirmation === "PARTIAL"
                            ? "var(--wait)"
                            : "var(--muted)",
                  }}
                >
                  {d.row?.futLabel ?? d.futures.buildup ?? "N/A"}
                </span>
                {d.row?.futRollover && <span className="chip text-[var(--wait)]">ROLLOVER PERIOD</span>}
              </div>
              {d.card?.futuresLevels?.available && (
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <Metric
                    label="FUT SUPPORT"
                    value={d.card.futuresLevels.support ? `₹${fmtINR(d.card.futuresLevels.support.low)}–${fmtINR(d.card.futuresLevels.support.high)}` : "N/A"}
                    small
                  />
                  <Metric
                    label="FUT RESIST"
                    value={d.card.futuresLevels.resistance ? `₹${fmtINR(d.card.futuresLevels.resistance.low)}–${fmtINR(d.card.futuresLevels.resistance.high)}` : "N/A"}
                    small
                  />
                  <Metric
                    label="FUT STRENGTH"
                    value={`S ${d.card.futuresLevels.supportStrength ?? "N/A"} / R ${d.card.futuresLevels.resistanceStrength ?? "N/A"}`}
                    small
                  />
                  <div className="col-span-2 sm:col-span-3 mono text-[9px] text-[var(--faint)]">
                    levels normalized to spot via basis {d.card.futuresLevels.basis != null ? fmtSigned(d.card.futuresLevels.basis, 2) : "N/A"}
                    {d.card.futuresLevels.reason ? ` · ${d.card.futuresLevels.reason}` : ""}
                  </div>
                </div>
              )}
              <div className="mt-3">
                <div className="label mb-1">SESSION OI PATH</div>
                <OiSpark candles={d.futures.candles5m} />
              </div>
              <div className="mt-2 mono text-[9.5px] text-[var(--faint)]">{d.futures.symbol ?? ""}</div>
            </div>

            {/* momentum */}
            <div className="panel p-3.5">
              <div className="flex items-center gap-1.5 pb-2.5 text-[10px] tracking-[0.16em] font-bold text-[var(--wait)]">
                MOMENTUM MATRIX
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Metric label="5-MIN RET" value={fmtSigned(d.row?.ret5m ?? null, 2, "%")} tone={signColor(d.row?.ret5m)} small />
                <Metric label="15-MIN RET" value={fmtSigned(d.row?.ret15m ?? null, 2, "%")} tone={signColor(d.row?.ret15m)} small />
                <Metric label="PRICE ACCEL" value={fmtSigned(d.row?.accel ?? null, 2)} tone={signColor(d.row?.accel)} small />
                <Metric label="TURNOVER" value={d.row?.turnoverCr != null ? `₹${fmtCompact(d.row.turnoverCr)}Cr` : "N/A"} small />
                <Metric label="EMA 9/20" value={d.row?.ema9 != null && d.row?.ema20 != null ? `${fmtINR(d.row.ema9, 1)} / ${fmtINR(d.row.ema20, 1)}` : "N/A"} small />
                <Metric label="STRUCTURE" value={d.row?.structure?.replace(/_/g, "/") ?? "N/A"} small />
              </div>
              <div className="mt-2.5 flex gap-1.5 flex-wrap">
                {(d.row?.flags ?? []).map((f, i) => (
                  <span key={i} className="chip">{f}</span>
                ))}
                {(d.row?.flags ?? []).length === 0 && <span className="mono text-[10px] text-[var(--faint)]">no flags — data pending</span>}
              </div>
            </div>
          </div>

          {/* trade card */}
          {card && (
            <div className="col-span-12">
              <div className="flex items-center gap-2 mb-2 text-[10px] tracking-[0.16em] font-bold text-[var(--long)]">
                TRADE PLAN · STAGE 2 OUTPUT
              </div>
              <TradeCardView card={card} />
            </div>
          )}
          {!card && (
            <div className="col-span-12 panel px-3 sm:px-5 py-3 sm:py-4 mono text-[11.5px] text-[var(--faint)]">
              This symbol is not currently in the Stage-2 candidate pool — no trade plan generated.
              Trade plans are produced only for candidates that pass Stage-1 momentum & trend filters.
            </div>
          )}

          {/* zones */}
          <div className="col-span-12">
            <ZonesTable d={d} />
          </div>

          {/* option chain */}
          <div className="col-span-12">
            <OptionChain d={d} />
          </div>
        </div>
      )}
    </div>
  );
}

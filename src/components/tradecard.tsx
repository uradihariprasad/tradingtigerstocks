"use client";

import Link from "next/link";
import type { TradeCard as Card } from "@/lib/scanner";
import {
  DirectionBadge,
  MomentumBadge,
  ScoreRing,
  SetupBadge,
  StatusBadge,
  TrendBadge,
  fmtINR,
  fmtCompact,
  fmtSigned,
  signColor,
} from "@/components/ui";
import { ArrowDownRight, ArrowUpRight, Crosshair, PauseCircle } from "lucide-react";

// ---------------------------------------------------------------- structure ladder

function Ladder({ card }: { card: Card }) {
  const s = card.setup;
  const pts: number[] = [];
  const add = (v: number | null | undefined) => {
    if (v != null && Number.isFinite(v)) pts.push(v);
  };
  add(card.support?.low);
  add(card.resistance?.high);
  add(card.ltp);
  add(s.entryLow);
  add(s.entryHigh);
  add(s.stop);
  add(s.t1);
  add(s.t2);
  add(s.t3);
  if (pts.length < 2 || card.ltp == null) return null;
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  const pad = (hi - lo) * 0.08 || lo * 0.002;
  lo -= pad;
  hi += pad;
  const pos = (v: number) => `${Math.max(2, Math.min(98, ((v - lo) / (hi - lo)) * 100))}%`;

  const mark = (v: number | null, color: string, label: string, top: boolean) =>
    v == null ? null : (
      <div key={label + v} className="absolute" style={{ left: pos(v), top: 0, bottom: 0 }}>
        <div className="absolute inset-y-0 w-px" style={{ background: color, opacity: 0.85 }} />
        <div
          className={`absolute mono text-[8.5px] tracking-wider px-1 rounded-[3px] whitespace-nowrap ${top ? "-top-3.5" : "-bottom-3.5"}`}
          style={{ color, background: "rgba(4,7,12,.9)", transform: "translateX(-50%)" }}
        >
          {label}
        </div>
      </div>
    );

  return (
    <div className="relative mx-1 mt-6 mb-5 h-[3px] rounded bg-[#1a2436] hidden sm:block">
      {card.support && (
        <div
          className="absolute inset-y-[-3px] rounded"
          style={{
            left: pos(card.support.low),
            width: `calc(${pos(card.support.high)} - ${pos(card.support.low)})`,
            background: "rgba(52,211,153,.22)",
            boxShadow: "0 0 12px rgba(52,211,153,.15)",
          }}
        />
      )}
      {card.resistance && (
        <div
          className="absolute inset-y-[-3px] rounded"
          style={{
            left: pos(card.resistance.low),
            width: `calc(${pos(card.resistance.high)} - ${pos(card.resistance.low)})`,
            background: "rgba(248,113,113,.22)",
            boxShadow: "0 0 12px rgba(248,113,113,.15)",
          }}
        />
      )}
      {mark(card.ltp, "#e2e8f0", "LTP", true)}
      {mark(s.entryHigh ?? s.entryLow, "#22d3ee", "ENTRY", false)}
      {mark(s.stop, "#f87171", "SL", false)}
      {mark(s.t1, "#34d399", "T1", true)}
      {mark(s.t2, "#34d399", "T2", true)}
    {mark(s.t3, "#34d399", "T3", true)}
    </div>
  );
}

// ---------------------------------------------------------------- plan row

function PlanCell({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="panel-inset px-2 sm:px-2.5 py-1.5 min-w-0" title={typeof v === "string" ? v : undefined}>
      <div className="label !text-[9px]">{k}</div>
      <div className="mono text-[12px] font-semibold truncate" style={{ color: tone ?? "var(--txt)" }}>
        {v}
      </div>
    </div>
  );
}

function StrengthBar({ v, color }: { v: number; color: string }) {
  return (
    <span className="inline-block align-middle ml-2 h-1 w-14 rounded-full bg-[#1a2436] overflow-hidden">
      <span className="block h-full rounded-full" style={{ width: `${v}%`, background: color }} />
    </span>
  );
}

// ---------------------------------------------------------------- card

export function TradeCardView({ card, rank }: { card: Card; rank?: number }) {
  const s = card.setup;
  const long = card.direction === "LONG";
  const spine = long ? "var(--long)" : card.direction === "SHORT" ? "var(--short)" : "var(--wait)";
  const entryText =
    s.entryLow != null && s.entryHigh != null
      ? Math.abs(s.entryHigh - s.entryLow) < 0.005
        ? `₹${fmtINR(s.entryHigh)}`
        : `₹${fmtINR(s.entryLow)} – ₹${fmtINR(s.entryHigh)}`
      : "N/A";

  return (
    <div className="panel relative overflow-hidden fade-up">
      <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: spine, opacity: 0.9 }} />
      <div className="p-3 pl-4 sm:p-4 sm:pl-5">
        {/* header */}
        <div className="flex items-start gap-2 sm:gap-3 flex-wrap sm:flex-nowrap">
          {rank != null && (
            <div className="mono text-[20px] sm:text-[26px] font-light text-[var(--faint)] leading-none mt-0.5">
              {String(rank).padStart(2, "0")}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/stock/${encodeURIComponent(card.symbol)}`}
                className="text-[16px] sm:text-[17px] font-bold tracking-tight hover:text-[var(--cyan)] transition-colors"
              >
                {card.symbol}
              </Link>
              <DirectionBadge dir={card.direction} />
              <MomentumBadge m={card.momentum} />
              {card.paused && (
                <span className="chip text-[var(--wait)] border-[rgba(251,191,36,.35)]">
                  <PauseCircle size={11} /> PAUSED
                </span>
              )}
              <span
                className="chip"
                title={card.missingMetrics.length ? `missing: ${card.missingMetrics.join(", ")}` : "all required metrics live"}
                style={{
                  color: card.incomplete ? "var(--short)" : "var(--muted)",
                  borderColor: card.incomplete ? "rgba(248,113,113,.4)" : undefined,
                }}
              >
                {card.incomplete ? "INCOMPLETE DATA" : "DATA"} {card.completeness}%
              </span>
              {card.futRollover && (
                <span className="chip text-[var(--wait)] border-[rgba(251,191,36,.35)]">ROLLOVER</span>
              )}
            </div>
            <div className="text-[11px] text-[var(--faint)] mt-0.5 truncate">{card.name ?? ""}</div>
          </div>
          <div className="basis-full sm:basis-auto pl-7 sm:pl-0 flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-2 sm:gap-1.5">
            <SetupBadge state={card.setupState} />
            <ScoreRing score={card.incomplete ? null : card.finalScore} size={48} />
            {card.incomplete && (
              <span className="mono text-[8.5px] text-[var(--short)]">SCORE INCOMPLETE</span>
            )}
          </div>
        </div>

        {/* live strip */}
        <div className="mt-3 flex items-end gap-2 sm:gap-4 flex-wrap">
          <div>
            <div className="label">LTP</div>
            <div className="flex items-center gap-1.5">
              <span className="mono text-[19px] sm:text-[22px] font-bold leading-none">₹{fmtINR(card.ltp)}</span>
              <span className={`mono text-[12px] font-semibold flex items-center ${signColor(card.changePct)}`}>
                {card.changePct != null &&
                  (card.changePct > 0 ? <ArrowUpRight size={13} /> : card.changePct < 0 ? <ArrowDownRight size={13} /> : null)}
                {fmtSigned(card.changePct, 2, "%")}
              </span>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <StatusBadge status={card.status} pulse={card.status === "LIVE"} />
            <TrendBadge trend={card.trend5m} />
          </div>
        </div>

        {/* momentum chips */}
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5">
          <PlanCell k="RVOL" v={card.rvol != null ? `${card.rvol.toFixed(2)}×` : "N/A"} tone={card.rvol != null && card.rvol >= 1.5 ? "var(--cyan)" : undefined} />
          <PlanCell k="RS vs NIFTY" v={fmtSigned(card.rs, 2, "%")} tone={card.rs != null ? (card.rs > 0 ? "var(--long)" : "var(--short)") : undefined} />
          <PlanCell k="RS ACCEL" v={fmtSigned(card.rsAccel, 2)} tone={card.rsAccel != null ? (card.rsAccel > 0 ? "var(--long)" : "var(--short)") : undefined} />
          <PlanCell k="VWAP" v={card.vwap != null ? `₹${fmtINR(card.vwap)}` : "N/A"} />
          <PlanCell k="TURNOVER" v={card.turnoverCr != null ? `₹${fmtCompact(card.turnoverCr)}Cr` : "N/A"} />
          <PlanCell
            k="FUTURES"
            v={card.futuresLabel ?? "N/A"}
            tone={
              card.futConfirmation === "BULLISH"
                ? "var(--long)"
                : card.futConfirmation === "BEARISH"
                  ? "var(--short)"
                  : card.futConfirmation === "AMBIGUOUS" || card.futConfirmation === "PARTIAL"
                    ? "var(--wait)"
                    : undefined
            }
          />
        </div>

        {/* structure ladder */}
        <Ladder card={card} />

        {/* levels + plan */}
        <div className="grid lg:grid-cols-2 gap-3 mt-2 sm:mt-3">
          <div className="space-y-2">
            <div className="label flex items-center gap-1.5"><Crosshair size={11} /> DYNAMIC LEVELS</div>
            <div className="panel-inset p-2 sm:p-2.5 space-y-2 mono text-[10.5px] sm:text-[11.5px]">
              <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-2">
                <span className="text-[var(--long)]">SUPPORT</span>
                <span className="text-left sm:text-right">
                  {card.support ? (
                    <>
                      ₹{fmtINR(card.support.low)} – ₹{fmtINR(card.support.high)}
                      <span className="text-[var(--faint)]"> · {card.support.strength}/100</span>
                      <StrengthBar v={card.support.strength} color="var(--long)" />
                      <div className="text-[9.5px] text-[var(--faint)]">
                        {card.support.origins.join("+")} · confluence {card.support.confluence}/100
                      </div>
                      <div className="text-[9.5px] font-semibold text-[var(--long)]">{card.support.roleLabel}</div>
                    </>
                  ) : (
                    <span className="text-[var(--faint)]">N/A</span>
                  )}
                </span>
              </div>
              <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-2">
                <span className="text-[var(--short)]">RESISTANCE</span>
                <span className="text-left sm:text-right">
                  {card.resistance ? (
                    <>
                      ₹{fmtINR(card.resistance.low)} – ₹{fmtINR(card.resistance.high)}
                      <span className="text-[var(--faint)]"> · {card.resistance.strength}/100</span>
                      <StrengthBar v={card.resistance.strength} color="var(--short)" />
                      <div className="text-[9.5px] text-[var(--faint)]">
                        {card.resistance.origins.join("+")} · confluence {card.resistance.confluence}/100
                      </div>
                      <div className="text-[9.5px] font-semibold text-[var(--short)]">{card.resistance.roleLabel}</div>
                    </>
                  ) : (
                    <span className="text-[var(--faint)]">N/A</span>
                  )}
                </span>
              </div>
              <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-2 border-t border-[var(--line-soft)] pt-1.5">
                <span className="text-[var(--violet)]">OPT SUPPORT</span>
                <span>
                  {card.optionSupport ? (
                    <>
                      {fmtINR(card.optionSupport.strike, 0)}
                      <span className="text-[var(--faint)]">
                        {" "}· OI {fmtCompact(card.optionSupport.oi)} · ΔOI{" "}
                        {card.optionSupport.oiChg == null ? "N/A" : `${card.optionSupport.oiChg > 0 ? "+" : ""}${fmtCompact(card.optionSupport.oiChg)}`}
                        {" "}· VOL {fmtCompact(card.optionSupport.vol)}
                      </span>
                    </>
                  ) : (
                    <span className="text-[var(--faint)]">N/A</span>
                  )}
                </span>
              </div>
              <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-2">
                <span className="text-[var(--violet)]">OPT RESISTANCE</span>
                <span>
                  {card.optionResistance ? (
                    <>
                      {fmtINR(card.optionResistance.strike, 0)}
                      <span className="text-[var(--faint)]">
                        {" "}· OI {fmtCompact(card.optionResistance.oi)} · ΔOI{" "}
                        {card.optionResistance.oiChg == null ? "N/A" : `${card.optionResistance.oiChg > 0 ? "+" : ""}${fmtCompact(card.optionResistance.oiChg)}`}
                        {" "}· VOL {fmtCompact(card.optionResistance.vol)}
                      </span>
                    </>
                  ) : (
                    <span className="text-[var(--faint)]">N/A</span>
                  )}
                </span>
              </div>
              {card.futuresLevels && card.futuresLevels.available && (
                <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-2 border-t border-[var(--line-soft)] pt-1.5">
                  <span className="text-[var(--cyan)]">FUT S/R STRENGTH</span>
                  <span className="text-left sm:text-right">
                    S {card.futuresLevels.supportStrength ?? "N/A"} / R {card.futuresLevels.resistanceStrength ?? "N/A"}
                    <span className="text-[var(--faint)]"> · conf {card.futuresLevels.confidence}%</span>
                  </span>
                </div>
              )}
              <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-2 border-t border-[var(--line-soft)] pt-1.5 text-[var(--muted)]">
                <span>FUT OI / BASIS</span>
                <span>
                  {card.fut.oi != null ? fmtCompact(card.fut.oi) : "N/A"}
                  {card.fut.oiChangePct != null && (
                    <span className={signColor(card.fut.oiChangePct)}> ({fmtSigned(card.fut.oiChangePct, 1, "%")})</span>
                  )}
                  {" · "}
                  {card.fut.basis != null ? fmtSigned(card.fut.basis, 2) : "N/A"}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="label">TRADE PLAN</div>
            <div className="panel-inset p-2 sm:p-2.5 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              <PlanCell k="ENTRY" v={entryText} tone="var(--cyan)" />
              <PlanCell k="STOP" v={s.stop != null ? `₹${fmtINR(s.stop)}` : "N/A"} tone="var(--short)" />
              <PlanCell k="RISK" v={s.risk != null ? `₹${fmtINR(s.risk)}` : "N/A"} />
              <PlanCell k="TARGET 1" v={s.t1 != null ? `₹${fmtINR(s.t1)}` : "N/A"} tone="var(--long)" />
              <PlanCell k="TARGET 2" v={s.t2 != null ? `₹${fmtINR(s.t2)}` : "N/A"} tone="var(--long)" />
              <PlanCell
                k="R : R"
                v={s.rr1 != null ? `1 : ${s.rr1.toFixed(1)}${s.rr2 != null ? ` / ${s.rr2.toFixed(1)}` : ""}` : "N/A"}
                tone={s.rrOk ? "var(--long)" : s.rr1 != null ? "var(--wait)" : undefined}
              />
            </div>
            {s.stopBasis && (
              <div className="text-[10.5px] text-[var(--faint)] mono leading-snug">
                invalidation: {s.stopBasis}
              </div>
            )}
          </div>
        </div>

        {/* explanation */}
        <div className="mt-3 border-t border-[var(--line-soft)] pt-3 space-y-2">
          <p className="text-[12px] leading-relaxed text-[var(--txt)]">{card.explanation.headline}</p>
          {card.setupState !== "NO_TRADE" && (
            <div className="grid sm:grid-cols-3 gap-2 text-[11px] leading-relaxed">
              <div className="panel-inset p-2">
                <div className="label !text-[9px] text-[var(--cyan)]">WHY NOW</div>
                <p className="mt-1 text-[var(--muted)]">{card.explanation.whyNow}</p>
              </div>
              <div className="panel-inset p-2">
                <div className="label !text-[9px] text-[var(--long)]">WHAT CONFIRMS IT</div>
                <ul className="mt-1 space-y-0.5 text-[var(--muted)]">
                  {card.explanation.confirms.length ? (
                    card.explanation.confirms.map((c, i) => <li key={i}>· {c}</li>)
                  ) : (
                    <li className="text-[var(--faint)]">INSUFFICIENT DATA</li>
                  )}
                </ul>
              </div>
              <div className="panel-inset p-2">
                <div className="label !text-[9px] text-[var(--short)]">WHAT INVALIDATES IT</div>
                <ul className="mt-1 space-y-0.5 text-[var(--muted)]">
                  {card.explanation.invalidates.length ? (
                    card.explanation.invalidates.map((c, i) => <li key={i}>· {c}</li>)
                  ) : (
                    <li className="text-[var(--faint)]">—</li>
                  )}
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-2 flex-wrap">
          <Link
            href={`/stock/${encodeURIComponent(card.symbol)}`}
            className="chip hover:border-[var(--cyan)] hover:text-[var(--cyan)] transition-colors"
          >
            OPEN DESK →{" "}
          </Link>
          <span className="mono text-[9px] sm:text-[9.5px] text-[var(--faint)]">scanned {new Date(card.scannedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })} IST</span>
        </div>
      </div>
    </div>
  );
}

"use client";

import React from "react";
import type { DataStatus } from "@/lib/market";
import type { Direction, SetupState, Trend } from "@/lib/scanner";

// ---------------------------------------------------------------- formatting

export function fmtINR(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  return n.toFixed(digits);
}

export function fmtSigned(n: number | null | undefined, digits = 2, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  const s = n > 0 ? "+" : "";
  return `${s}${n.toFixed(digits)}${suffix}`;
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export function signColor(n: number | null | undefined): string {
  if (n == null) return "text-[var(--faint)]";
  if (n > 0.0001) return "text-[var(--long)]";
  if (n < -0.0001) return "text-[var(--short)]";
  return "text-[var(--muted)]";
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------------------------------------------------------- badges

export function StatusBadge({ status, pulse }: { status: DataStatus | "INSUFFICIENT DATA" | null | undefined; pulse?: boolean }) {
  const s = status ?? "UNAVAILABLE";
  const cls: Record<DataStatus | "INSUFFICIENT DATA", string> = {
    LIVE: "text-[var(--long)] border-[rgba(52,211,153,.35)]",
    RECENT: "text-[var(--cyan)] border-[rgba(34,211,238,.3)]",
    STALE: "text-[var(--wait)] border-[rgba(251,191,36,.3)]",
    PARTIAL: "text-[var(--violet)] border-[rgba(167,139,250,.3)]",
    UNAVAILABLE: "text-[var(--faint)] border-[var(--line)]",
    "INSUFFICIENT DATA": "text-[var(--short)] border-[rgba(248,113,113,.35)]",
  };
  return (
    <span className={`chip ${cls[s]}`}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${pulse ? "pulse-dot" : ""}`}
        style={{
          background:
            s === "LIVE" ? "var(--long)" : s === "RECENT" ? "var(--cyan)" : s === "STALE" ? "var(--wait)" : s === "PARTIAL" ? "var(--violet)" : s === "INSUFFICIENT DATA" ? "var(--short)" : "var(--faint)",
        }}
      />
      {s}
    </span>
  );
}

export function DirectionBadge({ dir }: { dir: Direction | null | undefined }) {
  if (!dir) return <span className="chip">—</span>;
  return (
    <span
      className={`chip font-bold ${dir === "LONG" ? "text-[var(--long)] border-[rgba(52,211,153,.4)]" : "text-[var(--short)] border-[rgba(248,113,113,.4)]"}`}
      style={{ background: dir === "LONG" ? "rgba(52,211,153,.08)" : "rgba(248,113,113,.08)" }}
    >
      {dir}
    </span>
  );
}

export function TrendBadge({ trend }: { trend: Trend | null | undefined }) {
  if (!trend) return <span className="text-[var(--faint)] mono text-[11px]">N/A</span>;
  const color = trend === "BULLISH" ? "var(--long)" : trend === "BEARISH" ? "var(--short)" : "var(--muted)";
  return (
    <span className="mono text-[11px] font-semibold" style={{ color }}>
      {trend === "BULLISH" ? "▲ BULL" : trend === "BEARISH" ? "▼ BEAR" : "◆ NEUT"}
    </span>
  );
}

export function SetupBadge({ state }: { state: SetupState }) {
  const map: Record<SetupState, { label: string; color: string; bg: string }> = {
    LONG: { label: "TRADE SETUP · LONG", color: "var(--long)", bg: "rgba(52,211,153,.1)" },
    SHORT: { label: "TRADE SETUP · SHORT", color: "var(--short)", bg: "rgba(248,113,113,.1)" },
    WAIT_FOR_BREAKOUT: { label: "WAIT · BREAKOUT", color: "var(--wait)", bg: "rgba(251,191,36,.1)" },
    WAIT_FOR_BREAKDOWN: { label: "WAIT · BREAKDOWN", color: "var(--wait)", bg: "rgba(251,191,36,.1)" },
    WAIT_FOR_RETEST: { label: "WAIT · RETEST", color: "var(--cyan)", bg: "rgba(34,211,238,.1)" },
    NO_TRADE: { label: "NO TRADE", color: "var(--muted)", bg: "rgba(100,116,142,.1)" },
  };
  const m = map[state];
  return (
    <span
      className="chip font-bold tracking-wider"
      style={{ color: m.color, background: m.bg, borderColor: m.color + "55" }}
    >
      {m.label}
    </span>
  );
}

export function MomentumBadge({ m }: { m: "EARLY" | "CONFIRMED" | "NONE" }) {
  if (m === "NONE") return null;
  return (
    <span
      className="chip"
      style={
        m === "CONFIRMED"
          ? { color: "var(--long)", background: "rgba(52,211,153,.09)", borderColor: "rgba(52,211,153,.35)" }
          : { color: "var(--wait)", background: "rgba(251,191,36,.09)", borderColor: "rgba(251,191,36,.35)" }
      }
    >
      {m === "CONFIRMED" ? "● CONFIRMED MOMENTUM" : "◐ EARLY MOMENTUM"}
    </span>
  );
}

// ---------------------------------------------------------------- score

export function ScoreRing({ score, size = 54, tone }: { score: number | null; size?: number; tone?: string }) {
  const s = score == null ? 0 : Math.max(0, Math.min(100, score));
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const color =
    tone ??
    (score == null ? "var(--faint)" : s >= 75 ? "var(--long)" : s >= 55 ? "var(--cyan)" : s >= 40 ? "var(--wait)" : "var(--faint)");
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#141d2c" strokeWidth={5} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={`${(s / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray .6s cubic-bezier(.22,.8,.32,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="mono font-bold leading-none" style={{ fontSize: size * 0.3, color: score == null ? "var(--faint)" : "var(--txt)" }}>
          {score == null ? "–" : s}
        </span>
        <span className="text-[8px] tracking-[0.14em] text-[var(--faint)]">/100</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- misc

export function Metric({ label, value, tone, small }: { label: string; value: React.ReactNode; tone?: string; small?: boolean }) {
  return (
    <div className="min-w-[92px] flex-[1_1_92px] sm:min-w-0 sm:flex-none">
      <div className="label">{label}</div>
      <div className={`mono font-semibold truncate ${small ? "text-[11px]" : "text-[13px]"} mt-0.5`} style={{ color: tone ?? "var(--txt)" }}>
        {value}
      </div>
    </div>
  );
}

export function EmptyState({ title, sub, icon }: { title: string; sub?: string; icon?: React.ReactNode }) {
  return (
    <div className="panel p-6 sm:p-10 flex flex-col items-center justify-center text-center gap-2">
      {icon}
      <div className="text-sm font-semibold text-[var(--muted)] tracking-wide">{title}</div>
      {sub && <div className="text-xs text-[var(--faint)] mono max-w-md">{sub}</div>}
    </div>
  );
}

export function ZoneText({ low, high }: { low: number | null | undefined; high: number | null | undefined }) {
  if (low == null && high == null) return <span className="text-[var(--faint)]">N/A</span>;
  if (low != null && high != null && Math.abs(low - high) < 0.005) return <span>₹{fmtINR(low)}</span>;
  return (
    <span>
      ₹{fmtINR(low)} – ₹{fmtINR(high)}
    </span>
  );
}

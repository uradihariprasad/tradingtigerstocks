"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ScanPayload } from "@/lib/engine";
import type { ScannerConfig } from "@/lib/config";
import type { Stage1Row } from "@/lib/scanner";
import { TradeCardView } from "@/components/tradecard";
import {
  EmptyState,
  MomentumBadge,
  StatusBadge,
  TrendBadge,
  fmtCompact,
  fmtINR,
  fmtSigned,
  signColor,
  timeAgo,
} from "@/components/ui";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Minus,
  Repeat,
  Waves,
  Database,
  Flame,
  Gauge,
  KeyRound,
  Layers3,
  ListFilter,
  Moon,
  Radar,
  RefreshCw,
  Settings2,
  ShieldAlert,
  SignalHigh,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";

// ---------------------------------------------------------------- hooks

/** Parse a fetch response safely — edge/proxy HTML error pages become a clean message. */
async function safeJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      /* fall through */
    }
  }
  throw new Error(
    res.ok
      ? `unexpected non-JSON response from server`
      : `server error (HTTP ${res.status}) — retrying shortly`,
  );
}

function useScan() {
  const [payload, setPayload] = useState<ScanPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastFetch = useRef(0);
  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const res = await fetch("/api/scan", {
        method: force ? "POST" : "GET",
        cache: "no-store",
      });
      const j = await safeJson<{ ok?: boolean; payload?: ScanPayload } & ScanPayload>(res);
      const p = (j.payload ?? j) as ScanPayload;
      if (p && (p.meta || p.rows)) setPayload(p);
      setErr(null);
      lastFetch.current = Date.now();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);
  return { payload, err, loading, reload: load };
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const istClock = () =>
  new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

// ---------------------------------------------------------------- top bar

function MarketPill({ payload }: { payload: ScanPayload | null }) {
  const phase = payload?.meta?.market?.phase ?? null;
  if (!phase) return <span className="chip">…</span>;
  if (phase === "OPEN")
    return (
      <span className="chip text-[var(--long)] border-[rgba(52,211,153,.4)]" style={{ background: "rgba(52,211,153,.08)" }}>
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--long)] pulse-dot" /> MARKET OPEN
      </span>
    );
  if (phase === "PRE_OPEN")
    return <span className="chip text-[var(--wait)] border-[rgba(251,191,36,.4)]">PRE-OPEN</span>;
  return (
    <span className="chip text-[var(--wait)] border-[rgba(251,191,36,.35)]">
      <Moon size={11} /> MARKET CLOSED
    </span>
  );
}

function BreadthBar({ b }: { b: ScanPayload["breadth"] }) {
  if (!b) return <span className="chip">BREADTH N/A</span>;
  const t = Math.max(1, b.total);
  return (
    <div className="flex items-center gap-2">
      <span className="label">BREADTH</span>
      <div className="flex h-[7px] w-28 overflow-hidden rounded-full bg-[#16202f]">
        <div style={{ width: `${(b.advances / t) * 100}%`, background: "var(--long)" }} />
        <div style={{ width: `${(b.unchanged / t) * 100}%`, background: "#33415a" }} />
        <div style={{ width: `${(b.declines / t) * 100}%`, background: "var(--short)" }} />
      </div>
      <span className="mono text-[10px] text-[var(--muted)]">
        {b.advances}↑ / {b.declines}↓
      </span>
    </div>
  );
}

function NiftyBox({ payload }: { payload: ScanPayload | null }) {
  const n = payload?.nifty;
  return (
    <div className="flex items-center gap-2 sm:gap-2.5 panel-inset px-2.5 sm:px-3 py-1.5 shrink-0">
      <span className="label !text-[9px]">NIFTY 50</span>
      <span className="mono text-[13px] sm:text-[15px] font-bold">{n?.ltp != null ? fmtINR(n.ltp) : "N/A"}</span>
      <span className={`mono text-[11px] font-semibold ${signColor(n?.changePct)}`}>
        {fmtSigned(n?.changePct ?? null, 2, "%")}
      </span>
      <TrendBadge trend={n?.trend5m ?? null} />
    </div>
  );
}

// ---------------------------------------------------------------- stage flow

function StageNode({ icon, title, count, sub, tone }: { icon: React.ReactNode; title: string; count: string; sub: string; tone: string }) {
  return (
    <div className="panel-inset px-3.5 py-2.5 shrink-0 w-[152px] sm:w-auto sm:flex-1 sm:min-w-[130px] snap-start" style={{ borderColor: tone + "33" }}>
      <div className="flex items-center gap-1.5 text-[9.5px] tracking-[0.14em] uppercase font-semibold" style={{ color: tone }}>
        {icon} {title}
      </div>
      <div className="mono text-[22px] font-bold mt-0.5">{count}</div>
      <div className="text-[9.5px] text-[var(--faint)] leading-tight">{sub}</div>
    </div>
  );
}

function FlowArrow() {
  return (
    <svg width="34" height="12" className="shrink-0 self-center hidden sm:block">
      <line x1="0" y1="6" x2="26" y2="6" stroke="#2a3a55" strokeWidth="1.5" className="flow-line" />
      <path d="M26 2 L33 6 L26 10" fill="none" stroke="#2a3a55" strokeWidth="1.5" />
    </svg>
  );
}

function StageFlow({ payload }: { payload: ScanPayload | null }) {
  const m = payload?.meta;
  return (
    <div className="panel p-2.5 sm:p-3 flex flex-nowrap sm:flex-wrap items-stretch gap-1.5 overflow-x-auto mobile-scroll snap-x">
      <StageNode icon={<Database size={11} />} title="ALL F&O" count={m ? String(m.universeSize) : "—"} sub="live Upstox instrument master" tone="#8ea6c9" />
      <FlowArrow />
      <StageNode icon={<SignalHigh size={11} />} title="STAGE 1" count={m ? String(m.scanned) : "—"} sub="RVOL · RS · RS accel · VWAP · 5-min trend · futures" tone="var(--cyan)" />
      <FlowArrow />
      <StageNode icon={<ListFilter size={11} />} title="CANDIDATES" count={m ? String(m.candidateCount) : "—"} sub="hysteresis ≥ enter / < exit" tone="var(--wait)" />
      <FlowArrow />
      <StageNode icon={<Layers3 size={11} />} title="STAGE 2" count={m ? String(m.deepAnalysed) : "—"} sub="dynamic S/R · option chain · futures · R:R" tone="var(--violet)" />
      <FlowArrow />
      <StageNode icon={<Flame size={11} />} title="TOP SETUPS" count={String(payload?.trades?.length ?? 0)} sub="only valid risk/reward setups" tone="var(--long)" />
    </div>
  );
}

// ---------------------------------------------------------------- boards

function MiniRow({ r }: { r: Stage1Row }) {
  return (
    <a href={`/stock/${encodeURIComponent(r.symbol)}`} className="flex items-center gap-2 px-2.5 py-[7px] rounded-lg hover:bg-[rgba(148,184,255,.05)] transition-colors group">
      <span className="mono text-[12px] font-bold flex-1 min-w-0 sm:flex-none sm:w-24 truncate group-hover:text-[var(--cyan)]">{r.symbol}</span>
      <span className={`mono text-[10.5px] w-14 text-right hidden sm:inline ${signColor(r.changePct)}`}>{fmtSigned(r.changePct, 2, "%")}</span>
      <span className="mono text-[10.5px] w-12 text-right text-[var(--cyan)]">{r.rvol != null ? `${r.rvol.toFixed(1)}×` : "—"}</span>
      <span className={`mono text-[10.5px] w-14 text-right ${signColor(r.rs)}`}>{fmtSigned(r.rs, 2)}</span>
      <span className={`mono text-[10.5px] w-12 text-right hidden sm:inline ${signColor(r.rsAccel)}`}>{fmtSigned(r.rsAccel, 2)}</span>
      <span className="ml-auto flex items-center gap-1.5">
        <span className="hidden sm:inline-flex"><MomentumBadge m={r.momentum} /></span>
        {r.score != null && <span className="mono text-[10.5px] text-[var(--wait)] w-8 text-right">{Math.round(r.score)}</span>}
      </span>
    </a>
  );
}

/** Column header for the board rows — mirrors MiniRow geometry exactly. */
function MiniRowColumns() {
  return (
    <div className="flex items-center gap-2 px-2.5 pb-1 mono text-[9px] tracking-[0.12em] text-[var(--faint)] border-b border-[var(--line-soft)]">
      <span className="flex-1 min-w-0 sm:flex-none sm:w-24 truncate">SYMBOL</span>
      <span className="w-14 text-right hidden sm:inline">CHG%</span>
      <span className="w-12 text-right">RVOL</span>
      <span className="w-14 text-right">RS</span>
      <span className="w-12 text-right hidden sm:inline">ACC</span>
      <span className="ml-auto flex items-center gap-1.5">
        <span className="hidden sm:inline">STATE</span>
        <span className="w-8 text-right">SCORE</span>
      </span>
    </div>
  );
}

function Board({ icon, title, tone, rows, emptyText, columns }: { icon: React.ReactNode; title: string; tone: string; rows: Stage1Row[]; emptyText: string; columns?: React.ReactNode }) {
  return (
    <div className="panel p-2.5">
      <div className="flex items-center gap-1.5 px-1 pb-2 text-[10px] tracking-[0.16em] font-bold" style={{ color: tone }}>
        {icon} {title}
        <span className="ml-auto mono text-[var(--faint)]">{rows.length}</span>
      </div>
      {columns}
      {rows.length === 0 ? (
        <div className="px-2 py-3 text-[11px] text-[var(--faint)] mono">{emptyText}</div>
      ) : (
        <div className="flex flex-col">
          {rows.map((r) => (
            <MiniRow key={r.symbol} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- candidates table

function CandidatesTable({ payload }: { payload: ScanPayload }) {
  const set = new Set(payload.candidateSymbols);
  const rows = payload.rows.filter((r) => set.has(r.symbol));
  const cardMap = new Map(payload.candidatesDetail.map((c) => [c.symbol, c]));
  return (
    <div className="panel p-2.5 sm:p-3 overflow-hidden">
      <div className="flex items-center gap-2 px-1 pb-2.5">
        <Radar size={13} className="text-[var(--wait)]" />
        <span className="text-[11px] tracking-[0.16em] font-bold text-[var(--wait)]">STAGE 2 CANDIDATES</span>
        <span className="text-[10px] text-[var(--faint)] hidden sm:inline">— why each name advanced, and what Stage 2 concluded</span>
      </div>
      <div className="sm:hidden px-1 pb-1 mono text-[8.5px] text-[var(--faint)]">SWIPE TABLE →</div>
      <div className="overflow-x-auto mobile-scroll">
        <table className="w-full min-w-[1180px] text-[11px] mono">
          <thead>
            <tr className="text-left text-[9px] tracking-[0.12em] text-[var(--faint)] border-b border-[var(--line-soft)]">
              {["SYMBOL", "DIR", "SCORE", "DATA %", "MOMENTUM", "RVOL", "RS", "RS ACC", "5M TREND", "VWAP", "FUTURES", "LIQ ₹Cr", "STATUS", "STAGE 2 VERDICT", "FINAL"].map((h, i) => (
                <th key={h} className={`py-1.5 pr-3 font-semibold whitespace-nowrap ${i === 0 ? "sticky left-0 z-10 bg-[var(--panel-solid)]" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = cardMap.get(r.symbol);
              return (
                <tr key={r.symbol} className="border-b border-[var(--line-soft)] hover:bg-[rgba(148,184,255,.03)]">
                  <td className="py-2 pr-3 sticky left-0 z-[5] bg-[var(--panel-solid)]">
                    <a className="font-bold hover:text-[var(--cyan)]" href={`/stock/${encodeURIComponent(r.symbol)}`}>{r.symbol}</a>
                  </td>
                  <td className="pr-3 font-bold" style={{ color: r.dir === "LONG" ? "var(--long)" : r.dir === "SHORT" ? "var(--short)" : "var(--faint)" }}>{r.dir ?? "—"}</td>
                  <td className="pr-3 text-[var(--wait)] font-semibold">{r.score != null ? Math.round(r.score) : "—"}</td>
                  <td className="pr-3" title={r.missingMetrics?.length ? `missing: ${r.missingMetrics.join(", ")}` : "complete"}>
                    <span style={{ color: r.incomplete ? "var(--short)" : "var(--long)" }}>
                      {r.completeness != null ? `${r.completeness}%` : "N/A"}
                    </span>
                  </td>
                  <td className="pr-3"><MomentumBadge m={r.momentum} /></td>
                  <td className="pr-3 text-[var(--cyan)]">{r.rvol != null ? `${r.rvol.toFixed(2)}×` : "N/A"}</td>
                  <td className={`pr-3 ${signColor(r.rs)}`}>{fmtSigned(r.rs, 2, "%")}</td>
                  <td className={`pr-3 ${signColor(r.rsAccel)}`}>{fmtSigned(r.rsAccel, 2)}</td>
                  <td className="pr-3"><TrendBadge trend={r.trend5m} /></td>
                  <td className="pr-3 text-[var(--muted)]">{r.aboveVwap == null ? "N/A" : r.aboveVwap ? "above" : "below"}</td>
                  <td className="pr-3 text-[var(--muted)]" title={r.futLabel ?? ""}>{r.futLabel ?? "N/A"}</td>
                  <td className="pr-3 text-[var(--muted)]">{r.turnoverCr != null ? fmtCompact(r.turnoverCr) : "N/A"}</td>
                  <td className="pr-3"><StatusBadge status={r.status} /></td>
                  <td className="pr-3 max-w-[220px]">
                    {c ? (
                      <span className="whitespace-nowrap" style={{ color: c.setupState === "NO_TRADE" ? "var(--muted)" : c.setupState.startsWith("WAIT") ? "var(--wait)" : "var(--long)" }}>
                        {c.setupState.replace(/_/g, " ")}
                        {c.setupState === "NO_TRADE" && c.setup.reasons[0] ? ` · ${c.setup.reasons[0].slice(0, 44)}` : ""}
                      </span>
                    ) : (
                      <span className="text-[var(--faint)]">analysing…</span>
                    )}
                  </td>
                  <td className="font-bold">{c?.finalScore != null ? c.finalScore : "—"}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={15} className="py-6 text-center text-[var(--faint)]">
                  No candidates currently — Stage 1 thresholds not met
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- connect panel

function ConnectPanel({ onConnected }: { onConnected: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = await safeJson<{ ok?: boolean; user?: string | null; persisted?: boolean; error?: string }>(res);
      if (j.ok) {
        setToken("");
        if (j.persisted === false) {
          setMsg(`Connected${j.user ? ` as ${j.user}` : ""} — warning: token could not persist to the database; it stays active for this session only.`);
        } else {
          setMsg(null);
        }
        onConnected();
        setTimeout(onConnected, 4000);
      } else setMsg(j.error ?? "token validation failed");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel p-4 sm:p-8 max-w-2xl mx-auto mt-4 sm:mt-6 fade-up">
      <div className="flex items-center gap-2 text-[var(--cyan)]">
        <KeyRound size={16} />
        <span className="text-[12px] tracking-[0.2em] font-bold">CONNECT UPSTOX</span>
      </div>
      <h2 className="text-[19px] sm:text-[22px] font-bold mt-3 leading-tight">Link your Upstox API token to arm the scanner.</h2>
      <p className="text-[12.5px] text-[var(--muted)] mt-2 leading-relaxed">
        PULSE pulls every tick, candle, future and option chain from the official Upstox API v2
        using your own access token. The token is stored server-side only, never logged, and never
        sent to the browser. No market data is ever simulated — fields the API cannot provide
        render as <span className="mono text-[var(--wait)]">N/A</span>.
      </p>
      <ol className="mt-4 space-y-1.5 text-[12px] text-[var(--muted)] list-decimal list-inside mono">
        <li>Create an app at developer.upstox.com → get API key + secret</li>
        <li>Complete the OAuth login flow to mint today&apos;s access token</li>
        <li>Paste the token below — it is validated against /v2/user/profile</li>
      </ol>
      <div className="mt-5 flex flex-col sm:flex-row gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste Upstox access token…"
          className="w-full sm:flex-1 min-w-0 panel-inset px-3.5 py-2.5 text-[13px] mono outline-none focus:border-[var(--cyan)] placeholder:text-[var(--faint)] bg-transparent"
        />
        <button
          onClick={submit}
          disabled={busy || token.length < 20}
          className="w-full sm:w-auto px-5 py-2.5 rounded-lg text-[12px] font-bold tracking-wider border transition-all disabled:opacity-40"
          style={{ borderColor: "var(--cyan)", color: "var(--cyan)", background: "rgba(34,211,238,.08)" }}
        >
          {busy ? "VALIDATING…" : "CONNECT"}
        </button>
      </div>
      {msg && <div className="mt-3 text-[11.5px] mono text-[var(--short)]">✕ {msg}</div>}
      <div className="mt-5 flex items-center gap-2 text-[10px] text-[var(--faint)] mono">
        <ShieldAlert size={11} /> Token touches only api.upstox.com · zero synthetic data policy enforced engine-wide
      </div>
    </div>
  );
}


// ---------------------------------------------------------------- order flow dominance

function FlowCell({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="panel-inset px-2 py-1.5 min-w-0" title={v}>
      <div className="label !text-[8.5px]">{k}</div>
      <div className="mono text-[10.5px] font-semibold truncate" style={{ color: tone ?? "var(--txt)" }}>
        {v}
      </div>
    </div>
  );
}

function FlowRow({ e, rank }: { e: import("@/lib/orderflow").OrderFlowEntry; rank: number }) {
  const [open, setOpen] = useState(false);
  const buyer = e.side === "BUYER";
  const tone = buyer ? "var(--long)" : "var(--short)";
  const confTone =
    e.confidence === "HIGH" ? "var(--long)" : e.confidence === "MEDIUM" ? "var(--wait)" : "var(--faint)";
  return (
    <div className="border-b border-[var(--line-soft)] last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full grid grid-cols-[16px_minmax(0,1fr)_32px_auto_auto] sm:flex items-center gap-2 px-2 py-2 hover:bg-[rgba(148,184,255,.05)] transition-colors text-left"
      >
        <span className="mono text-[10px] text-[var(--faint)] w-4">{rank}</span>
        <a
          href={`/stock/${encodeURIComponent(e.symbol)}`}
          onClick={(ev) => ev.stopPropagation()}
          className="mono text-[12px] font-bold min-w-0 sm:w-20 truncate hover:text-[var(--cyan)]"
        >
          {e.symbol}
        </a>
        <span className="mono text-[13px] font-bold text-right sm:text-left" style={{ color: tone }}>
          {Math.round(e.score)}
        </span>
        <span
          className="chip !text-[8.5px] sm:!text-[9px] !px-1.5 sm:!px-[7px]"
          style={{ color: confTone, borderColor: confTone + "55" }}
          title={e.conflicting ? "CONFLICTING FLOW" : `Confidence ${e.confidence}`}
        >
          <span className="sm:hidden">{e.conflicting ? "! " : ""}</span>{e.confidence}
        </span>
        <span className="mono text-[9px] text-[var(--faint)] hidden sm:inline">{e.interpretation}</span>
        {e.conflicting && (
          <span className="hidden sm:inline-flex chip !text-[9px] text-[var(--wait)] border-[rgba(251,191,36,.4)]">CONFLICTING FLOW</span>
        )}
        <span className="sm:ml-auto flex items-center justify-end gap-1.5">
          <span className="hidden sm:inline-flex"><StatusBadge status={e.status} /></span>
          <ChevronDown size={12} className={`text-[var(--faint)] transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2.5 space-y-1.5 fade-up">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <FlowCell
              k="DEPTH (5-LEVEL)"
              v={
                e.depth.bid != null && e.depth.ask != null
                  ? `${fmtCompact(e.depth.bid)} / ${fmtCompact(e.depth.ask)} · ${e.depth.imb != null ? fmtSigned(e.depth.imb, 1, "%") : "N/A"}`
                  : "N/A"
              }
              tone={e.depth.imb != null ? (buyer ? (e.depth.imb > 0 ? "var(--long)" : "var(--short)") : e.depth.imb < 0 ? "var(--long)" : "var(--short)") : undefined}
            />
            <FlowCell
              k="ORDERS"
              v={
                e.orders.bid != null && e.orders.ask != null
                  ? `${e.orders.bid} / ${e.orders.ask} · ${e.orders.imb != null ? fmtSigned(e.orders.imb, 1, "%") : "N/A"}`
                  : "N/A"
              }
            />
            <FlowCell
              k="TOTAL BID/ASK QTY"
              v={
                e.totals.buy != null && e.totals.sell != null
                  ? `${fmtCompact(e.totals.buy)} / ${fmtCompact(e.totals.sell)}`
                  : "N/A"
              }
            />
            <FlowCell
              k="PRICE PRESSURE"
              v={`${e.components.priceAction != null ? Math.round(e.components.priceAction) : "N/A"}/100${e.ret5m != null ? ` · 5m ${fmtSigned(e.ret5m, 2, "%")}` : ""}`}
              tone={e.components.priceAction != null ? (e.components.priceAction >= 55 ? "var(--long)" : e.components.priceAction <= 45 ? "var(--short)" : undefined) : undefined}
            />
            <FlowCell k="VOLUME / RVOL" v={e.rvol != null ? `${e.rvol.toFixed(2)}×` : "N/A"} tone={e.rvol != null && e.rvol >= 1.5 ? "var(--cyan)" : undefined} />
            <FlowCell k="FUTURES POSITIONING" v={e.futLabel ?? "UNAVAILABLE"} />
            <FlowCell
              k="VWAP STRUCTURE"
              v={
                e.vwap != null
                  ? `₹${fmtINR(e.vwap)} · sustain ${e.vwapSustain != null ? Math.round(e.vwapSustain * 100) : "N/A"}%${e.vwapCrossings != null ? ` · ${e.vwapCrossings} crosses` : ""}`
                  : "N/A"
              }
            />
            <FlowCell
              k="MOMENTUM ACCEL"
              v={`RS ${e.rsAccel != null ? fmtSigned(e.rsAccel, 2) : "N/A"} · PX ${e.priceAccel != null ? fmtSigned(e.priceAccel, 2) : "N/A"}`}
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[10px] mono">
            <span className="label">DOMINANCE TREND</span>
            <span className="chip" style={{ color: e.trend === "ACCELERATING" ? "var(--long)" : e.trend === "WEAKENING" ? "var(--short)" : "var(--muted)" }}>
              {e.trend === "ACCELERATING" ? <ArrowUp size={11} /> : e.trend === "WEAKENING" ? <ArrowDown size={11} /> : e.trend === "REVERSING" ? <Repeat size={11} /> : <Minus size={11} />}
              {e.trend}
            </span>
            <span className="label">DATA</span>
            <span className="chip">
              {e.completeness}% · {e.status}
            </span>
            {e.reason && <span className="text-[var(--wait)]">{e.reason}</span>}
          </div>
          <div className="mono text-[9px] text-[var(--faint)] leading-snug">
            {buyer
              ? "Buy-side pressure reading from real depth, volume, price action and positioning — market pressure, not participant identity."
              : "Sell-side pressure reading from real depth, volume, price action and positioning — market pressure, not participant identity."}
          </div>
        </div>
      )}
    </div>
  );
}

function OrderFlowPanel({ payload }: { payload: ScanPayload }) {
  const of = payload.orderFlow;
  return (
    <div className="panel p-3 mt-3 sm:mt-4">
      <div className="flex items-center gap-2 px-1 pb-2 flex-wrap">
        <Waves size={14} className="text-[var(--violet)]" />
        <span className="text-[11px] tracking-[0.2em] font-bold">ORDER FLOW DOMINANCE</span>
        <span className="mono text-[9.5px] text-[var(--faint)]">
          independent of Stage 1 / Stage 2 · market pressure, never participant identity · ranks only ≥ 60/100
        </span>
        {of && (
          <span className="ml-auto mono text-[9px] text-[var(--faint)]">
            {of.universeConsidered} scored · updated {new Date(of.computedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })} IST
          </span>
        )}
      </div>
      {!of ? (
        <div className="px-2 py-4 text-[11px] text-[var(--faint)] mono">collecting order-flow observations…</div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-2">
          <div>
            <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[9.5px] tracking-[0.14em] font-bold text-[var(--long)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--long)] pulse-dot" /> TOP BUYER DOMINANCE
              <span className="ml-auto mono text-[var(--faint)] font-normal">{of.buySide.length}/5</span>
            </div>
            <div className="panel-inset overflow-hidden">
              {of.buySide.length === 0 ? (
                <div className="px-2 py-3 text-[10.5px] text-[var(--faint)] mono">
                  no stock currently meets the 60/100 buyer-dominance threshold — not forced
                </div>
              ) : (
                of.buySide.map((e, i) => <FlowRow key={e.symbol} e={e} rank={i + 1} />)
              )}
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[9.5px] tracking-[0.14em] font-bold text-[var(--short)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--short)] pulse-dot" /> TOP SELLER DOMINANCE
              <span className="ml-auto mono text-[var(--faint)] font-normal">{of.sellSide.length}/5</span>
            </div>
            <div className="panel-inset overflow-hidden">
              {of.sellSide.length === 0 ? (
                <div className="px-2 py-3 text-[10.5px] text-[var(--faint)] mono">
                  no stock currently meets the 60/100 seller-dominance threshold — not forced
                </div>
              ) : (
                of.sellSide.map((e, i) => <FlowRow key={e.symbol} e={e} rank={i + 1} />)
              )}
            </div>
          </div>
        </div>
      )}
      <div className="mt-2 px-1 mono text-[8.5px] text-[var(--faint)] leading-snug">
        Components — depth 20% · order count 10% · price action 20% · volume/RVOL 15% · futures positioning 20% · VWAP 10% · momentum accel 5%.
        Order-book imbalance alone is never treated as proof of buying or selling; conflicting signals are capped and labelled.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings drawer

const NUM_FIELDS: Array<[keyof ScannerConfig, string]> = [
  ["scanIntervalSec", "Scan interval (sec)"],
  ["deepRefreshSec", "Stage-2 refresh (sec)"],
  ["candidateTopK", "Stage-2 budget (Top-K)"],
  ["topTrades", "Top-N setups"],
  ["enterScore", "Enter candidate ≥ score"],
  ["exitScore", "Exit candidate < score"],
  ["minDwellScans", "Min dwell (scans)"],
  ["rvolMin", "RVOL trigger"],
  ["rvolHigh", "RVOL = 100 score"],
  ["rsHigh", "RS% = 100 score"],
  ["minTurnoverCr", "Min turnover ₹Cr"],
  ["rvolBaselineDays", "RVOL baseline days"],
  ["zoneTolerancePct", "Zone tolerance %"],
  ["levelMinStrength", "Min level strength"],
  ["openingRangeMinutes", "Opening range (min)"],
  ["chainWindowPct", "Chain window ±%"],
  ["minRR", "Min R:R"],
  ["rrFullScore", "R:R = 100 score"],
  ["minCompletenessPct", "Min data completeness %"],
  ["staleAfterSec", "LIVE→RECENT after (sec)"],
  ["missingAfterSec", "RECENT→STALE after (sec)"],
  ["futFlatPct", "Futures flat band %"],
  ["futOiFlatPct", "Futures OI flat band %"],
  ["rolloverDaysBefore", "Rollover window (days)"],
  ["futMinTurnoverCr", "Futures min turnover ₹Cr"],
  ["breakoutBufferBps", "Entry buffer (bps)"],
  ["slBufferBps", "Stop buffer (bps)"],
  ["breakoutProximityPct", "Breakout proximity %"],
  ["maxRequestsPerSec", "Max API req/sec"],
  ["universeConcurrency", "Fetch concurrency"],
];

const S1W: Array<[keyof ScannerConfig["stage1Weights"], string]> = [
  ["rvol", "RVOL"],
  ["relativeStrength", "Relative strength"],
  ["rsAcceleration", "RS acceleration"],
  ["trend5m", "5-min trend"],
  ["vwap", "Price vs VWAP"],
  ["futures", "Futures confirm"],
  ["liquidity", "Liquidity"],
];

const S2W: Array<[keyof ScannerConfig["stage2Weights"], string]> = [
  ["priceStructure", "Price structure"],
  ["rvol", "RVOL"],
  ["relativeStrength", "Relative strength"],
  ["rsAcceleration", "RS acceleration"],
  ["srQuality", "S/R quality"],
  ["optionConfluence", "Option confluence"],
  ["futures", "Futures confirm"],
  ["trend5m", "5-min trend"],
  ["riskReward", "Risk / reward"],
];

function SettingsDrawer({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<ScannerConfig | null>(null);
  const [tokenInfo, setTokenInfo] = useState<{ configured: boolean; masked: string | null; user: string | null } | null>(null);
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void fetch("/api/config").then(safeJson<{ config: ScannerConfig }>).then((j) => setCfg(j.config));
    void fetch("/api/token").then(safeJson<typeof tokenInfo>).then(setTokenInfo);
  }, [open]);

  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) }).then(safeJson);
      setMsg("Configuration saved — applied on next scan");
    } catch (e) {
      setMsg(`save failed: ${(e as Error).message}`);
    }
    setBusy(false);
    onSaved();
  };

  const setTokenBtn = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const j = await safeJson<{ ok?: boolean; error?: string }>(res);
      setMsg(j.ok ? "Token validated & saved" : `Token rejected: ${j.error ?? "validation failed"}`);
    } catch (e) {
      setMsg(`connect failed: ${(e as Error).message}`);
    }
    setToken("");
    setBusy(false);
    void fetch("/api/token").then(safeJson<typeof tokenInfo>).then(setTokenInfo).catch(() => undefined);
    onSaved();
  };

  const clearToken = async () => {
    try {
      await fetch("/api/token", { method: "DELETE" }).then(safeJson);
      setMsg("Token removed");
    } catch (e) {
      setMsg(`revoke failed: ${(e as Error).message}`);
    }
    void fetch("/api/token").then(safeJson<typeof tokenInfo>).then(setTokenInfo).catch(() => undefined);
    onSaved();
  };

  if (!open) return null;
  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: "rgba(2,4,8,.6)", backdropFilter: "blur(3px)" }} onClick={onClose}>
      <div className="mobile-drawer h-full w-full max-w-md overflow-y-auto mobile-scroll p-3 sm:p-5 border-l border-[var(--line)]" style={{ background: "#070b12" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[12px] tracking-[0.2em] font-bold text-[var(--cyan)]">
            <Settings2 size={14} /> ENGINE SETTINGS
          </div>
          <button onClick={onClose} className="chip"><X size={12} /></button>
        </div>

        <div className="mt-5 panel p-3.5">
          <div className="label mb-2">UPSTOX ACCESS TOKEN</div>
          <div className="mono text-[11.5px] text-[var(--muted)]">
            {tokenInfo?.configured ? (
              <>connected {tokenInfo.masked} · {tokenInfo.user ?? "user"}</>
            ) : (
              <span className="text-[var(--wait)]">no token configured</span>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap sm:flex-nowrap gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="replace token…"
              className="basis-full sm:basis-auto sm:flex-1 min-w-0 panel-inset px-3 py-2 text-[12px] mono outline-none focus:border-[var(--cyan)] placeholder:text-[var(--faint)] bg-transparent"
            />
            <button onClick={setTokenBtn} disabled={busy || token.length < 20} className="chip !py-2 hover:text-[var(--cyan)] hover:border-[var(--cyan)] disabled:opacity-40">SET</button>
            {tokenInfo?.configured && (
              <button onClick={clearToken} className="chip !py-2 hover:text-[var(--short)] hover:border-[var(--short)]">REVOKE</button>
            )}
          </div>
        </div>

        {cfg && (
          <>
            <div className="mt-4 panel p-3.5">
              <div className="label mb-2.5">THRESHOLDS</div>
              <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-x-3 sm:gap-x-4 gap-y-2.5">
                {NUM_FIELDS.map(([k, label]) => (
                  <label key={k} className="block">
                    <span className="text-[9.5px] text-[var(--muted)] tracking-wide uppercase">{label}</span>
                    <input
                      type="number"
                      step="any"
                      value={(cfg[k] as number | null) ?? ""}
                      onChange={(e) => setCfg({ ...cfg, [k]: num(e.target.value) })}
                      className="mt-0.5 w-full panel-inset px-2.5 py-1.5 text-[12px] mono outline-none focus:border-[var(--cyan)] bg-transparent"
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-4 panel p-3.5">
              <div className="label mb-2.5">STAGE 1 WEIGHTS (%)</div>
              <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-x-3 sm:gap-x-4 gap-y-2.5">
                {S1W.map(([k, label]) => (
                  <label key={k} className="block">
                    <span className="text-[9.5px] text-[var(--muted)] tracking-wide uppercase">{label}</span>
                    <input
                      type="number"
                      step="any"
                      value={cfg.stage1Weights[k]}
                      onChange={(e) => setCfg({ ...cfg, stage1Weights: { ...cfg.stage1Weights, [k]: num(e.target.value) } })}
                      className="mt-0.5 w-full panel-inset px-2.5 py-1.5 text-[12px] mono outline-none focus:border-[var(--cyan)] bg-transparent"
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-4 panel p-3.5">
              <div className="label mb-2.5">STAGE 2 WEIGHTS (%)</div>
              <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-x-3 sm:gap-x-4 gap-y-2.5">
                {S2W.map(([k, label]) => (
                  <label key={k} className="block">
                    <span className="text-[9.5px] text-[var(--muted)] tracking-wide uppercase">{label}</span>
                    <input
                      type="number"
                      step="any"
                      value={cfg.stage2Weights[k]}
                      onChange={(e) => setCfg({ ...cfg, stage2Weights: { ...cfg.stage2Weights, [k]: num(e.target.value) } })}
                      className="mt-0.5 w-full panel-inset px-2.5 py-1.5 text-[12px] mono outline-none focus:border-[var(--cyan)] bg-transparent"
                    />
                  </label>
                ))}
              </div>
            </div>
            <button onClick={save} disabled={busy} className="mt-4 w-full py-2.5 rounded-lg text-[12px] font-bold tracking-widest border disabled:opacity-40 hover:bg-[rgba(34,211,238,.12)] transition-colors" style={{ borderColor: "var(--cyan)", color: "var(--cyan)" }}>
              SAVE CONFIGURATION
            </button>
          </>
        )}
        {msg && <div className="mt-3 mono text-[11px] text-[var(--cyan)]">{msg}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function Dashboard() {
  const { payload, err, loading, reload } = useScan();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const now = useNow();
  void now;

  const tokenOk = payload?.meta?.tokenConfigured ?? false;
  const paused = payload?.meta?.suggestionsPaused ?? true;
  const liveCount = payload ? payload.rows.filter((r) => r.status === "LIVE").length : 0;
  const staleCount = payload ? payload.rows.filter((r) => r.status === "STALE" || r.status === "UNAVAILABLE").length : 0;

  return (
    <div className="max-w-[1720px] mx-auto px-2.5 sm:px-5 pb-12 sm:pb-16">
      {/* ------------------------------------------------ command bar */}
      <header className="sticky top-0 z-40 -mx-2.5 sm:-mx-5 px-2.5 sm:px-5 py-2 sm:py-2.5 border-b border-[var(--line)] backdrop-blur-md" style={{ background: "rgba(4,6,11,.82)" }}>
        <div className="flex items-center gap-2 sm:gap-3 flex-nowrap sm:flex-wrap">
          <div className="flex items-center gap-2 sm:gap-2.5 mr-auto sm:mr-1 shrink-0">
            <div className="h-8 w-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(52,211,153,.2), rgba(34,211,238,.15))", border: "1px solid rgba(52,211,153,.35)" }}>
              <Activity size={16} className="text-[var(--long)]" />
            </div>
            <div className="leading-none">
              <div className="text-[15px] font-bold tracking-tight">
                PULSE<span className="text-[var(--cyan)]">·</span>F&O
              </div>
              <div className="text-[8.5px] tracking-[0.28em] text-[var(--faint)] mt-0.5">NSE INTRADAY SCANNER</div>
            </div>
          </div>

          <div className="hidden sm:contents">
            <MarketPill payload={payload} />
            <span className="chip mono">IST {istClock()}</span>
            <NiftyBox payload={payload} />
            <BreadthBar b={payload?.breadth ?? null} />
            {payload?.regime && (
              <span
                className="chip font-bold"
                style={{
                  color: payload.regime === "RISK-ON" ? "var(--long)" : payload.regime === "RISK-OFF" ? "var(--short)" : "var(--wait)",
                  borderColor: "currentColor",
                }}
              >
                {payload.regime === "RISK-ON" ? <TrendingUp size={11} /> : payload.regime === "RISK-OFF" ? <TrendingDown size={11} /> : <Gauge size={11} />}
                {payload.regime}
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {payload?.meta?.runAt && (
              <span className="mono text-[10px] text-[var(--faint)] hidden md:inline">
                scan {timeAgo(payload.meta.runAt)} · {payload.meta.durationMs != null ? `${(payload.meta.durationMs / 1000).toFixed(1)}s` : ""}
              </span>
            )}
            <span className="chip hidden lg:inline-flex" title="data feeds">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: liveCount > 0 ? "var(--long)" : "var(--faint)" }} /> {liveCount} live
              <span className="text-[var(--faint)]">·</span>
              <span style={{ color: staleCount > 0 ? "var(--wait)" : "var(--faint)" }}>{staleCount} stale</span>
            </span>
            <button onClick={() => void reload(true)} disabled={loading} className="chip !py-1.5 hover:border-[var(--cyan)] hover:text-[var(--cyan)] disabled:opacity-40" title="Run scan now" aria-label="Run scan now">
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
              <span className="hidden min-[360px]:inline">SCAN</span>
            </button>
            <button onClick={() => setSettingsOpen(true)} className="chip !py-1.5 hover:border-[var(--cyan)] hover:text-[var(--cyan)]" title="Engine settings">
              <Settings2 size={12} />
            </button>
          </div>
        </div>
        <div className="sm:hidden mt-2 overflow-x-auto mobile-scroll pb-0.5">
          <div className="flex items-center gap-2 min-w-max">
            <MarketPill payload={payload} />
            <span className="chip mono">IST {istClock()}</span>
            <NiftyBox payload={payload} />
            <BreadthBar b={payload?.breadth ?? null} />
            {payload?.regime && (
              <span
                className="chip font-bold"
                style={{
                  color: payload.regime === "RISK-ON" ? "var(--long)" : payload.regime === "RISK-OFF" ? "var(--short)" : "var(--wait)",
                  borderColor: "currentColor",
                }}
              >
                {payload.regime}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* ------------------------------------------------ banners */}
      {tokenOk && paused && payload?.meta?.market?.phase !== "OPEN" && (
        <div className="mt-3 sm:mt-4 panel px-3 sm:px-4 py-2.5 flex items-start sm:items-center flex-wrap sm:flex-nowrap gap-2 text-[11px] sm:text-[12px]" style={{ borderColor: "rgba(251,191,36,.3)" }}>
          <Moon size={14} className="text-[var(--wait)]" />
          <span className="text-[var(--wait)] font-bold tracking-widest mono text-[11px]">MARKET CLOSED</span>
          <span className="text-[var(--muted)] basis-full sm:basis-auto">
            NSE trades 09:15–15:30 IST. Live signals are paused — figures below are the last real Upstox snapshot. No synthetic prices or signals are generated outside market hours.
          </span>
        </div>
      )}
      {payload?.meta?.errors?.length ? (
        <div className="mt-4 panel px-4 py-2 text-[11px] mono text-[var(--wait)]">
          {payload.meta.errors.map((e, i) => (
            <div key={i}>⚠ {e}</div>
          ))}
        </div>
      ) : null}
      {err && <div className="mt-4 panel px-4 py-2 text-[11px] mono text-[var(--short)]">API unreachable: {err}</div>}

      {/* ------------------------------------------------ stage flow */}
      <div className="mt-4">
        <StageFlow payload={payload} />
      </div>

      {/* ------------------------------------------------ body */}
      {!tokenOk ? (
        <ConnectPanel onConnected={() => void reload(true)} />
      ) : (
        <div className="mt-3 sm:mt-4 grid grid-cols-12 gap-3 sm:gap-4">
          {/* main column */}
          <div className="col-span-12 xl:col-span-8 2xl:col-span-9 space-y-4">
            <div className="flex items-center gap-2 px-0.5 flex-wrap">
              <Flame size={15} className="text-[var(--long)]" />
              <span className="text-[12px] tracking-[0.2em] font-bold">TOP TRADE SETUPS</span>
              <span className="mono text-[10px] sm:text-[11px] text-[var(--faint)] basis-full sm:basis-auto">
                {payload?.trades?.length ?? 0} of max 10 · structure × momentum × options × futures confluence
              </span>
            </div>
            {!payload ? (
              <div className="grid gap-3 sm:gap-4 2xl:grid-cols-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="panel h-64 skeleton" />
                ))}
              </div>
            ) : payload.trades.length === 0 ? (
              <EmptyState
                icon={<Zap size={22} className="text-[var(--faint)]" />}
                title={payload.meta.market.isOpen ? "No qualifying setups right now" : "Market closed — no active setups"}
                sub={
                  payload.meta.market.isOpen
                    ? "The engine refuses to force trades. Names appear only when structure, momentum, options and futures converge with acceptable R:R."
                    : "Signals resume when NSE opens. Historical analysis remains available on individual desks."
                }
              />
            ) : (
              <div className="grid gap-3 sm:gap-4 2xl:grid-cols-2">
                {payload.trades.map((c, i) => (
                  <TradeCardView key={c.symbol} card={c} rank={i + 1} />
                ))}
              </div>
            )}

            {payload && <CandidatesTable payload={payload} />}
          </div>

          {/* side boards */}
          <div className="col-span-12 xl:col-span-4 2xl:col-span-3 space-y-4">
            <Board icon={<Zap size={11} />} title="EARLY MOMENTUM" tone="var(--wait)" rows={payload?.boards.earlyMomentum ?? []} emptyText="1-min detection quiet" columns={<MiniRowColumns />} />
            <Board icon={<Activity size={11} />} title="CONFIRMED MOMENTUM" tone="var(--long)" rows={payload?.boards.confirmedMomentum ?? []} emptyText="no 5-min confirmations yet" columns={<MiniRowColumns />} />
            <div className="panel p-2.5">
              <div className="flex items-center gap-1.5 px-1 pb-2 text-[10px] tracking-[0.16em] font-bold text-[var(--cyan)]">
                <ArrowRight size={11} /> BREAKOUT / BREAKDOWN WATCH
              </div>
              <div className="flex items-center gap-2 px-2.5 pb-1 mono text-[9px] tracking-[0.12em] text-[var(--faint)] border-b border-[var(--line-soft)]">
                <span className="w-24">SYMBOL</span>
                <span>TRIGGER</span>
                <span className="ml-auto">LTP</span>
              </div>
              {[...(payload?.watchBreakout ?? []), ...(payload?.watchBreakdown ?? [])].length === 0 ? (
                <div className="px-2 py-3 text-[11px] text-[var(--faint)] mono">no triggers armed at levels</div>
              ) : (
                <div className="flex flex-col">
                {[...(payload?.watchBreakout ?? []), ...(payload?.watchBreakdown ?? [])].map((c) => (
                  <a key={c.symbol} href={`/stock/${encodeURIComponent(c.symbol)}`} className="flex items-center gap-2 px-2.5 py-[7px] rounded-lg hover:bg-[rgba(148,184,255,.05)] mono text-[11px]">
                    <span className="font-bold w-24 truncate">{c.symbol}</span>
                    <span className={c.setupState === "WAIT_FOR_BREAKOUT" ? "text-[var(--long)]" : "text-[var(--short)]"}>
                      {c.setupState === "WAIT_FOR_BREAKOUT" ? "▲" : "▼"} {c.setup.entryHigh != null ? fmtINR(c.setup.entryHigh) : fmtINR(c.setup.entryLow)}
                    </span>
                    <span className="ml-auto text-[var(--faint)]">px {fmtINR(c.ltp)}</span>
                  </a>
                ))}
                </div>
              )}
            </div>
            <Board icon={<TrendingUp size={11} />} title="STRONGEST RS" tone="var(--long)" rows={payload?.boards.strongestRS ?? []} emptyText="RS unavailable (NIFTY data)" columns={<MiniRowColumns />} />
            <Board icon={<TrendingDown size={11} />} title="STRONGEST RW" tone="var(--short)" rows={payload?.boards.strongestRW ?? []} emptyText="RS unavailable (NIFTY data)" columns={<MiniRowColumns />} />
            <Board icon={<Gauge size={11} />} title="HIGHEST RVOL" tone="var(--cyan)" rows={payload?.boards.highestRVOL ?? []} emptyText="RVOL baseline warming up" columns={<MiniRowColumns />} />
          </div>
        </div>
      )}

      {tokenOk && payload && <OrderFlowPanel payload={payload} />}

      <footer className="mt-10 border-t border-[var(--line-soft)] pt-4 flex items-center justify-between flex-wrap gap-2 text-[10px] text-[var(--faint)] mono">
        <span>PULSE · two-stage F&O engine · every figure sourced live from Upstox API — N/A when unavailable, never synthesized</span>
        <span>For research only. Not investment advice. Intraday derivatives carry substantial risk.</span>
      </footer>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={() => void reload(false)} />
    </div>
  );
}

"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Candle } from "@/lib/upstox";
import type { Zone } from "@/lib/scanner";
import { fmtINR } from "@/components/ui";

export interface ChartOverlays {
  vwap: Array<number | null>;
  ema9: Array<number | null>;
  ema20: Array<number | null>;
  ema50: Array<number | null>;
  bb: Array<{ mid: number; upper: number; lower: number } | null>;
}

export interface PlanLines {
  entryLow: number | null;
  entryHigh: number | null;
  stop: number | null;
  t1: number | null;
  t2: number | null;
  t3: number | null;
  ltp: number | null;
}

interface Props {
  candles: Candle[];
  overlays: ChartOverlays | null;
  zones: Zone[];
  plan: PlanLines | null;
  height?: number;
}

const KIND_SHORT: Record<string, string> = {
  PDH: "PDH", PDL: "PDL", PDC: "PDC", OPEN: "O", ORH: "ORH", ORL: "ORL",
  SWING_H: "SWH", SWING_L: "SWL", CONSOL: "VOL", VWAP: "VWAP", CE_OI: "CE", PE_OI: "PE",
};

export function CandleChart({ candles, overlays, zones, plan, height = 460 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      for (const e of es) setWidth(Math.max(320, e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const mobile = width < 640;
  const chartHeight = mobile ? Math.min(height, 360) : height;
  const padL = mobile ? 4 : 8;
  const padR = mobile ? 58 : 84;
  const padT = 14;
  const volH = Math.round(chartHeight * (mobile ? 0.12 : 0.14));
  const priceH = chartHeight - volH - 40;

  const model = useMemo(() => {
    if (!candles.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    let maxV = 0;
    for (const c of candles) {
      lo = Math.min(lo, c.l);
      hi = Math.max(hi, c.h);
      maxV = Math.max(maxV, c.v);
    }
    const zoneInRange = zones.filter((z) => z.high >= lo * 0.97 && z.low <= hi * 1.03);
    for (const z of zoneInRange) {
      lo = Math.min(lo, z.low);
      hi = Math.max(hi, z.high);
    }
    for (const v of [plan?.entryLow, plan?.entryHigh, plan?.stop, plan?.t1, plan?.t2, plan?.t3, plan?.ltp]) {
      if (v != null && Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const span = Math.max(hi - lo, hi * 0.002);
    lo -= span * 0.06;
    hi += span * 0.06;
    return { lo, hi, maxV, zoneInRange };
  }, [candles, zones, plan]);

  if (!model || !candles.length) {
    return (
      <div
        ref={wrapRef}
        className="flex items-center justify-center text-[12px] mono text-[var(--faint)] panel-inset"
        style={{ height: chartHeight }}
      >
        NO CHART DATA — Upstox intraday candles unavailable for this symbol
      </div>
    );
  }

  const { lo, hi, maxV } = model;
  const plotW = width - padL - padR;
  const n = candles.length;
  const x = (i: number) => padL + ((i + 0.5) / n) * plotW;
  const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * priceH;
  const yv = (v: number) => padT + priceH + 24 + (1 - (maxV > 0 ? v / maxV : 0)) * volH;

  const linePath = (series: Array<number | null>): string => {
    let d = "";
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = series[i];
      if (v == null) continue;
      d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      started = true;
    }
    return d;
  };

  const bbUpper = overlays ? overlays.bb.map((b) => b?.upper ?? null) : [];
  const bbLower = overlays ? overlays.bb.map((b) => b?.lower ?? null) : [];

  const gridLines = 5;
  const hov = hover != null && hover >= 0 && hover < n ? candles[hover] : null;
  const timeLabel = (t: number) =>
    new Date(t).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" });

  const updateHover = (clientX: number, svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect();
    const rel = clientX - rect.left - padL;
    const idx = Math.floor((rel / plotW) * n);
    setHover(Math.max(0, Math.min(n - 1, idx)));
  };

  return (
    <div ref={wrapRef} className="relative select-none">
      <svg width={width} height={chartHeight} className="block">
        {/* grid */}
        {Array.from({ length: gridLines + 1 }).map((_, i) => {
          const p = lo + ((hi - lo) * i) / gridLines;
          return (
            <g key={i}>
              <line x1={padL} x2={width - padR} y1={y(p)} y2={y(p)} stroke="#111a29" strokeWidth={1} />
              <text x={width - padR + 8} y={y(p) + 3.5} fontSize={9.5} fill="#4a5b74" fontFamily="JetBrains Mono, monospace">
                {fmtINR(p, 0)}
              </text>
            </g>
          );
        })}
        {/* time labels */}
        {Array.from({ length: Math.min(mobile ? 4 : 8, n) }).map((_, i) => {
          const labelCount = Math.min(mobile ? 4 : 8, n);
          const idx = Math.floor((i / Math.max(1, labelCount - 1)) * (n - 1));
          return (
            <text key={i} x={x(idx)} y={padT + priceH + volH + 38} fontSize={9} fill="#3d4b61" textAnchor="middle" fontFamily="JetBrains Mono, monospace">
              {timeLabel(candles[idx].t)}
            </text>
          );
        })}

        {/* S/R zones */}
        {model.zoneInRange.map((z) => {
          const isRes = z.side === "RESISTANCE";
          const color = isRes ? "248,113,113" : "52,211,153";
          const y1 = y(z.high);
          const y2 = y(z.low);
          return (
            <g key={z.id}>
              <rect x={padL} y={y1} width={plotW} height={Math.max(2, y2 - y1)} fill={`rgba(${color},${0.05 + (z.strength / 100) * 0.12})`} stroke={`rgba(${color},.35)`} strokeWidth={z.strength >= 60 ? 1 : 0.4} strokeDasharray={z.hasOption ? "0" : "3 4"} />
              <text x={padL + 4} y={y1 + 10} fontSize={9} fill={`rgba(${color},.9)`} fontFamily="JetBrains Mono, monospace" fontWeight={700}>
                {z.kinds.map((k) => KIND_SHORT[k] ?? k).join("+")} · {z.strength}
                {z.hasOption ? " · OPT" : ""}
              </text>
            </g>
          );
        })}

        {/* plan lines */}
        {plan &&
          (
            [
              [plan.entryHigh ?? plan.entryLow, "#22d3ee", "ENTRY", "4 3"],
              [plan.stop, "#f87171", "SL", "2 3"],
              [plan.t1, "#34d399", "T1", "6 3"],
              [plan.t2, "#34d399", "T2", "6 3"],
              [plan.t3, "#34d399", "T3", "6 3"],
              [plan.ltp, "#e2e8f0", "LTP", "1 2"],
            ] as Array<[number | null, string, string, string]>
          ).map(([v, color, label, dash], i) =>
            v == null ? null : (
              <g key={i}>
                <line x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} stroke={color} strokeWidth={1.1} strokeDasharray={dash} opacity={0.9} />
                <text x={width - padR + 8} y={y(v) + 3.5} fontSize={9} fill={color} fontFamily="JetBrains Mono, monospace" fontWeight={700}>
                  {label} {fmtINR(v)}
                </text>
              </g>
            ),
          )}

        {/* volume */}
        {candles.map((c, i) => (
          <rect
            key={`v${i}`}
            x={x(i) - Math.max(1, plotW / n / 2 - 0.8)}
            y={yv(c.v)}
            width={Math.max(1, plotW / n - 1.6)}
            height={padT + priceH + 24 + volH - yv(c.v)}
            fill={c.c >= c.o ? "rgba(52,211,153,.35)" : "rgba(248,113,113,.35)"}
          />
        ))}

        {/* bollinger */}
        {overlays && (
          <>
            <path d={linePath(bbUpper)} fill="none" stroke="rgba(167,139,250,.5)" strokeWidth={0.8} />
            <path d={linePath(bbLower)} fill="none" stroke="rgba(167,139,250,.5)" strokeWidth={0.8} />
          </>
        )}

        {/* candles */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const color = up ? "#34d399" : "#f87171";
          const bw = Math.max(1.6, plotW / n - 2);
          return (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={1} />
              <rect
                x={x(i) - bw / 2}
                y={y(Math.max(c.o, c.c))}
                width={bw}
                height={Math.max(1.2, Math.abs(y(c.o) - y(c.c)))}
                fill={up ? "rgba(52,211,153,.85)" : "rgba(248,113,113,.85)"}
                rx={0.5}
              />
            </g>
          );
        })}

        {/* overlays: vwap / emas */}
        {overlays && (
          <>
            <path d={linePath(overlays.vwap)} fill="none" stroke="#fbbf24" strokeWidth={1.4} />
            <path d={linePath(overlays.ema9)} fill="none" stroke="#22d3ee" strokeWidth={1} opacity={0.9} />
            <path d={linePath(overlays.ema20)} fill="none" stroke="#a78bfa" strokeWidth={1} opacity={0.9} />
            <path d={linePath(overlays.ema50)} fill="none" stroke="#94a3b8" strokeWidth={1} opacity={0.7} strokeDasharray="4 3" />
          </>
        )}

        {/* crosshair */}
        {hover != null && (
          <g className="crosshair-v">
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + priceH + volH + 24} stroke="#31405c" strokeWidth={1} strokeDasharray="3 3" />
          </g>
        )}

        {/* hover capture */}
        <rect
          x={padL}
          y={padT}
          width={plotW}
          height={priceH + volH + 24}
          fill="transparent"
          style={{ touchAction: "pan-y" }}
          onMouseMove={(e) => updateHover(e.clientX, e.currentTarget.ownerSVGElement as SVGSVGElement)}
          onMouseLeave={() => setHover(null)}
          onTouchStart={(e) => {
            const touch = e.touches[0];
            if (touch) updateHover(touch.clientX, e.currentTarget.ownerSVGElement as SVGSVGElement);
          }}
          onTouchMove={(e) => {
            const touch = e.touches[0];
            if (touch) updateHover(touch.clientX, e.currentTarget.ownerSVGElement as SVGSVGElement);
          }}
          onTouchEnd={() => setHover(null)}
        />
      </svg>

      {/* legend */}
      <div className="absolute top-2 left-2 sm:left-3 right-2 flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-0.5 mono text-[8.5px] sm:text-[9.5px] pointer-events-none">
        <span className="flex items-center gap-1 text-[#fbbf24]">— VWAP</span>
        <span className="flex items-center gap-1 text-[#22d3ee]">— EMA9</span>
        <span className="flex items-center gap-1 text-[#a78bfa]">— EMA20</span>
        <span className="flex items-center gap-1 text-[#94a3b8]">-- EMA50</span>
        <span className="flex items-center gap-1 text-[rgba(167,139,250,.8)]">— BB20</span>
      </div>

      {/* ohlc tooltip */}
      {hov && (
        <div className="absolute top-7 left-3 panel-inset px-2.5 py-1.5 mono text-[10px] flex gap-3 pointer-events-none">
          <span className="text-[var(--muted)]">{timeLabel(hov.t)}</span>
          <span>O <b>{fmtINR(hov.o)}</b></span>
          <span>H <b className="text-[var(--long)]">{fmtINR(hov.h)}</b></span>
          <span>L <b className="text-[var(--short)]">{fmtINR(hov.l)}</b></span>
          <span>C <b>{fmtINR(hov.c)}</b></span>
          <span className="text-[var(--muted)]">VOL {hov.v.toLocaleString("en-IN")}</span>
        </div>
      )}
    </div>
  );
}

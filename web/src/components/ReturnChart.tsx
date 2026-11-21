import { useEffect, useMemo, useRef, useState } from "react";
import { fmtPct } from "../lib/format";
import { fmtDay, fmtMoney, type ChartPoint } from "../lib/portfolio";
export type { ChartPoint };

interface Props {
  points: ChartPoint[];
  currency: string;
}

const H = 240;
const M = { top: 12, right: 64, bottom: 26 };
/** Approximate width of an 11px tabular label, so the axis never clips. */
const labelWidth = (s: string) => s.length * 6.6;

/** Cumulative return line with a hover readout. Plain SVG, no chart library. */
export default function ReturnChart({ points, currency }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const t = points.map((p) => Date.parse(p.date));
    const t0 = t[0];
    const t1 = t[t.length - 1];
    const vals = points.map((p) => p.ret);
    let lo = Math.min(0, ...vals);
    let hi = Math.max(0, ...vals);
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad;
    hi += pad;
    const step = niceStep((hi - lo) / 4);
    const ticks: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    const dp = step < 1 ? 1 : 0;
    const fmtTick = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(dp)}%`;
    const left = Math.ceil(Math.max(...ticks.map((v) => labelWidth(fmtTick(v))))) + 10;
    const iw = width - left - M.right;
    const ih = H - M.top - M.bottom;
    const x = (ms: number) => left + ((ms - t0) / Math.max(1, t1 - t0)) * iw;
    const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * ih;
    const path = points.map((p, i) => `${i ? "L" : "M"}${x(t[i]).toFixed(1)},${y(p.ret).toFixed(1)}`).join("");
    const xTickCount = Math.max(2, Math.floor(iw / 110));
    const xTicks = Array.from({ length: xTickCount }, (_, i) => t0 + ((t1 - t0) * i) / (xTickCount - 1));
    const span = t1 - t0;
    const fmtX = (ms: number) =>
      new Date(ms).toLocaleDateString(undefined, span < 120 * 864e5 ? { day: "numeric", month: "short", timeZone: "UTC" } : { month: "short", year: "2-digit", timeZone: "UTC" });
    return { t, x, y, path, ticks, xTicks, fmtX, fmtTick, left };
  }, [points, width]);

  if (!geo) return <div ref={wrap} className="chart-empty muted">Not enough history for this range yet.</div>;

  const last = points[points.length - 1];
  const up = last.ret >= 0;
  const h = hover != null ? points[hover] : null;

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const mx = ((e.clientX - box.left) / box.width) * width;
    let best = 0;
    let bd = Infinity;
    geo!.t.forEach((ms, i) => {
      const d = Math.abs(geo!.x(ms) - mx);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const n = points.length;
    const cur = hover ?? n - 1;
    const step = e.shiftKey ? 10 : 1;
    const next =
      e.key === "ArrowLeft" ? Math.max(0, cur - step)
      : e.key === "ArrowRight" ? Math.min(n - 1, cur + step)
      : e.key === "Home" ? 0
      : e.key === "End" ? n - 1
      : e.key === "Escape" ? null
      : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setHover(next);
  }

  const readout = (p: ChartPoint) =>
    `${fmtDay(p.date)}: ${fmtPct(p.ret, true)} return${p.nav != null ? `, account value ${fmtMoney(p.nav, currency)}` : ""}`;

  return (
    <div
      ref={wrap}
      className="chart"
      tabIndex={0}
      role="group"
      aria-label={`Return history from ${fmtDay(points[0].date)} to ${fmtDay(last.date)}, ending at ${fmtPct(last.ret, true)}. Use left and right arrow keys to read each day; Home and End jump to the ends.`}
      onKeyDown={onKey}
      onFocus={() => hover == null && setHover(points.length - 1)}
      onBlur={() => setHover(null)}
    >
      <span className="sr-only" aria-live="polite">{h ? readout(h) : ""}</span>
      <svg width="100%" height={H} viewBox={`0 0 ${width} ${H}`} aria-hidden="true">
        {geo.ticks.map((v) => (
          <g key={v}>
            <line x1={geo.left} x2={width - M.right} y1={geo.y(v)} y2={geo.y(v)} className={v === 0 ? "chart-zero" : "chart-grid"} />
            <text x={geo.left - 8} y={geo.y(v)} dy="0.32em" textAnchor="end" className="chart-tick">{geo.fmtTick(v)}</text>
          </g>
        ))}
        {geo.xTicks.map((ms, i) => (
          <text key={i} x={geo.x(ms)} y={H - 6} textAnchor={i === 0 ? "start" : i === geo.xTicks.length - 1 ? "end" : "middle"} className="chart-tick">
            {geo.fmtX(ms)}
          </text>
        ))}
        <path d={geo.path} className={`chart-line ${up ? "up" : "down"}`} />
        <circle cx={geo.x(geo.t[geo.t.length - 1])} cy={geo.y(last.ret)} r={3.5} className={`chart-dot ${up ? "up" : "down"}`} />
        <text x={geo.x(geo.t[geo.t.length - 1]) + 8} y={geo.y(last.ret)} dy="0.32em" className={`chart-end ${up ? "up" : "down"}`}>{fmtPct(last.ret, true)}</text>
        {h && hover != null && (
          <>
            <line x1={geo.x(geo.t[hover])} x2={geo.x(geo.t[hover])} y1={M.top} y2={H - M.bottom} className="chart-grid" />
            <circle cx={geo.x(geo.t[hover])} cy={geo.y(h.ret)} r={4.5} className={`chart-dot ${up ? "up" : "down"}`} />
          </>
        )}
        <rect x={geo.left} y={M.top} width={width - geo.left - M.right} height={H - M.top - M.bottom} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {h && hover != null && (
        <div
          className="chart-tip"
          style={{ left: Math.min(Math.max(0, (geo.x(geo.t[hover]) / width) * 100), 100) + "%", transform: `translateX(${geo.x(geo.t[hover]) > width / 2 ? "-105%" : "5%"})` }}
        >
          <div className="muted small-text">{fmtDay(h.date)}</div>
          <div className={h.ret >= 0 ? "up" : "down"}><b>{fmtPct(h.ret, true)}</b> return</div>
          {h.nav != null && <div className="muted small-text">Account value {fmtMoney(h.nav, currency)}</div>}
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

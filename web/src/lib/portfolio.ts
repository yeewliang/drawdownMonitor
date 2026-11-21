import type { Portfolio, PortfolioPosition, Quote } from "./types";

export interface HoldingRow {
  p: PortfolioPosition;
  quote: Quote | undefined;
  live: boolean;
  price: number;
  value: number;
  dayPnl: number | null;
  unrealizedPnl: number;
  returnPct: number | null;
}

export interface PortfolioView {
  rows: HoldingRow[];
  value: number;
  snapshotValue: number;
  dayPnl: number | null;
  unrealizedPnl: number;
  costBasis: number;
  livePriced: number;
  drawdownPct: number | null;
  peakDate: string | null;
}

/**
 * Value the portfolio with live quotes. Same rules as the server: a quote is
 * used only if its last trade is newer than the snapshot and in the same
 * currency; otherwise the snapshot price stands.
 */
export function viewPortfolio(pf: Portfolio, quotes: Record<string, Quote>): PortfolioView {
  const synced = pf.syncedAt?.toMillis() ?? 0;
  let value = pf.summary.cash;
  let snapshotValue = pf.summary.cash;
  let dayPnl = 0;
  let hasDay = false;
  let unrealizedPnl = 0;
  let costBasis = 0;
  let livePriced = 0;

  const rows: HoldingRow[] = pf.positions.map((p) => {
    const q = quotes[p.symbol];
    const live = !!q && (q.price ?? 0) > 0 && (q.marketTime?.toMillis() ?? 0) > synced && (!q.currency || q.currency === p.currency);
    const price = live ? q!.price! : p.marketPrice;
    const v = p.quantity * price;
    let d: number | null = p.dailyPnl;
    if (live) {
      livePriced++;
      d = q!.previousClose ? p.quantity * (price - q!.previousClose) : null;
    }
    if (d != null) {
      dayPnl += d;
      hasDay = true;
    }
    const cost = p.quantity * p.avgCost;
    value += v;
    snapshotValue += p.marketValue;
    unrealizedPnl += v - cost;
    costBasis += cost;
    return { p, quote: q, live, price, value: v, dayPnl: d, unrealizedPnl: v - cost, returnPct: cost ? ((v - cost) / cost) * 100 : null };
  });
  rows.sort((a, b) => b.value - a.value);

  const h = pf.history;
  let drawdownPct: number | null = null;
  let peakDate: string | null = null;
  if (h?.dates?.length && snapshotValue > 0) {
    const current = h.index[h.index.length - 1] * (value / snapshotValue);
    let peak = -Infinity;
    h.index.forEach((v, i) => {
      if (v > peak) {
        peak = v;
        peakDate = h.dates[i];
      }
    });
    drawdownPct = current >= peak ? 0 : (1 - current / peak) * 100;
    if (current >= peak) peakDate = null;
  }

  return { rows, value, snapshotValue, dayPnl: hasDay ? dayPnl : null, unrealizedPnl, costBasis, livePriced, drawdownPct, peakDate };
}

export type Range = "1M" | "3M" | "YTD" | "1Y" | "ALL";

export function rangeStart(range: Range, now = new Date()): string | null {
  const d = (days: number) => new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
  switch (range) {
    case "1M": return d(31);
    case "3M": return d(92);
    case "YTD": return `${now.getUTCFullYear() - 1}-12-31`;
    case "1Y": return d(365);
    default: return null;
  }
}

export interface ChartPoint {
  date: string;
  /** Cumulative return since the start of the range, in percent. */
  ret: number;
  nav: number | null;
}

/** Return series rebased to 0% at the start of the range. */
export function rangeSeries(pf: Portfolio, range: Range): ChartPoint[] {
  const h = pf.history;
  if (!h?.dates?.length) return [];
  const start = rangeStart(range);
  let i0 = start ? h.dates.findIndex((d) => d >= start) : 0;
  if (i0 < 0) return [];
  // Include the last point before the range so the line starts at the range boundary.
  if (start && i0 > 0 && h.dates[i0] > start) i0 -= 1;
  const base = h.index[i0];
  return h.dates.slice(i0).map((date, k) => ({ date, ret: (h.index[i0 + k] / base - 1) * 100, nav: h.nav[i0 + k] ?? null }));
}

export function fmtMoney(n: number | null | undefined, currency = "USD", signed = false): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const s = Math.abs(n).toLocaleString(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n < 0) return `-${s}`;
  return signed && n > 0 ? `+${s}` : s;
}

export function fmtQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function fmtDay(iso: string | null): string {
  if (!iso) return "–";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

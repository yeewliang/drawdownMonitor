import type { AthBasis, Portfolio, PortfolioPosition, Quote } from "./types";

export interface HoldingRow {
  p: PortfolioPosition;
  quote: Quote | undefined;
  live: boolean;
  /** Price in the holding's currency. */
  price: number;
  /** Value in the holding's currency. */
  valueNative: number;
  /** Value in base currency. */
  value: number;
  dayPnl: number | null;
  unrealizedPnl: number;
  returnPct: number | null;
  /** Drawdown of `price` from the quote's ATH; null if the quote is in another currency. */
  athDrawdown: number | null;
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
  /** Peak date in history, "live" for a peak seen since the last sync, null when at the peak. */
  peakDate: string | null;
}

const DERIVATIVE_CLASSES = new Set(["OPT", "FOP", "FUT", "WAR", "IOPT", "CFD"]);
/** Options, futures and warrants cannot be priced from Yahoo; they keep the broker's value from the last sync. */
const livePriceable = (p: PortfolioPosition) => (p.multiplier || 1) === 1 && !DERIVATIVE_CLASSES.has((p.assetClass ?? "").toUpperCase());

const fxSymbol = (cur: string, base: string) => `${cur}${base}=X`;
const isPos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Same rule as the server: newer than the snapshot, priced, and in exactly this currency ("GBp" is not "GBP"). */
function usable(q: Quote | undefined, synced: number, currency: string): q is Quote & { price: number } {
  return !!q && isPos(q.price) && (q.marketTime?.toMillis() ?? 0) > synced && (!q.currency || q.currency === currency);
}

/**
 * Value the portfolio in base currency with live quotes, mirroring
 * functions/src/lib/portfolio.ts: at sync each holding keeps the broker's own
 * value (multipliers included); live, quantity x price x multiplier; other
 * currencies are converted with live FX when newer, else the rate at sync.
 */
export function viewPortfolio(pf: Portfolio, quotes: Record<string, Quote>, basis: AthBasis): PortfolioView {
  const synced = pf.syncedAt?.toMillis() ?? 0;
  const base = pf.baseCurrency || "USD";
  let value = pf.summary.cash;
  let snapshotValue = pf.summary.cash;
  let dayPnl = 0;
  let hasDay = false;
  let unrealizedPnl = 0;
  let costBasis = 0;
  let livePriced = 0;

  const rows: HoldingRow[] = pf.positions.map((p) => {
    const fxStored = p.fxToBase || 1;
    let fx = fxStored;
    if (p.currency !== base) {
      const fq = quotes[fxSymbol(p.currency, base)];
      if (usable(fq, synced, base)) fx = fq.price;
    }
    const q = quotes[p.symbol];
    const live = livePriceable(p) && usable(q, synced, p.currency);
    const mult = p.multiplier || 1;
    const price = live ? q.price : p.marketPrice;
    const valueNative = live ? p.quantity * price * mult : p.marketValue;
    const costNative = p.marketValue - p.unrealizedPnl;
    const unrNative = valueNative - costNative;
    let d: number | null = null;
    if (live) {
      if (isPos(q.previousClose)) d = p.quantity * (price - q.previousClose) * mult * fx;
      livePriced++;
    } else if (p.dailyPnl != null) {
      d = p.dailyPnl * fx;
    }
    if (d != null) {
      dayPnl += d;
      hasDay = true;
    }
    value += valueNative * fx;
    snapshotValue += p.marketValue * fxStored;
    unrealizedPnl += unrNative * fx;
    costBasis += costNative * fx;

    const ath = q ? (basis === "intraday" ? q.athIntraday : q.athClose) : null;
    const athDrawdown = livePriceable(p) && isPos(ath) && isPos(price) && (!q?.currency || q.currency === p.currency) ? (1 - price / Math.max(ath, price)) * 100 : null;
    return {
      p,
      quote: q,
      live,
      price,
      valueNative,
      value: valueNative * fx,
      dayPnl: d,
      unrealizedPnl: unrNative * fx,
      returnPct: costNative ? (unrNative / Math.abs(costNative)) * 100 : null,
      athDrawdown,
    };
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
    if (pf.livePeak && pf.livePeak.index > peak) {
      peak = pf.livePeak.index;
      peakDate = "live";
    }
    if (current >= peak) {
      drawdownPct = 0;
      peakDate = null;
    } else {
      drawdownPct = (1 - current / peak) * 100;
    }
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

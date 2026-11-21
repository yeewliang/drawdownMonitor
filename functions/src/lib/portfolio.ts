/**
 * Pure portfolio logic: snapshot normalisation, the time-weighted return
 * index, live valuation and drawdown from peak. No Firebase imports, so it can
 * be unit tested in isolation.
 */

export interface PortfolioSummary {
  netLiquidation: number;
  cash: number;
  buyingPower: number | null;
  availableFunds: number | null;
  excessLiquidity: number | null;
  initialMargin: number | null;
  maintenanceMargin: number | null;
  leverage: number | null;
}

export interface PortfolioPosition {
  /** Yahoo Finance symbol used for live prices and ATH. */
  symbol: string;
  /** Symbol as the broker shows it. */
  brokerSymbol: string;
  contractId: number | null;
  quantity: number;
  /** Broker's average price, as reported (per share or per contract). */
  avgCost: number;
  marketPrice: number;
  /** Broker's market value at sync, in the position's currency. */
  marketValue: number;
  unrealizedPnl: number;
  dailyPnl: number | null;
  /** Position currency. Values above are in it. */
  currency: string;
  assetClass: string | null;
  /** Value per unit of price per unit of quantity: 100 for a US option, 1 for a share. Derived from the broker's value. */
  multiplier: number;
  /** Units of base currency per unit of `currency` at sync (1 when they match). */
  fxToBase: number;
}

/**
 * Time-weighted return index: 1.0 at the first date, and each later value is
 * growth since then with deposits and withdrawals removed. `nav` is the
 * account value on the same date (affected by cash flows).
 */
export interface ReturnHistory {
  dates: string[];
  index: number[];
  nav: (number | null)[];
}

/** Highest live return index seen between snapshots, on the same scale as the history. */
export interface LivePeak {
  index: number;
  /** ISO time it was seen. */
  at: string;
}

/** One performance period as IBKR PortfolioAnalyst returns it. */
export interface PerformancePeriodInput {
  start_date?: string;
  start_nav?: number;
  dates: string[];
  cps: number[];
  nav?: number[];
}

export interface LiveQuote {
  price: number | null | undefined;
  previousClose?: number | null;
  currency?: string;
  /** Epoch ms of the last trade. */
  marketTimeMs: number;
}

export interface HoldingValue {
  symbol: string;
  /** True when priced from a live quote newer than the snapshot. */
  live: boolean;
  /** Price in the position's currency. */
  price: number;
  /** Value in the position's currency. */
  valueNative: number;
  /** Value in base currency. */
  value: number;
  /** Day P&L in base currency. */
  dayPnl: number | null;
  /** Unrealized P&L in base currency. */
  unrealizedPnl: number;
  /** Unrealized return on cost, in percent. */
  returnPct: number | null;
  /** Rate used to convert to base. */
  fx: number;
}

export interface PortfolioValuation {
  holdings: HoldingValue[];
  /** Value in base currency, from live quotes where newer than the snapshot, else snapshot prices. */
  value: number;
  /** Value at snapshot prices and FX, in base currency. */
  snapshotValue: number;
  /** Positions priced from a live quote. */
  livePriced: number;
  dayPnl: number | null;
  unrealizedPnl: number;
  costBasis: number;
}

// ---------------------------------------------------------------------------
// Snapshot input (IBKR field names, as returned by the IBKR connector)
// ---------------------------------------------------------------------------

export interface IbkrSummaryInput {
  net_liquidation: number;
  total_cash_value: number;
  buying_power?: number | null;
  available_funds?: number | null;
  excess_liquidity?: number | null;
  initial_margin?: number | null;
  maintenance_margin?: number | null;
  leverage?: number | string | null;
  currency?: string;
}

export interface IbkrPositionInput {
  contract_description: string;
  contract_id?: number | null;
  position: number;
  market_price: number;
  market_value: number;
  average_price: number;
  unrealized_pnl: number;
  daily_pnl?: number | null;
  currency?: string;
  asset_class?: string | null;
  /** Yahoo symbol when it differs from the IBKR one, e.g. CNDX.L for CNDX on LSE. */
  yahoo_symbol?: string | null;
}

export function normalizeSummary(s: IbkrSummaryInput): PortfolioSummary {
  return {
    netLiquidation: num(s.net_liquidation) ?? 0,
    cash: num(s.total_cash_value) ?? 0,
    buyingPower: num(s.buying_power),
    availableFunds: num(s.available_funds),
    excessLiquidity: num(s.excess_liquidity),
    initialMargin: num(s.initial_margin),
    maintenanceMargin: num(s.maintenance_margin),
    leverage: num(s.leverage),
  };
}

/** Yahoo FX symbol giving units of `base` per unit of `cur`, e.g. GBPUSD=X. */
export const fxSymbol = (cur: string, base: string) => `${cur.toUpperCase()}${base.toUpperCase()}=X`;

/**
 * Value per unit of price per unit of quantity, from the broker's own value
 * (100 for a US equity option). Near-integers are snapped to remove rounding.
 */
export function inferMultiplier(quantity: number, price: number, marketValue: number): number {
  const base = Math.abs(quantity * price);
  const mv = Math.abs(marketValue);
  if (!(base > 0) || !(mv > 0)) return 1;
  const m = mv / base;
  const r = Math.round(m);
  return r >= 1 && Math.abs(m - r) / r < 0.01 ? r : m;
}

export function normalizePositions(
  positions: IbkrPositionInput[],
  toSymbol: (raw: string) => string | null,
  fxToBase: (currency: string) => number = () => 1,
): { positions: PortfolioPosition[]; rejected: string[] } {
  const out: PortfolioPosition[] = [];
  const rejected: string[] = [];
  for (const p of positions) {
    const symbol = toSymbol(p.yahoo_symbol || p.contract_description);
    if (!symbol || !num(p.position)) {
      rejected.push(p.contract_description);
      continue;
    }
    const marketPrice = num(p.market_price) ?? 0;
    const marketValue = num(p.market_value) ?? 0;
    const currency = (p.currency || "USD").toUpperCase();
    out.push({
      symbol,
      brokerSymbol: p.contract_description,
      contractId: num(p.contract_id),
      quantity: p.position,
      avgCost: num(p.average_price) ?? 0,
      marketPrice,
      marketValue,
      unrealizedPnl: num(p.unrealized_pnl) ?? 0,
      dailyPnl: num(p.daily_pnl),
      currency,
      assetClass: p.asset_class ?? null,
      multiplier: inferMultiplier(p.position, marketPrice, marketValue),
      fxToBase: fxToBase(currency),
    });
  }
  out.sort((a, b) => b.marketValue * b.fxToBase - a.marketValue * a.fxToBase);
  return { positions: out, rejected };
}

/** "20261120" or "2026-11-20" to "2026-11-20". */
export function isoDay(raw: string): string | null {
  const s = String(raw).trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Build a return index from IBKR performance periods. Uses the period with
 * the longest span (normally 1Y), with its start date as index 1.0.
 */
export function historyFromPeriods(periods: Record<string, PerformancePeriodInput>): ReturnHistory {
  let best: ReturnHistory = { dates: [], index: [], nav: [] };
  for (const p of Object.values(periods)) {
    const h = historyFromPeriod(p);
    if (h.dates.length && (!best.dates.length || h.dates[0] < best.dates[0] || (h.dates[0] === best.dates[0] && h.dates.length > best.dates.length))) {
      best = h;
    }
  }
  return best;
}

function historyFromPeriod(p: PerformancePeriodInput): ReturnHistory {
  const byDate = new Map<string, { index: number; nav: number | null }>();
  const start = p.start_date ? isoDay(p.start_date) : null;
  if (start) byDate.set(start, { index: 1, nav: num(p.start_nav) || null });
  (p.dates ?? []).forEach((d, i) => {
    const day = isoDay(d);
    const cps = num(p.cps?.[i]);
    if (!day || cps == null || cps <= -1) return;
    byDate.set(day, { index: 1 + cps, nav: num(p.nav?.[i]) });
  });
  const dates = [...byDate.keys()].sort();
  return { dates, index: dates.map((d) => byDate.get(d)!.index), nav: dates.map((d) => byDate.get(d)!.nav) };
}

export interface MergeResult {
  history: ReturnHistory;
  /** "chained" keeps the stored scale; "replaced" starts a new scale (no overlap). */
  mode: "chained" | "replaced";
}

/**
 * Append `incoming` to `stored`, rescaling it to join at the earliest date the
 * two share, so history keeps growing past IBKR's one-year window. Where they
 * overlap the newer IBKR numbers win. With no overlap the incoming series
 * replaces the stored one (a gap would make the chained return wrong).
 * Returns null when `incoming` ends before `stored` does: it is stale, and
 * merging it would drop newer stored points.
 */
export function mergeHistory(stored: ReturnHistory | null | undefined, incoming: ReturnHistory, maxPoints = 4000): MergeResult | null {
  if (!incoming.dates.length) return null;
  if (!stored || !stored.dates.length) return { history: trim(incoming, maxPoints), mode: "replaced" };
  if (incoming.dates[incoming.dates.length - 1] < stored.dates[stored.dates.length - 1]) return null;
  const storedIdx = new Map(stored.dates.map((d, i) => [d, i]));
  const join = incoming.dates.findIndex((d) => storedIdx.has(d));
  if (join < 0) return { history: trim(incoming, maxPoints), mode: "replaced" };
  const at = storedIdx.get(incoming.dates[join])!;
  const scale = stored.index[at] / incoming.index[join];
  const out: ReturnHistory = {
    dates: stored.dates.slice(0, at),
    index: stored.index.slice(0, at),
    nav: stored.nav.slice(0, at),
  };
  for (let i = join; i < incoming.dates.length; i++) {
    out.dates.push(incoming.dates[i]);
    out.index.push(round(incoming.index[i] * scale, 8));
    out.nav.push(incoming.nav[i]);
  }
  return { history: trim(out, maxPoints), mode: "chained" };
}

function trim(h: ReturnHistory, max: number): ReturnHistory {
  if (h.dates.length <= max) return h;
  const k = h.dates.length - max;
  return { dates: h.dates.slice(k), index: h.index.slice(k), nav: h.nav.slice(k) };
}

/**
 * A quote counts as live only if it is newer than the snapshot, priced, and in
 * the expected currency. The comparison is exact: Yahoo's "GBp" (pence) is
 * not "GBP".
 */
export function usableQuote(q: LiveQuote | undefined, syncedAtMs: number, currency: string): q is LiveQuote & { price: number } {
  return !!q && isPos(q.price) && q.marketTimeMs > syncedAtMs && (!q.currency || q.currency === currency);
}

const DERIVATIVE_CLASSES = new Set(["OPT", "FOP", "FUT", "WAR", "IOPT", "CFD"]);

/**
 * Whether a holding can be priced from a Yahoo quote at all. Derivatives
 * (options, futures, warrants) cannot: Yahoo quotes for their symbol would be
 * the underlying, so they keep the broker's value from the last sync.
 */
export function livePriceable(p: Pick<PortfolioPosition, "assetClass" | "multiplier">): boolean {
  return (p.multiplier || 1) === 1 && !DERIVATIVE_CLASSES.has((p.assetClass ?? "").toUpperCase());
}

/**
 * Value the portfolio in base currency. Each holding uses a live quote only
 * when `usableQuote` allows it, otherwise the broker's own value at sync
 * (which already includes any contract multiplier). Live FX quotes are used
 * the same way, else the rate stored at sync.
 */
export function valuePortfolio(
  positions: PortfolioPosition[],
  cash: number,
  baseCurrency: string,
  syncedAtMs: number,
  quotes: Record<string, LiveQuote | undefined>,
): PortfolioValuation {
  let value = cash;
  let snapshotValue = cash;
  let livePriced = 0;
  let dayPnl = 0;
  let hasDay = false;
  let unrealizedPnl = 0;
  let costBasis = 0;
  const holdings: HoldingValue[] = [];

  for (const p of positions) {
    const fxStored = p.fxToBase || 1;
    let fx = fxStored;
    if (p.currency !== baseCurrency) {
      const fq = quotes[fxSymbol(p.currency, baseCurrency)];
      if (usableQuote(fq, syncedAtMs, baseCurrency)) fx = fq.price;
    }
    const q = quotes[p.symbol];
    const live = livePriceable(p) && usableQuote(q, syncedAtMs, p.currency);
    const mult = p.multiplier || 1;
    const price = live ? q.price : p.marketPrice;
    const valueNative = live ? p.quantity * price * mult : p.marketValue;
    // Cost from the broker's own figures, so it is right whatever unit avgCost is in.
    const costNative = p.marketValue - p.unrealizedPnl;
    const unrNative = valueNative - costNative;

    let day: number | null = null;
    if (live) {
      if (isPos(q.previousClose)) day = p.quantity * (price - (q.previousClose as number)) * mult * fx;
    } else if (p.dailyPnl != null) {
      day = p.dailyPnl * fx;
    }
    if (day != null) {
      dayPnl += day;
      hasDay = true;
    }
    if (live) livePriced++;

    const v = valueNative * fx;
    value += v;
    snapshotValue += p.marketValue * fxStored;
    unrealizedPnl += unrNative * fx;
    costBasis += costNative * fx;
    holdings.push({
      symbol: p.symbol,
      live,
      price,
      valueNative: round(valueNative, 2),
      value: round(v, 2),
      dayPnl: day == null ? null : round(day, 2),
      unrealizedPnl: round(unrNative * fx, 2),
      returnPct: costNative ? round((unrNative / Math.abs(costNative)) * 100, 4) : null,
      fx,
    });
  }
  return {
    holdings,
    value: round(value, 2),
    snapshotValue: round(snapshotValue, 2),
    livePriced,
    dayPnl: hasDay ? round(dayPnl, 2) : null,
    unrealizedPnl: round(unrealizedPnl, 2),
    costBasis: round(costBasis, 2),
  };
}

/** Drawdown of a holding's chosen price from its ATH, or null if the quote is in another currency. */
export function holdingDrawdown(price: number, ath: number | null | undefined, quoteCurrency: string | undefined, currency: string): number | null {
  if (!isPos(price) || !isPos(ath)) return null;
  if (quoteCurrency && quoteCurrency !== currency) return null;
  return round((1 - price / Math.max(ath as number, price)) * 100, 4);
}

export interface PortfolioDrawdown {
  /** Positive percent below the peak of the return index (0 = at the peak). */
  drawdownPct: number;
  /** Date of the peak in history, "live" if the peak was seen between snapshots, null if at the peak now. */
  peakDate: string | null;
  /** Live index: last stored index moved by the change in value since the snapshot. */
  currentIndex: number;
  /** The peak index, history and live combined. */
  peakIndex: number;
}

/**
 * Drawdown of the time-weighted return index from its peak. The live index
 * scales the last stored point by value / snapshotValue, which is valid
 * because no cash flows happen between a snapshot and a live quote. The
 * peak includes `livePeak`, the highest live index seen since, so a rise
 * and fall between snapshots is still measured.
 */
export function portfolioDrawdown(h: ReturnHistory, value: number, snapshotValue: number, livePeak?: LivePeak | null): PortfolioDrawdown | null {
  if (!h.dates.length || !(snapshotValue > 0)) return null;
  const current = h.index[h.index.length - 1] * (value / snapshotValue);
  let peak = -Infinity;
  let peakDate: string | null = null;
  h.index.forEach((v, i) => {
    if (v > peak) {
      peak = v;
      peakDate = h.dates[i];
    }
  });
  if (livePeak && livePeak.index > peak) {
    peak = livePeak.index;
    peakDate = "live";
  }
  if (current >= peak) return { drawdownPct: 0, peakDate: null, currentIndex: round(current, 8), peakIndex: round(current, 8) };
  return { drawdownPct: round((1 - current / peak) * 100, 4), peakDate, currentIndex: round(current, 8), peakIndex: round(peak, 8) };
}

/**
 * Index of the first point of a window starting at `fromDate`: the point on
 * that date, or else the last one before it, so the first day's move counts.
 */
export function windowStart(dates: string[], fromDate: string): number {
  const i = dates.findIndex((d) => d >= fromDate);
  if (i < 0) return -1;
  return dates[i] > fromDate && i > 0 ? i - 1 : i;
}

/** Return over the window starting at `fromDate`, in percent. */
export function returnSince(h: ReturnHistory, fromDate: string): number | null {
  const i = windowStart(h.dates, fromDate);
  if (i < 0 || i === h.dates.length - 1) return null;
  return round((h.index[h.index.length - 1] / h.index[i] - 1) * 100, 4);
}

// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function isPos(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

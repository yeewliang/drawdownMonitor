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
  avgCost: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  dailyPnl: number | null;
  currency: string;
  assetClass: string | null;
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

/** One performance period as IBKR PortfolioAnalyst returns it. */
export interface PerformancePeriodInput {
  start_date?: string;
  start_nav?: number;
  dates: string[];
  cps: number[];
  nav?: number[];
}

export interface PortfolioValuation {
  /** Value from live quotes where newer than the snapshot, else snapshot prices. */
  value: number;
  /** Value at snapshot prices. */
  snapshotValue: number;
  /** Positions priced from a live quote. */
  livePriced: number;
  /** Sum of quantity x (price - previous close) for live-priced positions; snapshot daily P&L otherwise. */
  dayPnl: number | null;
  unrealizedPnl: number;
  costBasis: number;
}

export interface LiveQuote {
  price: number | null | undefined;
  previousClose?: number | null;
  currency?: string;
  /** Epoch ms of the last trade. */
  marketTimeMs: number;
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

export function normalizePositions(
  positions: IbkrPositionInput[],
  toSymbol: (raw: string) => string | null,
): { positions: PortfolioPosition[]; rejected: string[] } {
  const out: PortfolioPosition[] = [];
  const rejected: string[] = [];
  for (const p of positions) {
    const symbol = toSymbol(p.yahoo_symbol || p.contract_description);
    if (!symbol || !num(p.position)) {
      rejected.push(p.contract_description);
      continue;
    }
    out.push({
      symbol,
      brokerSymbol: p.contract_description,
      contractId: num(p.contract_id),
      quantity: p.position,
      avgCost: num(p.average_price) ?? 0,
      marketPrice: num(p.market_price) ?? 0,
      marketValue: num(p.market_value) ?? 0,
      unrealizedPnl: num(p.unrealized_pnl) ?? 0,
      dailyPnl: num(p.daily_pnl),
      currency: p.currency || "USD",
      assetClass: p.asset_class ?? null,
    });
  }
  out.sort((a, b) => b.marketValue - a.marketValue);
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

/**
 * Append `incoming` to `stored`, rescaling it to join at the latest date the
 * two share, so history keeps growing past IBKR's one-year window. Dates in
 * `incoming` on or after the join point replace the stored ones. With no
 * overlap the incoming series replaces the stored one (a gap would make the
 * chained return wrong).
 */
export function mergeHistory(stored: ReturnHistory | null | undefined, incoming: ReturnHistory, maxPoints = 4000): ReturnHistory {
  if (!stored || !stored.dates.length) return trim(incoming, maxPoints);
  if (!incoming.dates.length) return stored;
  const storedIdx = new Map(stored.dates.map((d, i) => [d, i]));
  let join = -1;
  for (let i = incoming.dates.length - 1; i >= 0; i--) {
    if (storedIdx.has(incoming.dates[i]) && incoming.dates[i] <= stored.dates[stored.dates.length - 1]) {
      // Prefer the earliest shared date, so the newest IBKR numbers win where they overlap.
      join = i;
    }
  }
  if (join < 0) return trim(incoming, maxPoints);
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
  return trim(out, maxPoints);
}

function trim(h: ReturnHistory, max: number): ReturnHistory {
  if (h.dates.length <= max) return h;
  const k = h.dates.length - max;
  return { dates: h.dates.slice(k), index: h.index.slice(k), nav: h.nav.slice(k) };
}

/**
 * Value the portfolio with live quotes. A quote is used only when its last
 * trade is newer than the snapshot and in the position's currency; otherwise
 * the snapshot price stands (e.g. a weekend sync after Friday's close).
 */
export function valuePortfolio(
  positions: PortfolioPosition[],
  cash: number,
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
  for (const p of positions) {
    const q = quotes[p.symbol];
    const live = !!q && isPos(q.price) && q.marketTimeMs > syncedAtMs && (!q.currency || q.currency === p.currency);
    const price = live ? (q!.price as number) : p.marketPrice;
    const mv = p.quantity * price;
    value += mv;
    snapshotValue += p.marketValue;
    costBasis += p.quantity * p.avgCost;
    unrealizedPnl += mv - p.quantity * p.avgCost;
    if (live) {
      livePriced++;
      if (isPos(q!.previousClose)) {
        dayPnl += p.quantity * (price - (q!.previousClose as number));
        hasDay = true;
      }
    } else if (p.dailyPnl != null) {
      dayPnl += p.dailyPnl;
      hasDay = true;
    }
  }
  return {
    value: round(value, 2),
    snapshotValue: round(snapshotValue, 2),
    livePriced,
    dayPnl: hasDay ? round(dayPnl, 2) : null,
    unrealizedPnl: round(unrealizedPnl, 2),
    costBasis: round(costBasis, 2),
  };
}

export interface PortfolioDrawdown {
  /** Positive percent below the peak of the return index (0 = at the peak). */
  drawdownPct: number;
  peakDate: string | null;
  /** Live index: last stored index moved by the change in value since the snapshot. */
  currentIndex: number;
}

/**
 * Drawdown of the time-weighted return index from its peak. The live index
 * scales the last stored point by value / snapshotValue, which is valid
 * because no cash flows happen between a snapshot and a live quote.
 */
export function portfolioDrawdown(h: ReturnHistory, value: number, snapshotValue: number): PortfolioDrawdown | null {
  if (!h.dates.length || !(snapshotValue > 0)) return null;
  const last = h.index[h.index.length - 1];
  const current = last * (value / snapshotValue);
  let peak = -Infinity;
  let peakDate: string | null = null;
  h.index.forEach((v, i) => {
    if (v > peak) {
      peak = v;
      peakDate = h.dates[i];
    }
  });
  if (current >= peak) return { drawdownPct: 0, peakDate: "live", currentIndex: round(current, 8) };
  return { drawdownPct: round((1 - current / peak) * 100, 4), peakDate, currentIndex: round(current, 8) };
}

/** Return over the window starting at `fromDate` (inclusive), in percent. */
export function returnSince(h: ReturnHistory, fromDate: string): number | null {
  const i = h.dates.findIndex((d) => d >= fromDate);
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

/**
 * Yahoo Finance chart API client.
 *
 * The v8 chart endpoint needs no API key, covers equities, ETFs, indexes
 * (e.g. ^GSPC, ^IXIC, ^N225), FX and crypto, and returns real-time prices for
 * US markets (most other exchanges are delayed up to 15-20 minutes).
 * It is unofficial, so everything goes through the PriceProvider interface
 * and can be swapped for a paid vendor without touching the rest of the code.
 */
import { athFromBars, AthState, Bar } from "../lib/drawdown";
import { PriceProvider, ProviderQuote, SymbolMatch } from "./types";

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; DrawdownMonitor/1.0)",
  Accept: "application/json",
};
const TIMEOUT_MS = 15_000;

const SEARCHABLE_TYPES = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CRYPTOCURRENCY", "CURRENCY", "FUTURE"]);

export class SymbolNotFoundError extends Error {}

interface ChartMeta {
  symbol: string;
  currency?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  longName?: string;
  shortName?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  regularMarketDayHigh?: number;
  previousClose?: number;
  exchangeTimezoneName?: string;
  currentTradingPeriod?: { regular?: { start: number; end: number } };
}

interface ChartResult {
  meta: ChartMeta;
  timestamp?: number[];
  indicators?: { quote?: Array<{ high?: (number | null)[]; close?: (number | null)[] }> };
}

export class YahooProvider implements PriceProvider {
  readonly name = "yahoo";

  async getQuote(symbol: string, opts: { fullHistory: boolean }): Promise<ProviderQuote> {
    const params = opts.fullHistory
      ? `period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d`
      : "range=5d&interval=1d";
    const url = `${CHART_URL}${encodeURIComponent(symbol)}?${params}&includePrePost=false`;
    const json = await getJson(url);
    const result: ChartResult | undefined = json?.chart?.result?.[0];
    if (!result) {
      const desc = json?.chart?.error?.description ?? "no data";
      throw new SymbolNotFoundError(`${symbol}: ${desc}`);
    }
    return parseChart(result);
  }

  async search(query: string): Promise<SymbolMatch[]> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`;
    const json = await getJson(url);
    const quotes: any[] = Array.isArray(json?.quotes) ? json.quotes : [];
    return quotes
      .filter((q) => typeof q.symbol === "string" && SEARCHABLE_TYPES.has(q.quoteType))
      .map((q) => ({
        symbol: q.symbol,
        name: q.longname ?? q.shortname ?? q.symbol,
        type: q.typeDisp ?? q.quoteType,
        exchange: q.exchDisp ?? q.exchange ?? "",
      }));
  }
}

/** Exported for tests. */
export function parseChart(result: ChartResult): ProviderQuote {
  const m = result.meta;
  const price = m.regularMarketPrice;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    throw new SymbolNotFoundError(`${m.symbol}: no market price`);
  }

  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const bars: Bar[] = ts.map((time, i) => ({
    time,
    high: q.high?.[i] ?? null,
    close: q.close?.[i] ?? null,
  }));

  // While a session is open, the last daily bar's "close" is just the live
  // price, so exclude it from the closing high until the session ends.
  const regular = m.currentTradingPeriod?.regular;
  const marketTime = m.regularMarketTime ?? 0;
  const sessionOpen = !!regular && marketTime >= regular.start && marketTime < regular.end;
  const completedBefore = sessionOpen ? regular!.start : Infinity;

  const ath: AthState = athFromBars(bars, completedBefore);
  // Fold the live day high / price into the intraday high.
  const liveHigh = Math.max(m.regularMarketDayHigh ?? 0, price);
  if (!ath.intraday || liveHigh > ath.intraday.value) {
    ath.intraday = { value: liveHigh, time: marketTime };
  }

  return {
    symbol: m.symbol,
    name: m.longName ?? m.shortName ?? m.symbol,
    currency: m.currency ?? "",
    exchange: m.fullExchangeName ?? m.exchangeName ?? "",
    instrumentType: m.instrumentType ?? "",
    timezone: m.exchangeTimezoneName ?? "",
    price,
    previousClose: previousSessionClose(bars) ?? m.previousClose ?? null,
    marketTime,
    sessionOpen,
    ath,
  };
}

/**
 * Close of the session before the latest bar. Yahoo's `chartPreviousClose`
 * is the close before the whole requested range, so it is not usable here.
 */
function previousSessionClose(bars: Bar[]): number | null {
  for (let i = bars.length - 2; i >= 0; i--) {
    const c = bars[i].close;
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  // Yahoo returns 404 with a JSON body for unknown symbols.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Yahoo HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

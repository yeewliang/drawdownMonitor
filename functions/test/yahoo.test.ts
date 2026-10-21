import { describe, expect, it } from "vitest";
import { parseChart } from "../src/providers/yahoo";

const base = {
  meta: {
    symbol: "^GSPC",
    currency: "USD",
    fullExchangeName: "SNP",
    instrumentType: "INDEX",
    longName: "S&P 500",
    regularMarketPrice: 95,
    regularMarketDayHigh: 96,
    regularMarketTime: 1_000_500,
    chartPreviousClose: 12,
    currentTradingPeriod: { regular: { start: 1_000_000, end: 1_023_400 } },
  },
  timestamp: [900_000, 950_000, 1_000_000],
  indicators: { quote: [{ high: [100, 99, 96], close: [98, 99.5, 95] }] },
};

describe("parseChart", () => {
  it("excludes the live session from the closing high", () => {
    const q = parseChart(structuredClone(base));
    expect(q.sessionOpen).toBe(true);
    expect(q.ath.close).toEqual({ value: 99.5, time: 950_000 });
    expect(q.ath.intraday).toEqual({ value: 100, time: 900_000 });
    expect(q.name).toBe("S&P 500");
    // Previous session close, not the chart-range previous close.
    expect(q.previousClose).toBe(99.5);
  });

  it("includes today's bar once the session has closed", () => {
    const c = structuredClone(base);
    c.meta.regularMarketTime = 1_023_400;
    c.indicators.quote[0].close[2] = 101;
    const q = parseChart(c);
    expect(q.sessionOpen).toBe(false);
    expect(q.ath.close?.value).toBe(101);
  });

  it("folds the live day high into the intraday ATH", () => {
    const c = structuredClone(base);
    c.meta.regularMarketDayHigh = 105;
    expect(parseChart(c).ath.intraday).toEqual({ value: 105, time: 1_000_500 });
  });

  it("throws when there is no price", () => {
    const c: any = structuredClone(base);
    delete c.meta.regularMarketPrice;
    expect(() => parseChart(c)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  fxSymbol,
  historyFromPeriods,
  holdingDrawdown,
  inferMultiplier,
  isoDay,
  mergeHistory,
  normalizePositions,
  portfolioDrawdown,
  PortfolioPosition,
  returnSince,
  valuePortfolio,
} from "../src/lib/portfolio";
import { normalizeSymbol } from "../src/lib/symbols";

const pos = (o: Partial<PortfolioPosition>): PortfolioPosition => ({
  symbol: "QQQ",
  brokerSymbol: "QQQ",
  contractId: 1,
  quantity: 2,
  avgCost: 100,
  marketPrice: 110,
  marketValue: 220,
  unrealizedPnl: 20,
  dailyPnl: -5,
  currency: "USD",
  assetClass: "STK",
  multiplier: 1,
  fxToBase: 1,
  ...o,
});

describe("isoDay", () => {
  it("accepts IBKR and ISO dates", () => {
    expect(isoDay("20261120")).toBe("2026-11-20");
    expect(isoDay("2026-11-20")).toBe("2026-11-20");
    expect(isoDay("Nov 20")).toBeNull();
  });
});

describe("normalizePositions", () => {
  it("uses yahoo_symbol when given and rejects zero quantities", () => {
    const { positions, rejected } = normalizePositions(
      [
        { contract_description: "QQQ", position: 1, market_price: 600, market_value: 600, average_price: 500, unrealized_pnl: 100 },
        { contract_description: "CNDX", yahoo_symbol: "cndx.l", position: 2, market_price: 1500, market_value: 3000, average_price: 1400, unrealized_pnl: 200 },
        { contract_description: "OLD", position: 0, market_price: 1, market_value: 0, average_price: 1, unrealized_pnl: 0 },
      ],
      normalizeSymbol,
    );
    expect(positions.map((p) => p.symbol)).toEqual(["CNDX.L", "QQQ"]); // sorted by value
    expect(rejected).toEqual(["OLD"]);
  });

  it("derives option multipliers and stores FX for other currencies", () => {
    const { positions } = normalizePositions(
      [
        { contract_description: "AAPL 250117C200", position: 1, market_price: 5, market_value: 500, average_price: 400, unrealized_pnl: 100, currency: "USD" },
        { contract_description: "VOD", yahoo_symbol: "VOD.L", position: 10, market_price: 1, market_value: 10, average_price: 1, unrealized_pnl: 0, currency: "GBP" },
      ],
      (s) => s.replace(/\s.*/, ""),
      (cur) => (cur === "GBP" ? 1.25 : 1),
    );
    expect(positions.find((p) => p.symbol === "AAPL")!.multiplier).toBe(100);
    expect(positions.find((p) => p.symbol === "VOD.L")!.fxToBase).toBe(1.25);
  });
});

describe("inferMultiplier", () => {
  it("is 1 for shares and snaps near-integers", () => {
    expect(inferMultiplier(5.4855, 617.72, 3388.50289927)).toBe(1);
    expect(inferMultiplier(-2, 3.1, -620.4)).toBe(100);
    expect(inferMultiplier(0, 1, 1)).toBe(1);
  });
});

describe("historyFromPeriods", () => {
  it("picks the longest period and adds its start as 1.0", () => {
    const h = historyFromPeriods({
      "1M": { start_date: "20261019", dates: ["20261020"], cps: [0.01] },
      "1Y": { start_date: "20251119", start_nav: 800, dates: ["20251120", "20261120"], cps: [-0.02, 0.06], nav: [820, 4190] },
    });
    expect(h.dates).toEqual(["2025-11-19", "2025-11-20", "2026-11-20"]);
    expect(h.index).toEqual([1, 0.98, 1.06]);
    expect(h.nav).toEqual([800, 820, 4190]);
  });
});

describe("mergeHistory", () => {
  it("chains a newer series onto the stored one at the first shared date", () => {
    const stored = { dates: ["2025-01-01", "2025-06-01", "2025-12-01"], index: [1, 1.2, 1.1], nav: [1, 2, 3] };
    const incoming = { dates: ["2025-06-01", "2025-12-01", "2026-06-01"], index: [1, 0.9, 1.08], nav: [2, 3, 4] };
    const m = mergeHistory(stored, incoming)!;
    expect(m.mode).toBe("chained");
    expect(m.history.dates).toEqual(["2025-01-01", "2025-06-01", "2025-12-01", "2026-06-01"]);
    expect(m.history.index[1]).toBeCloseTo(1.2);
    expect(m.history.index[2]).toBeCloseTo(1.08);
    expect(m.history.index[3]).toBeCloseTo(1.296);
  });

  it("replaces the stored series when there is no overlap", () => {
    const stored = { dates: ["2020-01-01"], index: [1], nav: [1] };
    const incoming = { dates: ["2026-01-01", "2026-02-01"], index: [1, 1.1], nav: [5, 6] };
    expect(mergeHistory(stored, incoming)).toEqual({ history: incoming, mode: "replaced" });
  });

  it("rejects an incoming series that ends before the stored one", () => {
    const stored = { dates: ["2026-01-01", "2026-02-01", "2026-03-01"], index: [1, 1.1, 1.3], nav: [1, 1, 1] };
    const incoming = { dates: ["2026-01-01", "2026-02-01"], index: [1, 1.1], nav: [1, 1] };
    expect(mergeHistory(stored, incoming)).toBeNull();
  });
});

describe("valuePortfolio", () => {
  const synced = Date.parse("2026-11-21T03:00:00Z");

  it("uses snapshot values when quotes are older than the snapshot", () => {
    const v = valuePortfolio([pos({})], 50, "USD", synced, { QQQ: { price: 999, previousClose: 900, marketTimeMs: synced - 1000 } });
    expect(v.value).toBe(270);
    expect(v.livePriced).toBe(0);
    expect(v.dayPnl).toBe(-5);
  });

  it("uses newer live quotes and their day change", () => {
    const v = valuePortfolio([pos({})], 50, "USD", synced, { QQQ: { price: 120, previousClose: 115, currency: "USD", marketTimeMs: synced + 1000 } });
    expect(v.value).toBe(290);
    expect(v.snapshotValue).toBe(270);
    expect(v.dayPnl).toBe(10);
    expect(v.unrealizedPnl).toBe(40);
    expect(v.holdings[0].live).toBe(true);
  });

  it("ignores a quote in another currency, for the total and the holding alike", () => {
    const v = valuePortfolio([pos({})], 0, "USD", synced, { QQQ: { price: 120, currency: "GBP", marketTimeMs: synced + 1000 } });
    expect(v.livePriced).toBe(0);
    expect(v.holdings[0]).toMatchObject({ live: false, price: 110, value: 220 });
  });

  it("keeps the broker's value for a contract with a multiplier, even with a newer quote", () => {
    const opt = pos({ symbol: "OPT", assetClass: "STK", quantity: 1, marketPrice: 5, marketValue: 500, avgCost: 400, unrealizedPnl: 100, multiplier: 100, dailyPnl: 7 });
    const v = valuePortfolio([opt], 0, "USD", synced, { OPT: { price: 6, previousClose: 5, currency: "USD", marketTimeMs: synced + 1 } });
    expect(v.value).toBe(500);
    expect(v.dayPnl).toBe(7);
    expect(v.unrealizedPnl).toBe(100);
  });

  it("never prices a derivative from a quote", () => {
    const opt = pos({ symbol: "AAPL", quantity: 1, marketPrice: 5, marketValue: 500, unrealizedPnl: 100, multiplier: 100, assetClass: "OPT" });
    const v = valuePortfolio([opt], 0, "USD", synced, { AAPL: { price: 230, currency: "USD", marketTimeMs: synced + 1 } });
    expect(v.holdings[0]).toMatchObject({ live: false, value: 500 });
  });

  it("converts other currencies to base, with live FX when newer", () => {
    const gbp = pos({ symbol: "VOD.L", currency: "GBP", quantity: 100, marketPrice: 1, marketValue: 100, unrealizedPnl: 0, dailyPnl: 0, fxToBase: 1.25 });
    expect(valuePortfolio([gbp], 100, "USD", synced, {}).value).toBe(225);
    const v = valuePortfolio([gbp], 100, "USD", synced, { [fxSymbol("GBP", "USD")]: { price: 1.3, currency: "USD", marketTimeMs: synced + 1 } });
    expect(v.value).toBe(230);
    expect(v.snapshotValue).toBe(225);
  });
});

describe("holdingDrawdown", () => {
  it("uses the chosen price against the ATH, and null across currencies", () => {
    expect(holdingDrawdown(90, 100, "USD", "USD")).toBe(10);
    expect(holdingDrawdown(110, 100, "USD", "USD")).toBe(0);
    expect(holdingDrawdown(90, 100, "GBp", "GBP")).toBeNull();
  });
});

describe("portfolioDrawdown", () => {
  const h = { dates: ["a", "b", "c"], index: [1, 1.25, 1.0], nav: [null, null, null] };

  it("measures from the peak of the return index", () => {
    const d = portfolioDrawdown(h, 100, 100)!;
    expect(d.drawdownPct).toBe(20);
    expect(d.peakDate).toBe("b");
  });

  it("moves with live value since the snapshot, ignoring deposits", () => {
    expect(portfolioDrawdown(h, 110, 100)!.drawdownPct).toBe(12);
    const top = portfolioDrawdown(h, 130, 100)!;
    expect(top.drawdownPct).toBe(0);
    expect(top.currentIndex).toBe(1.3);
  });

  it("remembers a live peak between snapshots", () => {
    const d = portfolioDrawdown(h, 110, 100, { index: 1.3, at: "2026-11-21T05:00:00Z" })!;
    expect(d.drawdownPct).toBeCloseTo(15.3846, 3);
    expect(d.peakDate).toBe("live");
  });

  it("is null without history", () => {
    expect(portfolioDrawdown({ dates: [], index: [], nav: [] }, 1, 1)).toBeNull();
  });
});

describe("returnSince", () => {
  const h = { dates: ["2026-01-01", "2026-06-01", "2026-11-20"], index: [1, 1.1, 1.21], nav: [null, null, null] };

  it("starts from the point on the date, or the last one before it", () => {
    expect(returnSince(h, "2026-06-01")).toBe(10);
    expect(returnSince(h, "2026-05-01")).toBe(21);
    expect(returnSince(h, "2027-01-01")).toBeNull();
  });
});

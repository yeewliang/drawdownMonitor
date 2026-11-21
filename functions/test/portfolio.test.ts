import { describe, expect, it } from "vitest";
import {
  historyFromPeriods,
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
    const m = mergeHistory(stored, incoming);
    expect(m.dates).toEqual(["2025-01-01", "2025-06-01", "2025-12-01", "2026-06-01"]);
    expect(m.index[1]).toBeCloseTo(1.2);
    expect(m.index[2]).toBeCloseTo(1.08);
    expect(m.index[3]).toBeCloseTo(1.296);
  });

  it("replaces the stored series when there is no overlap", () => {
    const stored = { dates: ["2020-01-01"], index: [1], nav: [1] };
    const incoming = { dates: ["2026-01-01", "2026-02-01"], index: [1, 1.1], nav: [5, 6] };
    expect(mergeHistory(stored, incoming)).toEqual(incoming);
  });
});

describe("valuePortfolio", () => {
  const synced = Date.parse("2026-11-21T03:00:00Z");

  it("uses snapshot prices when quotes are older than the snapshot", () => {
    const v = valuePortfolio([pos({})], 50, synced, { QQQ: { price: 999, previousClose: 900, marketTimeMs: synced - 1000 } });
    expect(v.value).toBe(270);
    expect(v.livePriced).toBe(0);
    expect(v.dayPnl).toBe(-5);
  });

  it("uses newer live quotes and their day change", () => {
    const v = valuePortfolio([pos({})], 50, synced, { QQQ: { price: 120, previousClose: 115, currency: "USD", marketTimeMs: synced + 1000 } });
    expect(v.value).toBe(290);
    expect(v.snapshotValue).toBe(270);
    expect(v.dayPnl).toBe(10);
    expect(v.unrealizedPnl).toBe(40);
  });

  it("ignores a quote in another currency", () => {
    const v = valuePortfolio([pos({})], 0, synced, { QQQ: { price: 120, currency: "GBP", marketTimeMs: synced + 1000 } });
    expect(v.livePriced).toBe(0);
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
    expect(portfolioDrawdown(h, 130, 100)!.drawdownPct).toBe(0);
  });

  it("is null without history", () => {
    expect(portfolioDrawdown({ dates: [], index: [], nav: [] }, 1, 1)).toBeNull();
  });
});

describe("returnSince", () => {
  it("returns growth from the first date on or after the start", () => {
    const h = { dates: ["2026-01-01", "2026-06-01", "2026-11-20"], index: [1, 1.1, 1.21], nav: [null, null, null] };
    expect(returnSince(h, "2026-05-01")).toBe(10);
    expect(returnSince(h, "2027-01-01")).toBeNull();
  });
});

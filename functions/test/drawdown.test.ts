import { describe, expect, it } from "vitest";
import { athFromBars, drawdownPct, evaluateAlerts, mergeAth, thresholdKey } from "../src/lib/drawdown";

describe("athFromBars", () => {
  const bars = [
    { time: 1, high: 10, close: 9 },
    { time: 2, high: 15, close: 12 },
    { time: 3, high: null, close: null },
    { time: 4, high: 14, close: 13 },
  ];

  it("finds intraday and closing highs", () => {
    const ath = athFromBars(bars);
    expect(ath.intraday).toEqual({ value: 15, time: 2 });
    expect(ath.close).toEqual({ value: 13, time: 4 });
  });

  it("excludes in-progress bars from the closing high", () => {
    const ath = athFromBars(bars, 4);
    expect(ath.close).toEqual({ value: 12, time: 2 });
    expect(ath.intraday).toEqual({ value: 15, time: 2 });
  });
});

describe("mergeAth", () => {
  it("keeps the higher point per basis", () => {
    const merged = mergeAth(
      { intraday: { value: 20, time: 1 }, close: { value: 18, time: 1 } },
      { intraday: { value: 19, time: 5 }, close: { value: 18.5, time: 5 } },
    );
    expect(merged.intraday).toEqual({ value: 20, time: 1 });
    expect(merged.close).toEqual({ value: 18.5, time: 5 });
  });

  it("handles missing state", () => {
    expect(mergeAth({ intraday: null, close: null }, { intraday: { value: 1, time: 1 }, close: null }).intraday?.value).toBe(1);
  });
});

describe("drawdownPct", () => {
  it("computes percent below peak", () => {
    expect(drawdownPct(80, { value: 100, time: 0 })).toBe(20);
  });
  it("is 0 at a new high", () => {
    expect(drawdownPct(110, { value: 100, time: 0 })).toBe(0);
  });
  it("returns null for bad prices", () => {
    expect(drawdownPct(0, { value: 100, time: 0 })).toBeNull();
  });
});

describe("evaluateAlerts", () => {
  it("fires once when crossing a threshold", () => {
    const a = evaluateAlerts([10, 20], 12, {});
    expect(a.fired).toBe(10);
    expect(a.state).toEqual({ "10": true, "20": false });
    const b = evaluateAlerts([10, 20], 13, a.state);
    expect(b.fired).toBeNull();
    expect(b.changed).toBe(false);
  });

  it("reports only the deepest threshold on a gap down", () => {
    const a = evaluateAlerts([10, 20, 30], 25, {});
    expect(a.fired).toBe(20);
    expect(a.state).toEqual({ "10": true, "20": true, "30": false });
  });

  it("re-arms after recovering past the hysteresis band", () => {
    let s = evaluateAlerts([10], 10.2, {}).state;
    s = evaluateAlerts([10], 9.5, s).state; // still within 1pp: stays fired
    expect(s["10"]).toBe(true);
    s = evaluateAlerts([10], 8.9, s).state; // recovered: re-armed
    expect(s["10"]).toBe(false);
    expect(evaluateAlerts([10], 10, s).fired).toBe(10);
  });

  it("ignores invalid thresholds and handles decimals", () => {
    const a = evaluateAlerts([0, -5, 150, 7.5, 7.5], 8, undefined);
    expect(a.fired).toBe(7.5);
    expect(Object.keys(a.state)).toEqual([thresholdKey(7.5)]);
  });

  it("marks state changed when a threshold is removed", () => {
    expect(evaluateAlerts([20], 5, { "10": true, "20": false }).changed).toBe(true);
  });
});

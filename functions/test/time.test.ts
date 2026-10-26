import { describe, expect, it } from "vitest";
import { isSummaryTime, localTime } from "../src/lib/time";

describe("localTime", () => {
  const now = new Date("2026-10-26T00:30:00Z");
  it("converts to the user's time zone", () => {
    expect(localTime(now, "Asia/Singapore")).toEqual({ hour: 8, minute: 30 });
    expect(localTime(now, "America/New_York")).toEqual({ hour: 20, minute: 30 });
    expect(localTime(now, "Asia/Kolkata")).toEqual({ hour: 6, minute: 0 });
  });
  it("falls back to Singapore for missing or invalid zones", () => {
    expect(localTime(now, undefined).hour).toBe(8);
    expect(localTime(now, "Not/AZone").hour).toBe(8);
  });
});

describe("isSummaryTime", () => {
  it("matches the 5-minute slot, including a late scheduler tick", () => {
    expect(isSummaryTime(new Date("2026-10-26T00:35:00Z"), "Asia/Singapore", 8, 35)).toBe(true);
    expect(isSummaryTime(new Date("2026-10-26T00:37:40Z"), "Asia/Singapore", 8, 35)).toBe(true);
    expect(isSummaryTime(new Date("2026-10-26T00:40:00Z"), "Asia/Singapore", 8, 35)).toBe(false);
    expect(isSummaryTime(new Date("2026-10-26T01:35:00Z"), "Asia/Singapore", 8, 35)).toBe(false);
  });
});

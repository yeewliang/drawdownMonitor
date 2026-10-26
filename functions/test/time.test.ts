import { describe, expect, it } from "vitest";
import { localHour } from "../src/lib/time";

describe("localHour", () => {
  const now = new Date("2026-10-26T00:30:00Z");
  it("converts to the user's time zone", () => {
    expect(localHour(now, "Asia/Singapore")).toBe(8);
    expect(localHour(now, "America/New_York")).toBe(20);
    expect(localHour(now, "UTC")).toBe(0);
  });
  it("falls back to Singapore for missing or invalid zones", () => {
    expect(localHour(now, undefined)).toBe(8);
    expect(localHour(now, "Not/AZone")).toBe(8);
  });
});

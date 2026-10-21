import { describe, expect, it } from "vitest";
import { formatAlerts } from "../src/notify/format";

const alert = {
  symbol: "^GSPC",
  name: "S&P 500 <index>",
  watchlistId: "w1",
  watchlistName: "Core",
  threshold: 10,
  drawdownPct: 10.4567,
  price: 6900.5,
  currency: "USD",
  ath: 7700,
  athDate: new Date("2026-10-06T00:00:00Z"),
  basis: "close" as const,
};

describe("formatAlerts", () => {
  it("formats a single alert", () => {
    const m = formatAlerts([alert], "https://app.example");
    expect(m.subject).toBe("^GSPC is 10.46% below its all-time high");
    expect(m.text).toContain("crossed -10%");
    expect(m.text).toContain("2026-10-06");
    expect(m.html).toContain("https://app.example/w/w1");
  });

  it("escapes HTML in Telegram and email bodies", () => {
    const m = formatAlerts([alert], "https://app.example");
    expect(m.telegram).toContain("S&amp;P 500 &lt;index&gt;");
    expect(m.html).not.toContain("<index>");
  });

  it("summarises multiple alerts in the subject", () => {
    const m = formatAlerts([alert, { ...alert, symbol: "AAPL" }], "https://app.example");
    expect(m.subject).toBe("2 drawdown alerts: ^GSPC, AAPL");
  });
});

import { describe, expect, it } from "vitest";
import { deliveryFailed } from "../src/notify/outcome";

describe("deliveryFailed", () => {
  it("is true only when nothing was delivered and something was tried", () => {
    expect(deliveryFailed({ email: "failed", telegram: "failed" })).toBe(true);
    expect(deliveryFailed({ email: "failed", telegram: "skipped" })).toBe(true);
    expect(deliveryFailed({ email: "skipped", telegram: "failed" })).toBe(true);
  });

  it("is false when any channel delivered or none was set up", () => {
    expect(deliveryFailed({ email: "sent", telegram: "failed" })).toBe(false);
    expect(deliveryFailed({ email: "failed", telegram: "sent" })).toBe(false);
    expect(deliveryFailed({ email: "skipped", telegram: "skipped" })).toBe(false);
  });
});

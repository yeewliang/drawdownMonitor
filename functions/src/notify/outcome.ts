/** Outcome per channel of one notification. Pure, so it can be unit tested. */
export interface DispatchResult {
  email: "sent" | "skipped" | "failed";
  telegram: "sent" | "skipped" | "failed";
}

/**
 * True when the message reached nobody although at least one channel was
 * tried: the caller should un-fire the alert so the next cycle retries.
 * A channel that was skipped (off or not set up) is not a failure, and one
 * channel getting through is enough.
 */
export function deliveryFailed(r: DispatchResult): boolean {
  return r.email !== "sent" && r.telegram !== "sent" && (r.email === "failed" || r.telegram === "failed");
}

/**
 * Pure drawdown / all-time-high logic. No Firebase imports here so it can be
 * unit tested in isolation.
 */

export type AthBasis = "close" | "intraday";

/** One daily OHLC bar. `time` is epoch seconds (bar open). */
export interface Bar {
  time: number;
  high: number | null;
  close: number | null;
}

export interface AthPoint {
  value: number;
  /** Epoch seconds of the bar (or quote) that set the high. */
  time: number;
}

export interface AthState {
  intraday: AthPoint | null;
  close: AthPoint | null;
}

/**
 * Compute intraday and closing all-time highs from a series of bars.
 *
 * `completedBefore` (epoch seconds) excludes bars that started at or after it
 * from the closing high, so a still-trading session's "close" (which is just
 * the latest price) is not recorded as a closing high.
 */
export function athFromBars(bars: Bar[], completedBefore = Infinity): AthState {
  let intraday: AthPoint | null = null;
  let close: AthPoint | null = null;
  for (const b of bars) {
    if (isNum(b.high) && (!intraday || b.high > intraday.value)) {
      intraday = { value: b.high, time: b.time };
    }
    if (b.time < completedBefore && isNum(b.close) && (!close || b.close > close.value)) {
      close = { value: b.close, time: b.time };
    }
  }
  return { intraday, close };
}

/** Merge two ATH states, keeping the higher value of each basis. */
export function mergeAth(a: AthState, b: AthState): AthState {
  return {
    intraday: maxPoint(a.intraday, b.intraday),
    close: maxPoint(a.close, b.close),
  };
}

/**
 * Drawdown from ATH, as a positive percentage (0 = at the high).
 * The live price is folded in so a fresh high mid-session reads as 0%.
 */
export function drawdownPct(price: number, ath: AthPoint | null): number | null {
  if (!isNum(price) || price <= 0) return null;
  const peak = Math.max(ath?.value ?? 0, price);
  if (peak <= 0) return null;
  return round((1 - price / peak) * 100, 4);
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * A threshold re-arms once the drawdown recovers this many percentage points
 * below it, so a price hovering around a threshold does not spam alerts.
 */
export const REARM_HYSTERESIS_PCT = 1;

export interface AlertEvaluation {
  /** Updated per-threshold "already fired" state. */
  state: Record<string, boolean>;
  /** The deepest threshold newly crossed in this evaluation, if any. */
  fired: number | null;
  changed: boolean;
}

/**
 * Evaluate alert thresholds (in percent) against the current drawdown.
 *
 * A threshold fires once when the drawdown reaches it, then stays silent
 * until the drawdown recovers below `threshold - REARM_HYSTERESIS_PCT`.
 * If several thresholds are crossed at once only the deepest is reported.
 */
export function evaluateAlerts(
  thresholds: number[],
  drawdown: number,
  prevState: Record<string, boolean> | undefined,
): AlertEvaluation {
  const state: Record<string, boolean> = {};
  let fired: number | null = null;
  let changed = false;
  const valid = [...new Set(thresholds.filter((t) => isNum(t) && t > 0 && t < 100))].sort((a, b) => a - b);

  for (const t of valid) {
    const key = thresholdKey(t);
    const wasFired = prevState?.[key] === true;
    let nowFired = wasFired;
    if (!wasFired && drawdown >= t) {
      nowFired = true;
      fired = t;
    } else if (wasFired && drawdown < t - REARM_HYSTERESIS_PCT) {
      nowFired = false;
    }
    state[key] = nowFired;
    if (nowFired !== wasFired) changed = true;
  }

  // Thresholds that were removed from the item also count as a change.
  if (prevState && Object.keys(prevState).some((k) => !(k in state))) changed = true;

  return { state, fired, changed };
}

/** Firestore map keys cannot contain "." so 7.5 becomes "7_5". */
export function thresholdKey(t: number): string {
  return String(t).replace(".", "_");
}

// ---------------------------------------------------------------------------

function maxPoint(a: AthPoint | null, b: AthPoint | null): AthPoint | null {
  if (!a) return b;
  if (!b) return a;
  return b.value > a.value ? b : a;
}

function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

import type { Timestamp } from "firebase/firestore";
import type { AthBasis, Quote } from "./types";

export function fmtPrice(n: number | null | undefined, currency?: string): string {
  if (n == null) return "–";
  const s = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 });
  return currency ? `${s} ${currency}` : s;
}

export function fmtPct(n: number | null | undefined, signed = false): string {
  if (n == null) return "–";
  const s = `${Math.abs(n).toFixed(2)}%`;
  if (!signed) return s;
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

export function fmtDate(ts: Timestamp | null | undefined): string {
  return ts ? ts.toDate().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "–";
}

export function fmtAgo(ts: Timestamp | null | undefined): string {
  if (!ts) return "–";
  const sec = Math.max(0, (Date.now() - ts.toMillis()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function drawdownOf(q: Quote | undefined, basis: AthBasis): number | null {
  if (!q) return null;
  return (basis === "intraday" ? q.drawdownIntradayPct : q.drawdownClosePct) ?? null;
}

export function athOf(q: Quote | undefined, basis: AthBasis) {
  if (!q) return { value: null, date: null };
  return basis === "intraday"
    ? { value: q.athIntraday ?? null, date: q.athIntradayDate ?? null }
    : { value: q.athClose ?? null, date: q.athCloseDate ?? null };
}

/** Severity bucket used for colouring drawdowns. */
export function severity(dd: number | null): "none" | "low" | "mid" | "high" | "severe" {
  if (dd == null) return "none";
  if (dd < 5) return "low";
  if (dd < 10) return "mid";
  if (dd < 20) return "high";
  return "severe";
}

const SYMBOL_RE = /^[A-Z0-9.^=\-]{1,32}$/;
export function normalizeSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

export function parseThresholds(raw: string): number[] | null {
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  const nums = parts.map((p) => Number(p.replace("%", "").replace("-", "")));
  if (nums.some((n) => !Number.isFinite(n) || n <= 0 || n >= 100)) return null;
  return [...new Set(nums)].sort((a, b) => a - b).slice(0, 10);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string) => EMAIL_RE.test(s.trim());

import type { Timestamp } from "firebase-admin/firestore";
import type { AthBasis } from "./drawdown";

/** quotes/{symbol}: written by functions only. */
export interface QuoteDoc {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  instrumentType: string;
  timezone: string;
  price: number;
  previousClose: number | null;
  changePct: number | null;
  marketTime: Timestamp;
  sessionOpen: boolean;
  athIntraday: number | null;
  athIntradayDate: Timestamp | null;
  athClose: number | null;
  athCloseDate: Timestamp | null;
  drawdownIntradayPct: number | null;
  drawdownClosePct: number | null;
  provider: string;
  historyRefreshedAt: Timestamp;
  updatedAt: Timestamp;
  error: string | null;
}

/** users/{uid} */
export interface UserDoc {
  email?: string | null;
  displayName?: string | null;
  athBasis?: AthBasis;
  notifyEmail?: boolean;
  notifyTelegram?: boolean;
  alertEmail?: string | null;
  telegramChatId?: number | null;
  telegramUsername?: string | null;
  telegramLinkCode?: string | null;
  /** Hour (0-23) in summaryTimeZone to send the daily summary. */
  summaryHour?: number;
  summaryTimeZone?: string;
}

/** watchlists/{wid} */
export interface WatchlistDoc {
  ownerId: string;
  name: string;
  isPublic: boolean;
  sharedWith: string[];
  /** Send the owner a Telegram summary of this list every morning. */
  dailySummary?: boolean;
}

/** watchlists/{wid}/items/{symbol} */
export interface ItemDoc {
  symbol: string;
  ownerId: string;
  thresholds: number[];
  alertsEnabled: boolean;
  alertState?: Record<string, boolean>;
  note?: string;
}

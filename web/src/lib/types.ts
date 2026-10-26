import type { Timestamp } from "firebase/firestore";

export type AthBasis = "close" | "intraday";

export interface Quote {
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  instrumentType?: string;
  price?: number;
  changePct?: number | null;
  marketTime?: Timestamp;
  sessionOpen?: boolean;
  athIntraday?: number | null;
  athIntradayDate?: Timestamp | null;
  athClose?: number | null;
  athCloseDate?: Timestamp | null;
  drawdownIntradayPct?: number | null;
  drawdownClosePct?: number | null;
  updatedAt?: Timestamp;
  error?: string | null;
}

export interface UserProfile {
  email?: string | null;
  displayName?: string | null;
  athBasis?: AthBasis;
  notifyEmail?: boolean;
  notifyTelegram?: boolean;
  alertEmail?: string | null;
  telegramChatId?: number | null;
  telegramUsername?: string | null;
  telegramLinkCode?: string | null;
}

export interface Watchlist {
  id: string;
  ownerId: string;
  ownerName?: string;
  name: string;
  isPublic: boolean;
  sharedWith: string[];
  dailySummary?: boolean;
  createdAt?: Timestamp;
}

export interface WatchItem {
  id: string;
  symbol: string;
  ownerId: string;
  thresholds: number[];
  alertsEnabled: boolean;
  alertState?: Record<string, boolean>;
  note?: string;
  addedAt?: Timestamp;
}

export interface SymbolMatch {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}

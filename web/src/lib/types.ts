import type { Timestamp } from "firebase/firestore";

export type AthBasis = "close" | "intraday";

export interface Quote {
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  instrumentType?: string;
  price?: number;
  previousClose?: number | null;
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
  rearmGapPct?: number;
  summaryHour?: number;
  summaryMinute?: number;
  summaryTimeZone?: string;
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

export interface PortfolioPosition {
  symbol: string;
  brokerSymbol: string;
  contractId: number | null;
  quantity: number;
  avgCost: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  dailyPnl: number | null;
  currency: string;
  assetClass: string | null;
  /** 100 for a US option, 1 for a share. Missing on snapshots saved before it existed. */
  multiplier?: number;
  /** Base currency per unit of `currency` at sync. */
  fxToBase?: number;
}

export interface Portfolio {
  id: string;
  ownerId: string;
  broker: string;
  baseCurrency: string;
  syncedAt: Timestamp;
  summary: {
    netLiquidation: number;
    cash: number;
    buyingPower: number | null;
    availableFunds: number | null;
    excessLiquidity: number | null;
    initialMargin: number | null;
    maintenanceMargin: number | null;
    leverage: number | null;
  };
  positions: PortfolioPosition[];
  /** Time-weighted return index (1.0 at the first date) and account value. */
  history: { dates: string[]; index: number[]; nav: (number | null)[] };
  /** Highest live return index seen since the last sync. */
  livePeak?: { index: number; at: string } | null;
  thresholds?: number[];
  alertsEnabled?: boolean;
  alertState?: Record<string, boolean>;
}

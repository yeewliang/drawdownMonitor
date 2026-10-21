import { AthState } from "../lib/drawdown";

export interface ProviderQuote {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  instrumentType: string;
  timezone: string;
  price: number;
  previousClose: number | null;
  /** Epoch seconds of the last trade / price update. */
  marketTime: number;
  sessionOpen: boolean;
  /** ATH over the bars returned (full history or just the recent window). */
  ath: AthState;
}

export interface SymbolMatch {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}

export interface PriceProvider {
  readonly name: string;
  /**
   * Latest quote. With `fullHistory` the ATH covers the instrument's entire
   * daily history; otherwise only the last few sessions.
   */
  getQuote(symbol: string, opts: { fullHistory: boolean }): Promise<ProviderQuote>;
  search(query: string): Promise<SymbolMatch[]>;
}

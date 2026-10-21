import { PriceProvider } from "./types";
import { YahooProvider } from "./yahoo";

export * from "./types";
export { SymbolNotFoundError } from "./yahoo";

let provider: PriceProvider | null = null;

export function getProvider(): PriceProvider {
  provider ??= new YahooProvider();
  return provider;
}

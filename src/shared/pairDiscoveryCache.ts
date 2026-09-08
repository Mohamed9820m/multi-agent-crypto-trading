import { findPairsForSymbol, PairAnalysis, PairDiscoveryOptions } from './pairDiscovery';
import logger from './logger';

class PairDiscoveryCache {
  private cache = new Map<string, PairAnalysis[]>();
  private lastUpdated = new Map<string, number>();
  private refreshing = new Map<string, Promise<void>>();

  async refresh(symbol: string, opts?: PairDiscoveryOptions, ttlMs = 5 * 60 * 1000): Promise<void> {
    const now = Date.now();
    const last = this.lastUpdated.get(symbol) ?? 0;
    if (now - last < ttlMs && this.cache.has(symbol)) return;

    // Debounce concurrent refreshes.
    if (this.refreshing.has(symbol)) {
      return this.refreshing.get(symbol)!;
    }

    const promise = this.doRefresh(symbol, opts);
    this.refreshing.set(symbol, promise);
    try {
      await promise;
    } finally {
      this.refreshing.delete(symbol);
    }
  }

  private async doRefresh(symbol: string, opts?: PairDiscoveryOptions): Promise<void> {
    logger.info('PairDiscoveryCache refreshing pairs', { symbol });
    try {
      const pairs = await findPairsForSymbol(symbol, opts);
      this.cache.set(symbol, pairs);
      this.lastUpdated.set(symbol, Date.now());
      logger.info('PairDiscoveryCache refreshed', { symbol, pairs: pairs.length });
    } catch (err) {
      logger.error('PairDiscoveryCache refresh failed', { symbol, err: (err as Error).message });
    }
  }

  getPairs(symbol: string): PairAnalysis[] {
    return this.cache.get(symbol.toUpperCase()) ?? [];
  }

  getBestPair(symbol: string): PairAnalysis | undefined {
    const pairs = this.getPairs(symbol);
    return pairs.length > 0 ? pairs[0] : undefined;
  }

  clear(symbol?: string): void {
    if (symbol) {
      this.cache.delete(symbol.toUpperCase());
      this.lastUpdated.delete(symbol.toUpperCase());
    } else {
      this.cache.clear();
      this.lastUpdated.clear();
    }
  }
}

export const pairDiscoveryCache = new PairDiscoveryCache();
export default pairDiscoveryCache;

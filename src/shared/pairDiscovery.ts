import { binanceClient } from '../shared/binance';
import logger from '../shared/logger';

export interface PairAnalysis {
  baseSymbol: string; // the symbol being analyzed, e.g. BTCUSDT
  hedgeSymbol: string; // the cointegrated partner, e.g. ETHUSDT
  correlation: number;
  cointegrated: boolean;
  hedgeRatio: number; // units of hedge per unit of base
  spread: number[];
  zScore: number;
  halfLife: number;
  lastBasePrice: number;
  lastHedgePrice: number;
}

export interface PairDiscoveryOptions {
  timeframe?: string;
  lookback?: number;
  correlationThreshold?: number;
  maxHalfLife?: number;
  zScoreThreshold?: number;
}

const DEFAULT_UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT'];
const FETCH_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Discover cointegrated pairs for a given symbol from a default universe.
 */
export async function findPairsForSymbol(
  symbol: string,
  opts: PairDiscoveryOptions = {}
): Promise<PairAnalysis[]> {
  const { timeframe = '1h', lookback = 100, correlationThreshold = 0.75, maxHalfLife = 50, zScoreThreshold = 2 } = opts;

  return withTimeout(
    (async () => {
      const universe = DEFAULT_UNIVERSE.filter((s) => s !== symbol);
      const basePrices = await fetchClosePrices(symbol, timeframe, lookback);
      if (basePrices.length < lookback * 0.8) {
        logger.warn('PairDiscovery: insufficient base price history', { symbol, got: basePrices.length });
        return [];
      }

      const hedgePriceResults = await Promise.allSettled(
        universe.map((hedgeSymbol) => fetchClosePrices(hedgeSymbol, timeframe, lookback))
      );

      const results: PairAnalysis[] = [];
      for (let i = 0; i < universe.length; i++) {
        const hedgeSymbol = universe[i];
        const result = hedgePriceResults[i];
        if (result.status !== 'fulfilled') {
          logger.debug('PairDiscovery failed for pair', {
            symbol,
            hedgeSymbol,
            err: (result.reason as Error).message,
          });
          continue;
        }
        const hedgePrices = result.value;
        if (hedgePrices.length < lookback * 0.8) continue;

        try {
          const analysis = analyzePair(symbol, basePrices, hedgeSymbol, hedgePrices);
          if (analysis.correlation >= correlationThreshold && analysis.cointegrated && analysis.halfLife <= maxHalfLife) {
            if (Math.abs(analysis.zScore) >= zScoreThreshold) {
              results.push(analysis);
            }
          }
        } catch (err) {
          logger.debug('PairDiscovery analysis failed for pair', {
            symbol,
            hedgeSymbol,
            err: (err as Error).message,
          });
        }
      }

      return results.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
    })(),
    TOTAL_TIMEOUT_MS,
    `PairDiscovery for ${symbol}`
  );
}

async function fetchClosePrices(symbol: string, timeframe: string, limit: number): Promise<number[]> {
  const klines = await withTimeout(
    binanceClient.getKlines(symbol, timeframe, limit),
    FETCH_TIMEOUT_MS,
    `Klines ${symbol} ${timeframe}`
  );
  return klines.map((k) => k.close.toNumber());
}

function analyzePair(
  baseSymbol: string,
  basePrices: number[],
  hedgeSymbol: string,
  hedgePrices: number[]
): PairAnalysis {
  const n = Math.min(basePrices.length, hedgePrices.length);
  const x = basePrices.slice(-n); // base
  const y = hedgePrices.slice(-n); // hedge

  const logX = x.map(Math.log);
  const logY = y.map(Math.log);

  const correlation = pearson(logX, logY);

  // OLS: logY = alpha + beta * logX
  const { beta, alpha } = linearRegression(logX, logY);
  const residual = logY.map((yi, i) => yi - (alpha + beta * logX[i]));

  const spread = residual;
  const mean = spread.reduce((a, b) => a + b, 0) / spread.length;
  const std = Math.sqrt(spread.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / spread.length) || 1e-9;
  const zScore = (spread[spread.length - 1] - mean) / std;

  const halfLife = estimateHalfLife(spread);
  const cointegrated = correlation > 0.7 && halfLife > 0 && halfLife < 100;

  return {
    baseSymbol,
    hedgeSymbol,
    correlation,
    cointegrated,
    hedgeRatio: beta,
    spread,
    zScore,
    halfLife,
    lastBasePrice: x[x.length - 1],
    lastHedgePrice: y[y.length - 1],
  };
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - meanA) * (b[i] - meanB);
    denA += Math.pow(a[i] - meanA, 2);
    denB += Math.pow(b[i] - meanB, 2);
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

function linearRegression(x: number[], y: number[]): { alpha: number; beta: number } {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - meanX) * (y[i] - meanY);
    den += Math.pow(x[i] - meanX, 2);
  }
  const beta = den === 0 ? 0 : num / den;
  const alpha = meanY - beta * meanX;
  return { alpha, beta };
}

function estimateHalfLife(residual: number[]): number {
  if (residual.length < 10) return Infinity;
  const lagged = residual.slice(0, -1);
  const current = residual.slice(1);
  const { beta } = linearRegression(lagged, current);
  if (beta >= 1 || beta <= 0) return Infinity;
  return -Math.log(2) / Math.log(beta);
}

export function pairSignalDirection(pair: PairAnalysis): 'long' | 'short' | 'no_trade' {
  if (!pair.cointegrated) return 'no_trade';
  if (pair.zScore > 2) return 'short'; // base is rich relative to hedge
  if (pair.zScore < -2) return 'long'; // base is cheap relative to hedge
  return 'no_trade';
}

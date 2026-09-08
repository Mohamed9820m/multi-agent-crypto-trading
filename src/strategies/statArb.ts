import Decimal from 'decimal.js';
import { Strategy, StrategyContext } from './types';
import { TradeSignal } from '../shared/types';
import { pairDiscoveryCache } from '../shared/pairDiscoveryCache';
import { pairSignalDirection } from '../shared/pairDiscovery';

const noTrade = (reason: string): TradeSignal => ({
  signal: 'no_trade',
  strategyUsed: 'statArb',
  confidence: 0,
  triggeringRules: [reason],
});

export const statArbStrategy: Strategy = {
  name: 'statArb',
  version: '1.0.0',
  description:
    'Statistical arbitrage / pairs trading based on cointegration, spread Z-score, and mean reversion. Uses cached pair discovery.',
  params: {
    zScoreThreshold: 2.0,
    lookback: 100,
    minHalfLife: 5,
    maxHalfLife: 50,
  },

  computeSignal(ctx: StrategyContext): TradeSignal {
    const pair = pairDiscoveryCache.getBestPair(ctx.symbol);
    if (!pair) {
      return noTrade('No cached cointegrated pair available');
    }

    const direction = pairSignalDirection(pair);
    if (direction === 'no_trade') {
      return noTrade(`Spread z-score ${pair.zScore.toFixed(2)} within threshold`);
    }

    const confidence = Math.min(Math.abs(pair.zScore) * 25, 90);
    return {
      signal: direction,
      strategyUsed: 'statArb',
      confidence,
      triggeringRules: [
        `Cointegrated pair ${pair.hedgeSymbol} (correlation ${pair.correlation.toFixed(2)}, half-life ${pair.halfLife.toFixed(1)})`,
        `Spread z-score ${pair.zScore.toFixed(2)}`,
        `Hedge ratio ${pair.hedgeRatio.toFixed(4)}`,
      ],
    };
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    return direction === 'LONG' ? entry.times(0.98) : entry.times(1.02);
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal | null {
    return direction === 'LONG' ? entry.times(1.02) : entry.times(0.98);
  },
};

export default statArbStrategy;

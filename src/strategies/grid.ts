import Decimal from 'decimal.js';
import { Strategy, StrategyContext } from './types';
import { TradeSignal } from '../shared/types';

const noTrade = (reason: string): TradeSignal => ({
  signal: 'no_trade',
  strategyUsed: 'grid',
  confidence: 0,
  triggeringRules: [reason],
});

/**
 * BMAD adaptive range grid.
 *
 * The grid is active only in range / low-volatility / mean-reversion regimes.
 * Spacing = ATR × gridSpacingAtrMultiple.
 * Boundaries are derived from the recent N-candle high/low.
 *
 * Stop loss is placed outside the established range.
 * Take profit targets the first opposing grid level (one spacing toward mid-range).
 */
export const gridStrategy: Strategy = {
  name: 'grid',
  version: '1.1.0',
  description:
    'BMAD adaptive range grid: volatility-derived spacing, dynamic boundaries, regime-aware activation.',
  params: {
    lookback: 50,
    gridSpacingAtrMultiple: 0.5,
    maxGridLevels: 5,
    minRangePct: 0.015,
    maxInventoryPct: 0.5,
    adxMax: 25,
  },

  computeSignal(ctx: StrategyContext): TradeSignal {
    const { marketData, technicalAnalysis: ta, regime, marketIntelligence } = ctx;
    const candles = marketData.candles;
    const close = candles[candles.length - 1]?.close;
    const atr = ta.indicators['ATR(14)']?.value;
    const adx = ta.indicators['ADX(14)']?.value;

    if (!close || !atr || !adx) return noTrade('Missing indicators');
    if (candles.length < this.params.lookback) return noTrade('Insufficient history');

    const dominant = regime?.dominantRegime ?? 'UNCERTAIN';
    if (!['RANGE', 'LOW_VOLATILITY', 'MEAN_REVERSION'].includes(dominant)) {
      return noTrade(`Regime ${dominant} not suitable for grid`);
    }

    if (adx.gt(this.params.adxMax)) return noTrade(`ADX ${adx.toFixed(1)} too high for grid`);

    // Defensive stance from market intelligence
    if (marketIntelligence && marketIntelligence.tradeStance === 'defensive') {
      return noTrade('Market intelligence recommends defensive stance');
    }

    const window = candles.slice(-this.params.lookback);
    const highest = window.reduce((a, c) => Decimal.max(a, c.high), window[0].high);
    const lowest = window.reduce((a, c) => Decimal.min(a, c.low), window[0].low);
    const range = highest.minus(lowest);
    const rangePct = close.gt(0) ? range.div(close).toNumber() : 0;

    if (rangePct < this.params.minRangePct) return noTrade(`Range ${(rangePct * 100).toFixed(2)}% too narrow`);

    const gridSpacing = atr.times(this.params.gridSpacingAtrMultiple);
    const positionInRange = range.gt(0) ? close.minus(lowest).div(range).toNumber() : 0.5;

    let direction: 'long' | 'short' | null = null;
    const rules: string[] = [];

    if (positionInRange < 0.25) {
      direction = 'long';
      rules.push(`Price in lower quartile of ${this.params.lookback}-candle range`);
    } else if (positionInRange > 0.75) {
      direction = 'short';
      rules.push(`Price in upper quartile of ${this.params.lookback}-candle range`);
    }

    if (!direction) return noTrade('Price not near grid boundary');

    rules.push(`Grid spacing ${gridSpacing.toFixed(2)} (ATR×${this.params.gridSpacingAtrMultiple})`);
    rules.push(`Range ${(rangePct * 100).toFixed(2)}%`);

    const confidence = Math.min(80, 50 + Math.abs(positionInRange - 0.5) * 100);
    return { signal: direction, strategyUsed: this.name, confidence, triggeringRules: rules };
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    const atrVal = _ctx.technicalAnalysis.indicators['ATR(14)']?.value;
    const candles = _ctx.marketData.candles;
    const window = candles.slice(-this.params.lookback);
    const highest = window.reduce((a, c) => Decimal.max(a, c.high), window[0].high);
    const lowest = window.reduce((a, c) => Decimal.min(a, c.low), window[0].low);
    const buffer = atrVal ? atrVal.times(0.75) : entry.times(0.005);
    // Hard stop outside the established range
    return direction === 'LONG' ? lowest.minus(buffer) : highest.plus(buffer);
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal, _stopLoss: Decimal): Decimal | null {
    const atrVal = _ctx.technicalAnalysis.indicators['ATR(14)']?.value;
    if (!atrVal) return direction === 'LONG' ? entry.times(1.01) : entry.times(0.99);
    const gridSpacing = atrVal.times(this.params.gridSpacingAtrMultiple);
    return direction === 'LONG' ? entry.plus(gridSpacing) : entry.minus(gridSpacing);
  },
};

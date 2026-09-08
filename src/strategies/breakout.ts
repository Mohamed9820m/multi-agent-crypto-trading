import Decimal from 'decimal.js';
import { Strategy, StrategyContext } from './types';
import { TradeSignal } from '../shared/types';

const noTrade = (reason: string): TradeSignal => ({
  signal: 'no_trade',
  strategyUsed: 'breakout',
  confidence: 0,
  triggeringRules: [reason],
});

/**
 * BMAD volatility-compression breakout.
 *
 * Trigger requires:
 *   1. Compression vs prior lookback (compression ratio < threshold).
 *   2. Volume expansion vs lookback average.
 *   3. Close beyond the compression range.
 *   4. ADX >= 25 to confirm follow-through potential.
 *
 * Stop loss = opposite side of the compression range plus a small ATR buffer.
 * Take profit = measured move = width of the compression range beyond entry.
 */
export const breakoutStrategy: Strategy = {
  name: 'breakout',
  version: '1.1.0',
  description:
    'BMAD volatility compression + volume expansion + market-structure break. Measured-move target, range-based stop.',
  params: {
    lookback: 20,
    compressionThreshold: 0.55,
    volumeMultiplier: 1.5,
    atrMultiplier: 0.75,
    minAdx: 25,
    minConfidence: 60,
  },

  computeSignal(ctx: StrategyContext): TradeSignal {
    const { marketData, technicalAnalysis: ta, marketIntelligence } = ctx;
    const candles = marketData.candles;
    const p = this.params;

    if (candles.length < p.lookback * 2 + 1) return noTrade('Insufficient candle history');

    const atr14 = ta.indicators['ATR(14)']?.value;
    const adx = ta.indicators['ADX(14)']?.value;
    const close = candles[candles.length - 1].close;

    if (!atr14 || !adx) return noTrade('Missing ATR/ADX');

    const window = candles.slice(-p.lookback);
    const highestHigh = window.reduce((a, c) => Decimal.max(a, c.high), window[0].high);
    const lowestLow = window.reduce((a, c) => Decimal.min(a, c.low), window[0].low);
    const range = highestHigh.minus(lowestLow);

    const priorWindow = candles.slice(-(p.lookback * 2), -p.lookback);
    const priorHigh = priorWindow.reduce((a, c) => Decimal.max(a, c.high), priorWindow[0].high);
    const priorLow = priorWindow.reduce((a, c) => Decimal.min(a, c.low), priorWindow[0].low);
    const priorRange = priorHigh.minus(priorLow);
    const compressionRatio = priorRange.gt(0) ? range.div(priorRange).toNumber() : 1;

    const avgVolume = window
      .slice(0, -1)
      .reduce((a, c) => a.plus(c.volume), new Decimal(0))
      .div(p.lookback - 1);
    const currentVolume = candles[candles.length - 1].volume;
    const volumeSpike = avgVolume.gt(0) && currentVolume.gte(avgVolume.times(p.volumeMultiplier));
    const volumeRatio = avgVolume.gt(0) ? currentVolume.div(avgVolume).toNumber() : 1;

    const rules: string[] = [];
    let direction: 'long' | 'short' | null = null;

    if (compressionRatio < p.compressionThreshold) rules.push(`Compression ratio ${compressionRatio.toFixed(2)}`);
    if (volumeSpike) rules.push(`Volume spike ${volumeRatio.toFixed(2)}x average`);

    const breakoutBuffer = atr14.times(0.15);
    if (
      close.gt(highestHigh.plus(breakoutBuffer)) &&
      compressionRatio < p.compressionThreshold &&
      volumeSpike
    ) {
      direction = 'long';
      rules.push('Close above compression range high');
    } else if (
      close.lt(lowestLow.minus(breakoutBuffer)) &&
      compressionRatio < p.compressionThreshold &&
      volumeSpike
    ) {
      direction = 'short';
      rules.push('Close below compression range low');
    }

    if (!direction) return noTrade('No confirmed breakout');
    if (adx.lt(p.minAdx)) return noTrade(`ADX ${adx.toFixed(1)} below ${p.minAdx} follow-through threshold`);

    // Defensive stance from market intelligence
    if (marketIntelligence && marketIntelligence.tradeStance === 'defensive') {
      return noTrade('Market intelligence recommends defensive stance');
    }

    const confidence = Math.min(
      90,
      p.minConfidence +
        (volumeSpike ? 10 : 0) +
        (compressionRatio < 0.45 ? 10 : 0) +
        (adx.gte(30) ? 5 : 0)
    );

    return {
      signal: direction,
      strategyUsed: this.name,
      confidence,
      triggeringRules: rules,
    };
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    const atrVal = _ctx.technicalAnalysis.indicators['ATR(14)']?.value;
    const candles = _ctx.marketData.candles;
    const window = candles.slice(-this.params.lookback);
    const highestHigh = window.reduce((a, c) => Decimal.max(a, c.high), window[0].high);
    const lowestLow = window.reduce((a, c) => Decimal.min(a, c.low), window[0].low);
    const buffer = atrVal ? atrVal.times(this.params.atrMultiplier) : entry.times(0.005);
    // Stop beyond the opposite boundary of the compression range
    return direction === 'LONG' ? lowestLow.minus(buffer) : highestHigh.plus(buffer);
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal, _stopLoss: Decimal): Decimal | null {
    const candles = _ctx.marketData.candles;
    const window = candles.slice(-this.params.lookback);
    const highestHigh = window.reduce((a, c) => Decimal.max(a, c.high), window[0].high);
    const lowestLow = window.reduce((a, c) => Decimal.min(a, c.low), window[0].low);
    const rangeWidth = highestHigh.minus(lowestLow);
    // Measured move target
    return direction === 'LONG' ? entry.plus(rangeWidth) : entry.minus(rangeWidth);
  },
};

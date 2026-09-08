import Decimal from 'decimal.js';
import { TradeSignal } from '../shared/types';
import { Strategy, StrategyContext } from './types';

export const trendFollowingStrategy: Strategy = {
  name: 'trendFollowing',
  version: '1.0.0',
  description: 'Spot trend following using EMA crossover confirmed by ADX > 25, exit via ATR trailing stop.',
  params: {
    fastEma: 9,
    slowEma: 21,
    adxThreshold: 25,
    adxPeriod: 14,
    atrMultiplier: 2,
    confidencePerAgreeingIndicator: 20,
  },

  computeSignal(ctx: StrategyContext): TradeSignal {
    const { technicalAnalysis: ta, sentiment, marketData } = ctx;
    const ind = ta.indicators;
    const triggeringRules: string[] = [];

    const fastEma = ind['EMA(9)']?.value;
    const slowEma = ind['EMA(21)']?.value;
    const adx = ind['ADX(14)']?.value;
    const plusDi = ind['+DI(14)']?.value;
    const minusDi = ind['-DI(14)']?.value;
    const macdHist = ind['MACD(12,26,9).histogram']?.value;
    const close = marketData.candles[marketData.candles.length - 1]?.close;

    if (!fastEma || !slowEma || !adx || !close) {
      return { signal: 'no_trade', strategyUsed: this.name, confidence: 0, triggeringRules: ['Missing required indicators'] };
    }

    let direction: 'long' | 'short' | null = null;

    if (fastEma.gt(slowEma)) {
      direction = 'long';
      triggeringRules.push('Fast EMA(9) above slow EMA(21)');
    } else if (fastEma.lt(slowEma)) {
      direction = 'short';
      triggeringRules.push('Fast EMA(9) below slow EMA(21)');
    }

    if (adx.gte(this.params.adxThreshold)) {
      triggeringRules.push(`ADX(${this.params.adxPeriod}) >= ${this.params.adxThreshold}: trend strong`);
    } else {
      triggeringRules.push(`ADX(${this.params.adxPeriod}) < ${this.params.adxThreshold}: trend weak`);
      direction = null;
    }

    if (plusDi && minusDi) {
      const diAligned = direction === 'long' ? plusDi.gt(minusDi) : minusDi.gt(plusDi);
      if (diAligned) {
        triggeringRules.push(direction === 'long' ? '+DI > -DI' : '-DI > +DI');
      } else {
        triggeringRules.push(direction === 'long' ? '+DI <= -DI (warning)' : '-DI <= +DI (warning)');
      }
    }

    if (macdHist) {
      if ((direction === 'long' && macdHist.lte(0)) || (direction === 'short' && macdHist.gte(0))) {
        triggeringRules.push('MACD histogram contradicts direction — ignored');
      }
    }

    // Sentiment used as a filter, not primary trigger.
    if (direction && Math.sign(sentiment.sentimentScore) === -Math.sign(direction === 'long' ? 1 : -1) && Math.abs(sentiment.sentimentScore) > 50) {
      triggeringRules.push(`Strong opposing sentiment (${sentiment.sentimentScore}) — veto`);
      direction = null;
    }

    if (!direction) {
      return { signal: 'no_trade', strategyUsed: this.name, confidence: 0, triggeringRules };
    }

    // Confidence: base 30 + 20 per agreeing hard filter, capped at 95.
    let confidence = 30;
    if (ta.technicalBias === (direction === 'long' ? 'bullish' : 'bearish')) confidence += 25;
    if (adx.gte(30)) confidence += 20;
    if (macdHist && ((direction === 'long' && macdHist.gt(0)) || (direction === 'short' && macdHist.lt(0)))) confidence += 15;
    if (Math.sign(sentiment.sentimentScore) === (direction === 'long' ? 1 : -1)) confidence += 10;
    confidence = Math.min(95, confidence);

    return {
      signal: direction,
      strategyUsed: this.name,
      confidence,
      triggeringRules,
    };
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    const atrVal = _ctx.technicalAnalysis.indicators['ATR(14)']?.value;
    if (!atrVal) return direction === 'LONG' ? entry.times(0.97) : entry.times(1.03);
    const offset = atrVal.times(this.params.atrMultiplier);
    return direction === 'LONG' ? entry.minus(offset) : entry.plus(offset);
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal, stopLoss: Decimal): Decimal | null {
    const rr = new Decimal(2); // target 1:2 minimum
    const risk = entry.minus(stopLoss).abs();
    return direction === 'LONG' ? entry.plus(risk.times(rr)) : entry.minus(risk.times(rr));
  },
};

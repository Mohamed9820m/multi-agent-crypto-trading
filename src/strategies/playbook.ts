import Decimal from 'decimal.js';
import { TradeSignal } from '../shared/types';
import { Strategy, StrategyContext } from './types';
import { trendFollowingStrategy } from './trendFollowing';
import { breakoutStrategy } from './breakout';
import { scalpingStrategy } from './scalping';
import { gridStrategy } from './grid';
import { fundingArbStrategy } from './fundingArb';
import { statArbStrategy } from './statArb';

const noTrade = (strategy: string, reason: string): TradeSignal => ({
  signal: 'no_trade',
  strategyUsed: strategy,
  confidence: 0,
  triggeringRules: [reason],
});

export const meanReversionStrategy: Strategy = {
  name: 'meanReversion',
  version: '1.0.0',
  description: 'Fade overextension when RSI < 30 or price touches lower Bollinger Band in a range (ADX < 20).',
  params: { rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, adxMax: 20, atrMultiplier: 1.5 },

  computeSignal(ctx: StrategyContext): TradeSignal {
    const { technicalAnalysis: ta, marketData, sentiment } = ctx;
    const ind = ta.indicators;
    const rsi = ind['RSI(14)']?.value;
    const adx = ind['ADX(14)']?.value;
    const lowerBand = ind['BB(20,2).lower']?.value;
    const upperBand = ind['BB(20,2).upper']?.value;
    const close = marketData.candles[marketData.candles.length - 1]?.close;
    if (!rsi || !adx || !close) return noTrade(this.name, 'Missing indicators');

    let direction: 'long' | 'short' | null = null;
    const rules: string[] = [];

    if (adx.gt(this.params.adxMax)) return noTrade(this.name, 'ADX too high for mean reversion');

    if (rsi.lte(this.params.rsiOversold) || (lowerBand && close.lte(lowerBand))) {
      direction = 'long';
      rules.push(rsi.lte(this.params.rsiOversold) ? `RSI ${rsi.toFixed(2)} oversold` : 'Price at/under lower Bollinger Band');
    } else if (rsi.gte(this.params.rsiOverbought) || (upperBand && close.gte(upperBand))) {
      direction = 'short';
      rules.push(rsi.gte(this.params.rsiOverbought) ? `RSI ${rsi.toFixed(2)} overbought` : 'Price at/over upper Bollinger Band');
    }

    if (!direction) return noTrade(this.name, 'No overextension detected');

    if (Math.sign(sentiment.sentimentScore) === (direction === 'long' ? -1 : 1) && Math.abs(sentiment.sentimentScore) > 60) {
      return noTrade(this.name, 'Strong opposing sentiment');
    }

    const confidence = 40 + (direction === 'long' ? this.params.rsiOversold - rsi.toNumber() : rsi.toNumber() - this.params.rsiOverbought);
    return { signal: direction, strategyUsed: this.name, confidence: Math.min(90, Math.max(50, confidence)), triggeringRules: rules };
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    const atrVal = _ctx.technicalAnalysis.indicators['ATR(14)']?.value;
    if (!atrVal) return direction === 'LONG' ? entry.times(0.985) : entry.times(1.015);
    return direction === 'LONG' ? entry.minus(atrVal.times(this.params.atrMultiplier)) : entry.plus(atrVal.times(this.params.atrMultiplier));
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal, stopLoss: Decimal): Decimal | null {
    const risk = entry.minus(stopLoss).abs();
    return direction === 'LONG' ? entry.plus(risk.times(1.5)) : entry.minus(risk.times(1.5));
  },
};

export const momentumBreakoutStrategy: Strategy = {
  name: 'momentumBreakout',
  version: '1.0.0',
  description: 'Enter on Bollinger/Keltner squeeze breakout with volume spike.',
  params: { bbPeriod: 20, kcMultiplier: 1.5, volumeLookback: 20, atrMultiplier: 1.5 },

  computeSignal(ctx: StrategyContext): TradeSignal {
    const { technicalAnalysis: ta, marketData, sentiment } = ctx;
    const ind = ta.indicators;
    const bbUpper = ind['BB(20,2).upper']?.value;
    const bbLower = ind['BB(20,2).lower']?.value;
    const kcUpper = ind['KC(20,14,1.5).upper']?.value;
    const kcLower = ind['KC(20,14,1.5).lower']?.value;
    const adx = ind['ADX(14)']?.value;
    const close = marketData.candles[marketData.candles.length - 1]?.close;
    if (!bbUpper || !bbLower || !kcUpper || !kcLower || !adx || !close) return noTrade(this.name, 'Missing indicators');

    const candles = marketData.candles;
    const avgVol = candles.slice(-this.params.volumeLookback).reduce((a, c) => a.plus(c.volume), new Decimal(0)).div(this.params.volumeLookback);
    const volSpike = candles[candles.length - 1].volume.gte(avgVol.times(1.5));

    const squeeze = bbUpper.lt(kcUpper) && bbLower.gt(kcLower);
    const rules: string[] = [];
    let direction: 'long' | 'short' | null = null;

    if (squeeze) rules.push('Bollinger/Keltner squeeze detected');

    if (close.gt(bbUpper) && volSpike) {
      direction = 'long';
      rules.push('Close above upper Bollinger with volume spike');
    } else if (close.lt(bbLower) && volSpike) {
      direction = 'short';
      rules.push('Close below lower Bollinger with volume spike');
    }

    if (!direction) return noTrade(this.name, 'No breakout');
    if (adx.lt(25)) return noTrade(this.name, 'ADX too weak for breakout follow-through');

    if (Math.sign(sentiment.sentimentScore) === (direction === 'long' ? -1 : 1) && Math.abs(sentiment.sentimentScore) > 50) {
      return noTrade(this.name, 'Strong opposing sentiment');
    }

    return { signal: direction, strategyUsed: this.name, confidence: 65, triggeringRules: rules };
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    const atrVal = _ctx.technicalAnalysis.indicators['ATR(14)']?.value;
    if (!atrVal) return direction === 'LONG' ? entry.times(0.97) : entry.times(1.03);
    return direction === 'LONG' ? entry.minus(atrVal.times(this.params.atrMultiplier)) : entry.plus(atrVal.times(this.params.atrMultiplier));
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal, stopLoss: Decimal): Decimal | null {
    const risk = entry.minus(stopLoss).abs();
    return direction === 'LONG' ? entry.plus(risk.times(2)) : entry.minus(risk.times(2));
  },
};

export const gridTradingStrategy: Strategy = {
  name: 'gridTrading',
  version: '0.1.0',
  description: 'Stub: grid trading across a defined price range. Requires pre-defined range and is not safe to run blindly.',
  params: { gridLevels: 10, gridRangePct: 5 },

  computeSignal(): TradeSignal {
    return noTrade(this.name, 'Grid strategy requires explicit price range configuration');
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    return direction === 'LONG' ? entry.times(0.95) : entry.times(1.05);
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal | null {
    return direction === 'LONG' ? entry.times(1.02) : entry.times(0.98);
  },
};

export const dcaStrategy: Strategy = {
  name: 'dca',
  version: '0.1.0',
  description: 'Stub: dollar-cost averaging with safety orders. Not configured for autonomous entry.',
  params: {},

  computeSignal(): TradeSignal {
    return noTrade(this.name, 'DCA strategy requires schedule/layer configuration');
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    return direction === 'LONG' ? entry.times(0.9) : entry.times(1.1);
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal | null {
    return direction === 'LONG' ? entry.times(1.05) : entry.times(0.95);
  },
};

export const arbitrageStrategy: Strategy = {
  name: 'arbitrage',
  version: '0.1.0',
  description: 'Stub: cross-pair arbitrage. Requires real-time multi-pair infrastructure.',
  params: {},

  computeSignal(): TradeSignal {
    return noTrade(this.name, 'Arbitrage requires multi-pair price feed and fee model');
  },

  computeStopLoss(_ctx: StrategyContext, _direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    return entry;
  },

  computeTakeProfit(_ctx: StrategyContext, _direction: 'LONG' | 'SHORT', entry: Decimal): Decimal | null {
    return entry;
  },
};

export const marketMakingStrategy: Strategy = {
  name: 'marketMaking',
  version: '0.1.0',
  description: 'Stub: market making around mid-price. Requires inventory and spread model.',
  params: {},

  computeSignal(): TradeSignal {
    return noTrade(this.name, 'Market making requires bid/ask spread model and inventory limits');
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    return direction === 'LONG' ? entry.times(0.99) : entry.times(1.01);
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal | null {
    return direction === 'LONG' ? entry.times(1.005) : entry.times(0.995);
  },
};

export const strategyRegistry: Record<string, Strategy> = {
  trendFollowing: trendFollowingStrategy,
  meanReversion: meanReversionStrategy,
  momentumBreakout: momentumBreakoutStrategy,
  breakout: breakoutStrategy,
  scalping: scalpingStrategy,
  grid: gridStrategy,
  fundingArb: fundingArbStrategy,
  statArb: statArbStrategy,
  gridTrading: gridTradingStrategy,
  dca: dcaStrategy,
  arbitrage: arbitrageStrategy,
  marketMaking: marketMakingStrategy,
};

export function getStrategy(name: string): Strategy {
  const strategy = strategyRegistry[name];
  if (!strategy) throw new Error(`Unknown strategy: ${name}`);
  return strategy;
}

export const activeStrategy = (name: string): Strategy => getStrategy(name);

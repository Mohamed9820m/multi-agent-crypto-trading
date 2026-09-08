import Decimal from 'decimal.js';
import { Strategy, StrategyContext } from './types';
import { TradeSignal } from '../shared/types';

const noTrade = (reason: string): TradeSignal => ({
  signal: 'no_trade',
  strategyUsed: 'scalping',
  confidence: 0,
  triggeringRules: [reason],
});

/**
 * BMAD-style microstructure scalping.
 *
 * Entry signal requires:
 *   1. Suitable regime (not panic/euphoria/high volatility).
 *   2. Spread <= maxSpreadBps.
 *   3. Liquidity score >= minLiquidityScore.
 *   4. Bid/ask imbalance, depth imbalance, and volume delta all aligned.
 *   5. Estimated edge in basis points >= minEdgeBps.
 *
 * Stop loss = entry ± ATR × 0.5 (tight).
 * Take profit = entry ± risk × 1.0 (1:1 scalp).
 */
export const scalpingStrategy: Strategy = {
  name: 'scalping',
  version: '1.1.0',
  description:
    'BMAD microstructure scalping: orderbook imbalance + depth imbalance + volume delta, with spread-aware edge sizing.',
  params: {
    minEdgeBps: 5,
    maxSpreadBps: 12,
    minLiquidityScore: 65,
    imbalanceThreshold: 0.22,
    volumeDeltaThreshold: 0.12,
    atrMultiplier: 0.5,
    volatilityPenalty: 1.2,
  },

  computeSignal(ctx: StrategyContext): TradeSignal {
    const { marketData, technicalAnalysis: ta, microstructure, regime, marketIntelligence } = ctx;
    const candles = marketData.candles;
    const close = candles[candles.length - 1]?.close;
    const atr14 = ta.indicators['ATR(14)']?.value;

    if (!close || !microstructure || !atr14) return noTrade('Missing data');

    const spreadPct = microstructure.orderBook.spreadPct;
    const liquidity = microstructure.liquidity.liquidityScore;
    const imbalance = microstructure.orderBook.bidAskImbalance;
    const depthImbalance = microstructure.orderBook.depthImbalance;
    const volumeDelta = microstructure.volumeDelta.volumeDelta;
    const totalVolume = microstructure.volumeDelta.buyVolume.plus(microstructure.volumeDelta.sellVolume);
    const deltaRatio = totalVolume.gt(0) ? volumeDelta.div(totalVolume).toNumber() : 0;

    // Regime / volatility filter
    if (regime && (regime.dominantRegime === 'PANIC' || regime.dominantRegime === 'EUPHORIA' || regime.dominantRegime === 'HIGH_VOLATILITY')) {
      return noTrade('Regime unsuitable for scalping');
    }

    // Respect market-intelligence defensive stance
    if (marketIntelligence && marketIntelligence.tradeStance === 'defensive') {
      return noTrade('Market intelligence recommends defensive stance');
    }

    if (spreadPct * 10000 > this.params.maxSpreadBps) {
      return noTrade(`Spread ${(spreadPct * 10000).toFixed(1)} bps exceeds max ${this.params.maxSpreadBps}`);
    }
    if (liquidity < this.params.minLiquidityScore) {
      return noTrade(`Liquidity score ${liquidity} below minimum ${this.params.minLiquidityScore}`);
    }

    const rules: string[] = [];
    let direction: 'long' | 'short' | null = null;

    if (imbalance > this.params.imbalanceThreshold && depthImbalance > this.params.imbalanceThreshold && deltaRatio > this.params.volumeDeltaThreshold) {
      direction = 'long';
      rules.push(`Bid/ask imbalance ${imbalance.toFixed(2)}`);
      rules.push(`Depth imbalance ${depthImbalance.toFixed(2)}`);
      rules.push(`Volume delta ratio ${deltaRatio.toFixed(2)}`);
    } else if (
      imbalance < -this.params.imbalanceThreshold &&
      depthImbalance < -this.params.imbalanceThreshold &&
      deltaRatio < -this.params.volumeDeltaThreshold
    ) {
      direction = 'short';
      rules.push(`Bid/ask imbalance ${imbalance.toFixed(2)}`);
      rules.push(`Depth imbalance ${depthImbalance.toFixed(2)}`);
      rules.push(`Volume delta ratio ${deltaRatio.toFixed(2)}`);
    }

    if (!direction) return noTrade('No aligned microstructure edge');

    // Edge in basis points = half the spread captured by the imbalance
    const edgeBps = Math.abs(imbalance) * (spreadPct * 10000) * 0.5;
    if (edgeBps < this.params.minEdgeBps) {
      return noTrade(`Edge ${edgeBps.toFixed(1)} bps below minimum ${this.params.minEdgeBps}`);
    }

    // Confidence scales with edge and liquidity, penalised by ATR%
    const atrPct = atr14.div(close).toNumber();
    const liquidityBoost = Math.max(0, liquidity - 60) / 5;
    const volatilityPenalty = Math.max(0, (atrPct * 100 - 0.5) * 10);
    const confidence = Math.min(85, 50 + edgeBps + liquidityBoost - volatilityPenalty);

    return {
      signal: direction,
      strategyUsed: this.name,
      confidence: Math.max(50, confidence),
      triggeringRules: rules,
    };
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    const atrVal = _ctx.technicalAnalysis.indicators['ATR(14)']?.value;
    if (!atrVal) return direction === 'LONG' ? entry.times(0.995) : entry.times(1.005);
    const offset = atrVal.times(this.params.atrMultiplier);
    return direction === 'LONG' ? entry.minus(offset) : entry.plus(offset);
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal, stopLoss: Decimal): Decimal | null {
    const risk = entry.minus(stopLoss).abs();
    // Scalping: 1:1 risk/reward
    return direction === 'LONG' ? entry.plus(risk) : entry.minus(risk);
  },
};

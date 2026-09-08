import Decimal from 'decimal.js';
import config from '../shared/config';
import { Strategy, StrategyContext } from './types';
import { TradeSignal } from '../shared/types';

const noTrade = (reason: string): TradeSignal => ({
  signal: 'no_trade',
  strategyUsed: 'fundingArb',
  confidence: 0,
  triggeringRules: [reason],
});

/**
 * BMAD cash-and-carry funding arbitrage.
 *
 * Trigger requires a futures account and an annualised funding return that
 * comfortably exceeds round-trip execution costs plus estimated borrow cost.
 *
 * Annualised funding = |fundingRate| × fundingPeriodsPerYear
 * Net yield          = annualisedFunding - totalCostPct - borrowCostPct
 *
 * Stop loss is wide because the position is hedged; take profit assumes
 * partial basis convergence over one funding period.
 */
export const fundingArbStrategy: Strategy = {
  name: 'fundingArb',
  version: '1.1.0',
  description:
    'BMAD cash-and-carry funding arbitrage: long spot / short futures (or vice versa) to harvest funding when annualised yield exceeds all-in costs.',
  params: {
    minAnnualizedReturnPct: 0.06,
    fundingPeriodsPerYear: 1095, // 8h intervals
    takerFeePct: 0.001,
    slippagePct: 0.0005,
    borrowCostPct: 0.015,
    convergenceTargetPct: 0.001,
    stopLossPct: 0.03,
  },

  computeSignal(ctx: StrategyContext): TradeSignal {
    const { marketData, marketIntelligence } = ctx;
    const fundingRate = marketData.fundingRate?.fundingRate;

    if (!config.useFutures) {
      return noTrade('Funding arbitrage requires futures mode');
    }

    if (!fundingRate) return noTrade('Funding rate unavailable');

    if (marketIntelligence && marketIntelligence.tradeStance === 'defensive') {
      return noTrade('Market intelligence recommends defensive stance');
    }

    const annualizedFunding = fundingRate.abs().times(this.params.fundingPeriodsPerYear).toNumber();
    const totalCostPct = this.params.takerFeePct * 2 + this.params.slippagePct * 2;
    const netYield = annualizedFunding - totalCostPct - this.params.borrowCostPct;

    if (netYield < this.params.minAnnualizedReturnPct) {
      return noTrade(`Net funding yield ${(netYield * 100).toFixed(2)}% below threshold`);
    }

    const direction = fundingRate.gt(0) ? 'short' : 'long';
    // In cash-and-carry, the spot leg is opposite the futures leg; the signal
    // represents the futures direction that harvests the funding payment.
    const rules = [
      `Funding rate ${fundingRate.toFixed(6)}`,
      `Annualised ${(annualizedFunding * 100).toFixed(2)}%`,
      `All-in cost ${(totalCostPct * 100).toFixed(3)}%`,
      `Net yield ${(netYield * 100).toFixed(2)}%`,
    ];

    const confidence = Math.min(0.9, 0.5 + netYield * 4);
    return {
      signal: direction,
      strategyUsed: this.name,
      confidence: Math.round(confidence * 100),
      triggeringRules: rules,
    };
  },

  computeStopLoss(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal {
    const stopPct = this.params.stopLossPct;
    return direction === 'LONG' ? entry.times(1 - stopPct) : entry.times(1 + stopPct);
  },

  computeTakeProfit(_ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal | null {
    const tpPct = this.params.convergenceTargetPct;
    return direction === 'LONG' ? entry.times(1 + tpPct) : entry.times(1 - tpPct);
  },
};

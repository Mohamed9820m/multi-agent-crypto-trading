import Decimal from 'decimal.js';
import config from '../shared/config';
import logger from '../shared/logger';
import { activeStrategy } from '../strategies/playbook';
import { StrategyContext } from '../strategies/types';
import {
  AccountState,
  MarketData,
  RiskDecision,
  Side,
  StrategyCandidate,
  TechnicalAnalysis,
  TradeSignal,
} from '../shared/types';
import { riskRewardRatio } from '../shared/indicators';

export class RiskManagerAgent {
  async evaluate(
    signal: TradeSignal,
    marketData: MarketData,
    technicalAnalysis: TechnicalAnalysis,
    account: AccountState,
    candidate?: StrategyCandidate
  ): Promise<RiskDecision> {
    logger.info('RiskManagerAgent evaluating', { signal: signal.signal, confidence: signal.confidence });

    if (signal.signal === 'no_trade') {
      return { decision: 'veto', vetoReason: 'No trade signal' };
    }

    // Daily loss circuit breaker.
    const dailyLossPct = account.dailyRealizedPnlEUR.div(account.equityEUR).times(100);
    if (dailyLossPct.lte(-config.maxDailyLossPct)) {
      return {
        decision: 'veto',
        vetoReason: `Daily loss circuit breaker triggered: ${dailyLossPct.toFixed(2)}% <= -${config.maxDailyLossPct}%`,
      };
    }

    // Max trades per day.
    if (account.tradesToday >= config.maxTradesPerDay) {
      return {
        decision: 'veto',
        vetoReason: `Daily trade limit reached (${account.tradesToday}/${config.maxTradesPerDay})`,
      };
    }

    // Hard minimum confidence rule from Orchestrator config.
    if (signal.confidence < config.minConfidence) {
      return {
        decision: 'veto',
        vetoReason: `Confidence ${signal.confidence} below minimum ${config.minConfidence}`,
      };
    }

    // Max concurrent positions.
    const openCount = account.openPositions.filter((p) => p.status === 'open').length;
    if (openCount >= config.maxConcurrentPositions) {
      return {
        decision: 'veto',
        vetoReason: `Max concurrent positions reached (${openCount}/${config.maxConcurrentPositions})`,
      };
    }

    const direction: Side = signal.signal === 'long' ? 'LONG' : 'SHORT';
    const strategy = activeStrategy(signal.strategyUsed);

    // Entry price: weighted mid-price if order book available, else last close.
    const bestBid = marketData.orderBook.bids[0]?.price;
    const bestAsk = marketData.orderBook.asks[0]?.price;
    let entry: Decimal;
    if (bestBid && bestAsk) {
      entry = bestBid.plus(bestAsk).div(2);
    } else {
      entry = marketData.candles[marketData.candles.length - 1].close;
    }

    const strategyContext: StrategyContext = {
      symbol: marketData.symbol,
      timeframe: marketData.timeframe,
      marketData,
      technicalAnalysis,
      sentiment: { sentimentScore: 0, keyEvents: [], sources: [] },
    };

    const stopLoss = strategy.computeStopLoss(strategyContext, direction, entry);
    const takeProfit = strategy.computeTakeProfit(strategyContext, direction, entry, stopLoss);

    if (!takeProfit) {
      return { decision: 'veto', vetoReason: 'Strategy could not compute take-profit level' };
    }

    const rr = riskRewardRatio(entry, stopLoss, takeProfit, direction);
    const hasPositiveExpectancy = candidate && candidate.expectedValue.expectancyPerTrade > 0;

    if (!rr || rr.lt(config.minRiskReward)) {
      // Allow lower R:R if the strategy candidate has statistically positive expectancy.
      if (hasPositiveExpectancy && candidate!.expectedValue.expectancyPerTrade > config.kellyMinEdge) {
        logger.info('RiskManagerAgent allowing lower R:R due to positive expectancy', {
          rr: rr?.toFixed(2),
          expectancy: candidate!.expectedValue.expectancyPerTrade.toFixed(4),
        });
      } else {
        return {
          decision: 'veto',
          vetoReason: `Risk/reward ${rr?.toFixed(2) ?? 'n/a'} below minimum ${config.minRiskReward} and expectancy insufficient`,
        };
      }
    }

    const priceRisk = entry.minus(stopLoss).abs();
    if (priceRisk.eq(0)) {
      return { decision: 'veto', vetoReason: 'Zero price risk — invalid stop loss' };
    }

    // Capped Kelly sizing.
    // f* = (p*b - q) / b, where b = average win / average loss ≈ R:R.
    const p = candidate?.expectedValue.winProbability ?? 0.5;
    const b = rr?.toNumber() ?? 1;
    const q = 1 - p;
    let kellyFraction = b > 0 ? (p * b - q) / b : 0;
    kellyFraction = Math.max(0, Math.min(config.kellyCap, kellyFraction));

    if (kellyFraction < config.kellyMinEdge) {
      return {
        decision: 'veto',
        vetoReason: `Kelly fraction ${kellyFraction.toFixed(4)} below minimum edge ${config.kellyMinEdge}`,
      };
    }

    const baseRiskAmount = account.equityEUR.times(config.riskPerTradePct).div(100);
    let desiredRiskAmount = baseRiskAmount.times(kellyFraction);

    // Portfolio heat check: total open risk + new trade risk <= max heat.
    const currentHeat = account.openPositions.reduce((sum, p) => {
      const stop = p.stopLoss ?? p.entryPrice.times(0.95);
      return sum.plus(p.quantity.times(p.entryPrice.minus(stop).abs()));
    }, new Decimal(0));
    const maxHeat = account.equityEUR.times(config.maxPortfolioHeatPct).div(100);
    const projectedHeat = currentHeat.plus(desiredRiskAmount);

    if (projectedHeat.gt(maxHeat)) {
      const allowedRisk = maxHeat.minus(currentHeat);
      if (allowedRisk.lte(0)) {
        return {
          decision: 'veto',
          vetoReason: `Portfolio heat limit reached: current ${currentHeat.toFixed(2)} / max ${maxHeat.toFixed(2)} EUR`,
        };
      }
      logger.warn('RiskManagerAgent resizing position to fit portfolio heat', {
        desiredRisk: desiredRiskAmount.toFixed(2),
        allowedRisk: allowedRisk.toFixed(2),
      });
      desiredRiskAmount = allowedRisk;
    }

    let positionSize = desiredRiskAmount.div(priceRisk);

    if (!positionSize || positionSize.lte(0)) {
      return {
        decision: 'veto',
        vetoReason: 'Computed position size is zero or invalid',
      };
    }

    // Minimum notional sanity check (Binance spot minimum is ~5-10 USDT).
    const notional = positionSize.times(entry);
    if (notional.lt(10)) {
      return {
        decision: 'veto',
        vetoReason: `Position notional ${notional.toFixed(2)} USDT below exchange minimum (~10 USDT)`,
      };
    }

    // Ensure we do not exceed available cash.
    if (notional.gt(account.cashEUR)) {
      return {
        decision: 'veto',
        vetoReason: `Position notional ${notional.toFixed(2)} exceeds available cash ${account.cashEUR.toFixed(2)}`,
      };
    }

    // Correlation cap (simplified: only one position per symbol for now).
    const sameSymbolOpen = account.openPositions.some(
      (p) => p.symbol === marketData.symbol && p.status === 'open'
    );
    if (sameSymbolOpen) {
      return {
        decision: 'veto',
        vetoReason: `Existing open position in ${marketData.symbol}`,
      };
    }

    logger.info('RiskManagerAgent approved', {
      side: direction,
      entry: entry.toFixed(2),
      stopLoss: stopLoss.toFixed(2),
      takeProfit: takeProfit.toFixed(2),
      kellyFraction: kellyFraction.toFixed(4),
      positionSize: positionSize.toFixed(6),
      notional: notional.toFixed(2),
      portfolioHeat: `${currentHeat.toFixed(2)} / ${maxHeat.toFixed(2)} EUR`,
    });

    return {
      decision: 'approve',
      positionSize,
      entry,
      stopLoss,
      takeProfit,
      riskAmountPct: new Decimal(config.riskPerTradePct).times(kellyFraction),
    };
  }
}

export const riskManagerAgent = new RiskManagerAgent();
export default riskManagerAgent;

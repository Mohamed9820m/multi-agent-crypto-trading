import logger from '../shared/logger';
import { strategyRegistry } from '../strategies/playbook';
import { StrategyContext } from '../strategies/types';
import {
  MarketData,
  MarketIntelligence,
  MicrostructureAnalysis,
  RegimeProbabilities,
  SentimentOutput,
  StrategyAllocation,
  StrategyCandidate,
  TechnicalAnalysis,
  TradeDirection,
} from '../shared/types';
import { buildStrategyCandidate } from '../shared/expectedValue';
import { strategyLifecycleManager } from '../shared/strategyLifecycle';
import { strategyPerformanceTracker } from '../shared/strategyPerformanceTracker';

const SCORE_WEIGHTS = {
  regimeFit: 0.35,
  recentPerformance: 0.25,
  signalConfidence: 0.25,
  correlationPenalty: 0.1,
  switchingCost: 0.05,
};

const STRATEGIC_FIT: Record<string, Record<string, number>> = {
  trendFollowing: { STRONG_TREND: 1.0, BUILDING_TREND: 0.6, CLEAN_RANGE: 0, CHOPPY_VOLATILE: 0.2, RANDOM_WALK: 0.3 },
  momentumBreakout: { STRONG_TREND: 0.85, BUILDING_TREND: 0.9, CLEAN_RANGE: 0.1, CHOPPY_VOLATILE: 0.3, RANDOM_WALK: 0.3 },
  breakout: { STRONG_TREND: 0.5, BUILDING_TREND: 0.85, CLEAN_RANGE: 0.2, CHOPPY_VOLATILE: 0.2, RANDOM_WALK: 0.3 },
  meanReversion: { STRONG_TREND: 0, BUILDING_TREND: 0.1, CLEAN_RANGE: 1.0, CHOPPY_VOLATILE: 0.3, RANDOM_WALK: 0.4 },
  scalping: { STRONG_TREND: 0.4, BUILDING_TREND: 0.4, CLEAN_RANGE: 0.6, CHOPPY_VOLATILE: 0.85, RANDOM_WALK: 0.5 },
  grid: { STRONG_TREND: 0, BUILDING_TREND: 0.1, CLEAN_RANGE: 0.85, CHOPPY_VOLATILE: 0.2, RANDOM_WALK: 0.4 },
  gridTrading: { STRONG_TREND: 0, BUILDING_TREND: 0.1, CLEAN_RANGE: 0.85, CHOPPY_VOLATILE: 0.2, RANDOM_WALK: 0.4 },
  fundingArb: { STRONG_TREND: 0.6, BUILDING_TREND: 0.6, CLEAN_RANGE: 0.6, CHOPPY_VOLATILE: 0.6, RANDOM_WALK: 0.7 },
  statArb: { STRONG_TREND: 0.4, BUILDING_TREND: 0.4, CLEAN_RANGE: 0.5, CHOPPY_VOLATILE: 0.4, RANDOM_WALK: 0.85 },
  dca: { STRONG_TREND: 0.3, BUILDING_TREND: 0.3, CLEAN_RANGE: 0.3, CHOPPY_VOLATILE: 0.2, RANDOM_WALK: 0.3 },
  arbitrage: { STRONG_TREND: 0.4, BUILDING_TREND: 0.4, CLEAN_RANGE: 0.4, CHOPPY_VOLATILE: 0.4, RANDOM_WALK: 0.5 },
  marketMaking: { STRONG_TREND: 0.2, BUILDING_TREND: 0.2, CLEAN_RANGE: 0.5, CHOPPY_VOLATILE: 0.3, RANDOM_WALK: 0.4 },
};

const STUB_STRATEGIES = new Set(['dca', 'arbitrage', 'marketMaking']);

export class StrategySelectorAgent {
  private previousAllocation: StrategyAllocation[] = [];
  private regimeConfirmationCount = 0;
  private lastStrategicRegime = '';

  async select(
    marketData: MarketData,
    technicalAnalysis: TechnicalAnalysis,
    sentiment: SentimentOutput,
    regime: RegimeProbabilities,
    microstructure: MicrostructureAnalysis,
    marketIntelligence?: MarketIntelligence
  ): Promise<{ candidates: StrategyCandidate[]; selected: StrategyCandidate | null; allocations: StrategyAllocation[] }> {
    logger.info('StrategySelectorAgent evaluating all strategies');

    const ctx: StrategyContext = {
      symbol: marketData.symbol,
      timeframe: marketData.timeframe,
      marketData,
      technicalAnalysis,
      sentiment,
      regime,
      microstructure,
      marketIntelligence,
    };

    const candidates: StrategyCandidate[] = [];
    const rawScores: { strategy: string; direction: TradeDirection; score: number; signalConfidence: number }[] = [];

    // 1. Generate candidates for all strategies
    for (const strategy of Object.values(strategyRegistry)) {
      const allowed = await strategyLifecycleManager.canTrade(strategy.name, strategy.version);
      if (!allowed) {
        logger.debug('StrategySelectorAgent skipping strategy due to lifecycle state', { strategy: strategy.name });
        candidates.push(
          buildStrategyCandidate(strategy.name, 'no_trade', {
            entry: marketData.ticker24h.lastPrice,
            stop: marketData.ticker24h.lastPrice,
            takeProfit: null,
            regime,
            microstructure,
            sentiment,
            confidence: 0,
            evidence: ['Lifecycle state disabled'],
            counterArguments: [],
            invalidationConditions: [],
            timeHorizon: marketData.timeframe,
            marketData,
          })
        );
        continue;
      }

      const signal = strategy.computeSignal(ctx);
      const candidate = this.buildCandidate(strategy.name, signal, ctx, marketData, regime, microstructure, sentiment);
      candidates.push(candidate);

      if (signal.signal !== 'no_trade') {
        rawScores.push({
          strategy: strategy.name,
          direction: signal.signal,
          score: 0, // filled later
          signalConfidence: this.normalizeSignalConfidence(strategy.name, signal, technicalAnalysis),
        });
      }
    }

    // 2. Update regime confirmation hysteresis
    const currentStrategicRegime = regime.strategicRegime;
    if (currentStrategicRegime === this.lastStrategicRegime) {
      this.regimeConfirmationCount = Math.min(this.regimeConfirmationCount + 1, 5);
    } else {
      this.regimeConfirmationCount = 1;
      this.lastStrategicRegime = currentStrategicRegime;
    }
    const regimeConfirmed = this.regimeConfirmationCount >= 2;

    // 3. Score tradable candidates
    const performanceMap = new Map<string, Awaited<ReturnType<typeof strategyPerformanceTracker.getPerformance>>>();
    for (const s of rawScores) {
      performanceMap.set(s.strategy, await strategyPerformanceTracker.getPerformance(s.strategy));
    }

    for (const item of rawScores) {
      const perf = performanceMap.get(item.strategy)!;
      const fit = this.regimeFit(item.strategy, regime);
      const perfScore = this.recentPerformanceScore(perf);
      const conf = item.signalConfidence;
      const corrPenalty = this.correlationPenalty(item, rawScores);
      const switchPenalty = this.switchingCost(item.strategy, item.direction, regimeConfirmed);

      item.score =
        SCORE_WEIGHTS.regimeFit * fit +
        SCORE_WEIGHTS.recentPerformance * perfScore +
        SCORE_WEIGHTS.signalConfidence * conf -
        SCORE_WEIGHTS.correlationPenalty * corrPenalty -
        SCORE_WEIGHTS.switchingCost * switchPenalty;

      // Hard veto: real mismatch scores 0
      if (fit === 0) {
        item.score = 0;
      }

      // Update candidate score for logging
      const cand = candidates.find((c) => c.strategy === item.strategy && c.direction === item.direction);
      if (cand) {
        cand.score = Math.max(0, item.score);
        cand.regimeFit = fit;
      }
    }

    // 4. Allocate capital across top-N non-vetoed strategies
    const allocations = this.allocate(rawScores);

    // 5. Pick the highest-weighted directional candidate as "selected"
    const selected = this.selectFromAllocations(candidates, allocations);

    logger.info('StrategySelectorAgent result', {
      evaluated: candidates.length,
      strategicRegime: regime.strategicRegime,
      selected: selected?.strategy ?? 'none',
      score: selected ? Number(selected.score.toFixed(4)) : 0,
      allocations: allocations.map((a) => ({ strategy: a.strategy, allocation: Number(a.allocation.toFixed(3)) })),
    });

    this.previousAllocation = allocations;

    return { candidates, selected, allocations };
  }

  private buildCandidate(
    strategyName: string,
    signal: { signal: TradeDirection; confidence: number; triggeringRules: string[] },
    ctx: StrategyContext,
    marketData: MarketData,
    regime: RegimeProbabilities,
    microstructure: MicrostructureAnalysis,
    sentiment: SentimentOutput
  ): StrategyCandidate {
    if (signal.signal === 'no_trade') {
      return buildStrategyCandidate(strategyName, 'no_trade', {
        entry: marketData.ticker24h.lastPrice,
        stop: marketData.ticker24h.lastPrice,
        takeProfit: null,
        regime,
        microstructure,
        sentiment,
        confidence: 0,
        evidence: signal.triggeringRules,
        counterArguments: [],
        invalidationConditions: [],
        timeHorizon: marketData.timeframe,
        marketData,
      });
    }

    const strategy = strategyRegistry[strategyName];
    const entry = marketData.ticker24h.lastPrice;
    const stopLoss = strategy.computeStopLoss(ctx, signal.signal === 'long' ? 'LONG' : 'SHORT', entry);
    const takeProfit = strategy.computeTakeProfit(
      ctx,
      signal.signal === 'long' ? 'LONG' : 'SHORT',
      entry,
      stopLoss
    );

    return buildStrategyCandidate(strategyName, signal.signal, {
      entry,
      stop: stopLoss,
      takeProfit,
      regime,
      microstructure,
      sentiment,
      confidence: signal.confidence,
      evidence: signal.triggeringRules,
      counterArguments: [`Counter: ${signal.signal === 'long' ? 'bearish' : 'bullish'} adverse move possible.`],
      invalidationConditions: ['Stop loss triggered.', 'Regime shifts against thesis.', 'Order flow reverses sharply.'],
      timeHorizon: marketData.timeframe,
      marketData,
    });
  }

  private normalizeSignalConfidence(strategyName: string, signal: { signal: TradeDirection; confidence: number }, _ta: TechnicalAnalysis): number {
    // Scale raw confidence (0-100) to 0-1, with strategy-specific awareness.
    const base = Math.max(0, Math.min(100, signal.confidence)) / 100;

    // Stubs never have real confidence; require explicit config.
    if (STUB_STRATEGIES.has(strategyName)) return 0;

    // For gridTrading, require range regime.
    if (strategyName === 'gridTrading') {
      return base * 0.5; // heavily penalize until config is added
    }

    return base;
  }

  private regimeFit(strategyName: string, regime: RegimeProbabilities): number {
    const map = STRATEGIC_FIT[strategyName] ?? { RANDOM_WALK: 0.3 };
    return map[regime.strategicRegime] ?? 0.3;
  }

  private recentPerformanceScore(perf: { trades: number; winRate: number; sharpe: number | null; kellyFraction: number | null }): number {
    if (perf.trades === 0) return 0.5; // neutral until history exists
    if (perf.trades < 10) return 0.45 + perf.winRate * 0.1; // slight discount

    // Combine win rate and Sharpe; require Kelly positive for high score.
    let score = perf.winRate;
    if (perf.sharpe !== null) {
      score = score * 0.6 + Math.min(1, Math.max(0, (perf.sharpe + 1) / 3)) * 0.4;
    }
    if (perf.kellyFraction !== null && perf.kellyFraction <= 0) {
      score *= 0.3; // heavy penalty if Kelly is negative
    }
    return Math.max(0, Math.min(1, score));
  }

  private correlationPenalty(item: { strategy: string; direction: TradeDirection }, all: { strategy: string; direction: TradeDirection }[]): number {
    // Count how many other active strategies are making the same directional bet.
    const sameDirection = all.filter(
      (o) => o.strategy !== item.strategy && o.direction === item.direction
    ).length;
    return Math.min(0.6, sameDirection * 0.25);
  }

  private switchingCost(strategyName: string, direction: TradeDirection, regimeConfirmed: boolean): number {
    const previous = this.previousAllocation.find(
      (a) => a.strategy === strategyName && a.direction === direction && a.allocation > 0
    );
    if (!previous) return 0;
    // If regime is confirmed, no switching cost for staying; if unconfirmed, small penalty for changing.
    return regimeConfirmed ? 0 : 0.15;
  }

  private allocate(rawScores: { strategy: string; direction: TradeDirection; score: number }[]): StrategyAllocation[] {
    const tradable = rawScores.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    if (tradable.length === 0) return [];

    // Take top 3, weight by score, normalize.
    const topN = tradable.slice(0, 3);
    const totalScore = topN.reduce((a, b) => a + b.score, 0);
    if (totalScore === 0) return [];

    const allocations = topN.map((s) => ({
      strategy: s.strategy,
      direction: s.direction,
      score: s.score,
      allocation: s.score / totalScore,
    }));

    // Ramp allocation changes over time if previous allocation exists.
    if (this.previousAllocation.length > 0) {
      const ramped = allocations.map((a) => {
        const prev = this.previousAllocation.find((p) => p.strategy === a.strategy)?.allocation ?? 0;
        return { ...a, allocation: prev + (a.allocation - prev) * 0.5 };
      });
      const total = ramped.reduce((a, b) => a + b.allocation, 0);
      return ramped.map((a) => ({ ...a, allocation: total > 0 ? a.allocation / total : 0 }));
    }

    return allocations;
  }

  private selectFromAllocations(candidates: StrategyCandidate[], allocations: StrategyAllocation[]): StrategyCandidate | null {
    if (allocations.length === 0) return null;
    const top = allocations.reduce((a, b) => (a.allocation > b.allocation ? a : b));
    return candidates.find((c) => c.strategy === top.strategy && c.direction === top.direction) ?? null;
  }
}

export const strategySelectorAgent = new StrategySelectorAgent();
export default strategySelectorAgent;

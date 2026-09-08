import { randomUUID } from 'crypto';
import config from '../shared/config';
import db from '../shared/db';
import logger from '../shared/logger';
import Decimal from 'decimal.js';
import { ExpandedCycleLog, TradeSignal } from '../shared/types';
import executionAgent, { ExecutionHaltedError, ExecutionRequest } from './execution';
import marketDataAgent from './marketData';
import redisBus from '../shared/redisBus';
import riskManagerAgent from './riskManager';
import sentimentAgent from './sentiment';
import technicalAnalysisAgent from './technicalAnalysis';
import { loadAccountState, snapshotAccount } from '../shared/accountState';
import { computeFeatureVector } from '../shared/featureEngineering';
import featureStore from '../shared/featureStore';
import mlPredictor from '../shared/mlLayer';
import { pairDiscoveryCache } from '../shared/pairDiscoveryCache';
import { buildEnsemble } from '../shared/strategyEnsemble';
import regimeDetectionAgent from './regimeDetection';
import marketMicrostructureAgent from './marketMicrostructure';
import strategySelectorAgent from './strategySelector';
import redTeamAgent from './redTeam';
import portfolioManagerAgent from './portfolioManager';
import circuitBreakerAgent from './circuitBreaker';
import researchMemoryAgent from './researchMemory';
import { aggregateVotes, buildVotes } from './votingAggregator';
import researchAIAgent from './researchAI';
import marketIntelligenceAgent from './marketIntelligence';

export class Orchestrator {
  private halted = false;

  async runOnce(): Promise<ExpandedCycleLog> {
    if (this.halted) {
      logger.warn('Orchestrator halted — skipping cycle');
      return this.emptyLog('Orchestrator halted by prior kill signal');
    }

    // Check Guardian kill switch independently.
    const killSwitch = await redisBus.get<{ triggered: boolean; reason: string }>('guardian:kill_switch');
    if (killSwitch?.triggered) {
      this.halted = true;
      logger.error('Guardian kill switch active — halting', killSwitch);
      return this.emptyLog(`Guardian kill switch: ${killSwitch.reason}`);
    }

    const cycleId = randomUUID();
    const startedAt = new Date();
    const log: ExpandedCycleLog = {
      cycleId,
      symbol: config.symbol,
      timeframe: config.timeframe,
      startedAt,
      errors: [],
    };

    logger.info('Orchestrator starting cycle', { cycleId });

    try {
      // 1. Market Data
      const marketData = await marketDataAgent.fetch(config.symbol, config.timeframe);
      log.marketData = marketData;

      const criticalFlags = marketData.dataQualityFlags.filter(
        (f) => f.type === 'gap' || f.type === 'stale'
      );
      if (criticalFlags.length > 0) {
        const reason = `Critical data quality flags: ${criticalFlags.map((f) => f.message).join('; ')}`;
        logger.warn('Orchestrator stopping cycle due to data quality', { reason });
        log.errors!.push(reason);
        await this.persistLog(log);
        return log;
      }

      // 2. Technical Analysis
      const technicalAnalysis = await technicalAnalysisAgent.analyze(
        marketData.candles,
        config.activeStrategy
      );
      log.technicalAnalysis = technicalAnalysis;

      // 3. Regime Detection
      const regime = regimeDetectionAgent.analyze(marketData.candles);

      // 4. Market Microstructure
      const microstructure = marketMicrostructureAgent.analyze(
        marketData,
        marketData.candles.slice(-20)
      );

      // 4b. Market Intelligence (BMAD snapshot + directional verdict)
      const marketIntelligence = await marketIntelligenceAgent.analyze({
        symbol: config.symbol,
        timeframe: config.timeframe,
        marketData,
        regime,
        microstructure,
        technicalAnalysis,
      });
      log.marketIntelligence = marketIntelligence;
      log.specialistAnalysis = { ...log.specialistAnalysis, marketIntelligence };

      // 5. Sentiment
      const sentiment = await sentimentAgent.assess(config.symbol);
      log.sentiment = sentiment;

      // 5b. Feature engineering & feature store
      const lastCandle = marketData.candles[marketData.candles.length - 1];
      const features = computeFeatureVector({
        symbol: config.symbol,
        candles: marketData.candles,
        close: lastCandle.close,
        volume: lastCandle.volume,
        spreadPct: microstructure.orderBook.spreadPct,
        bidAskImbalance: microstructure.orderBook.bidAskImbalance,
        orderFlowImbalance: microstructure.orderFlow.orderFlowImbalance,
        fundingRate: marketData.fundingRate?.fundingRate,
        sentimentScore: sentiment.sentimentScore,
        newsIntensity: sentiment.keyEvents.length,
        volatilityPercentile: (regime.features.volatilityPercentile ?? 0.5) / 100,
        trendStrength: (regime.features.trendStrength ?? 0) / 100,
        regime: regime.dominantRegime,
      });
      await featureStore.persist(cycleId, config.symbol, features);

      const mlEstimate = await mlPredictor.trainAndPredict(config.symbol, features);
      logger.info('ML layer estimate', { estimate: mlEstimate });

      log.specialistAnalysis = {
        regime,
        microstructure,
      };

      // 6. Refresh pair discovery cache for statistical arbitrage.
      await pairDiscoveryCache.refresh(config.symbol);

      // 7. Strategy Selection (evaluates all strategies, scores them)
      const { candidates, selected, allocations } = await strategySelectorAgent.select(
        marketData,
        technicalAnalysis,
        sentiment,
        regime,
        microstructure,
        marketIntelligence
      );
      log.strategyCandidates = candidates;
      log.selectedCandidate = selected ?? undefined;
      log.strategyAllocations = allocations;

      if (!selected || selected.direction === 'no_trade') {
        logger.info('Orchestrator: no viable strategy candidate');
        await snapshotAccount(await loadAccountState());
        log.completedAt = new Date();
        await this.persistLog(log);
        return log;
      }

      // Strategy ensemble: detect correlated clusters and direction conflicts.
      const ensemble = buildEnsemble(candidates);
      if (ensemble) {
        if (ensemble.direction !== selected.direction) {
          logger.warn('Strategy ensemble conflicts with selected candidate', {
            ensemble: ensemble.direction,
            selected: selected.direction,
          });
          selected.statisticalConfidence *= 0.85;
        }
        if (ensemble.correlationRisk === 'high') {
          logger.warn('Strategy ensemble has high correlation risk');
          selected.statisticalConfidence *= 0.85;
        }
      }

      // New institutional gates
      if (selected.score < 0.35) {
        const reason = `Best candidate score ${selected.score.toFixed(3)} below threshold 0.35`;
        logger.info('Orchestrator vetoing low-score candidate', { reason });
        log.riskDecision = { decision: 'veto', vetoReason: reason };
        log.completedAt = new Date();
        await this.persistLog(log);
        return log;
      }

      if (selected.expectedValue.expectedValuePct <= 0) {
        const reason = `Expected value ${selected.expectedValue.expectedValuePct.toFixed(4)}% is non-positive after costs`;
        logger.info('Orchestrator vetoing non-positive EV candidate', { reason });
        log.riskDecision = { decision: 'veto', vetoReason: reason };
        log.completedAt = new Date();
        await this.persistLog(log);
        return log;
      }

      // 7. Red Team challenge
      const redTeam = redTeamAgent.challenge(selected, {
        spreadPct: microstructure.orderBook.spreadPct,
        dataQualityFlags: marketData.dataQualityFlags,
      });
      log.specialistAnalysis = { ...log.specialistAnalysis, redTeam };

      if (redTeam.recommendation === 'reject') {
        const reason = `Red team rejected: ${redTeam.attacks.map((a) => `${a.area}(${a.severity})`).join(', ')}`;
        logger.info('Orchestrator vetoing after red-team challenge', { reason });
        log.riskDecision = { decision: 'veto', vetoReason: reason };
        log.completedAt = new Date();
        await this.persistLog(log);
        return log;
      }

      if (redTeam.recommendation === 'caution') {
        logger.warn('Red team flagged caution; reducing candidate confidence');
        selected.statisticalConfidence *= 0.85;
      }

      // 7b. Portfolio context for Research AI and downstream checks.
      const account = await loadAccountState();
      const proposedNotional = selected.expectedValue.expectedValuePct > 0
        ? account.equityEUR.times(config.riskPerTradePct / 100).div(selected.entry.minus(selected.stop).abs().div(selected.entry).toNumber())
        : new Decimal(0);
      const portfolio = portfolioManagerAgent.analyze(account, {
        symbol: config.symbol,
        side: selected.direction === 'long' ? 'LONG' : 'SHORT',
        notionalEUR: proposedNotional,
        strategy: selected.strategy,
      });
      log.specialistAnalysis = { ...log.specialistAnalysis, portfolio };

      // 7c. External Research AI / CLAWBOT analysis (before voting so it can inform consensus).
      const researchAI = await researchAIAgent.analyze({
        symbol: config.symbol,
        timeframe: config.timeframe,
        regime,
        microstructure,
        technicalAnalysis,
        candidates,
        portfolioState: portfolio,
      });
      logger.info('Research AI recommendation', { researchAI });

      if (researchAI.recommendedAction === 'NO_TRADE' || researchAI.recommendedAction === 'EXIT') {
        const reason = `Research AI recommends ${researchAI.recommendedAction}: ${researchAI.riskFactors.join('; ')}`;
        logger.info('Orchestrator vetoing on external research AI recommendation', { reason });
        log.riskDecision = { decision: 'veto', vetoReason: reason };
        log.completedAt = new Date();
        await this.persistLog(log);
        return log;
      }

      if (researchAI.recommendedAction.includes('SMALL') || researchAI.recommendedAction === 'WAIT' || researchAI.recommendedAction === 'HEDGE') {
        logger.warn('Research AI flagged caution; reducing candidate confidence');
        selected.statisticalConfidence *= 0.9;
      }

      // Multi-agent voting aggregator.
      const voteResult = aggregateVotes(
        buildVotes({
          candidate: selected,
          regime,
          microstructure,
          technicalAnalysis,
          sentiment,
          researchAI,
        })
      );
      log.specialistAnalysis = { ...log.specialistAnalysis, votes: voteResult.votes };

      if (voteResult.decision === 'reject') {
        const reason = `Multi-agent voting rejected: consensus ${voteResult.consensusSignal}, concerns ${voteResult.concerns.join('; ')}`;
        logger.info('Orchestrator vetoing after multi-agent vote', { reason });
        log.riskDecision = { decision: 'veto', vetoReason: reason };
        log.completedAt = new Date();
        await this.persistLog(log);
        return log;
      }

      if (voteResult.decision === 'caution') {
        logger.warn('Multi-agent voting flagged caution; reducing candidate confidence');
        selected.statisticalConfidence *= 0.9;
      }

      // ML layer override: strong NO_EDGE estimate reduces confidence.
      if (mlEstimate.prediction === 'NO_EDGE' && mlEstimate.confidence > 0.7) {
        logger.warn('ML layer reports no edge with high confidence; reducing candidate confidence');
        selected.statisticalConfidence *= 0.8;
      }
      if (
        (mlEstimate.prediction === 'LONG' && selected.direction === 'short') ||
        (mlEstimate.prediction === 'SHORT' && selected.direction === 'long')
      ) {
        logger.warn('ML layer direction conflicts with selected candidate; reducing confidence');
        selected.statisticalConfidence *= 0.85;
      }

      await researchMemoryAgent.recordCandidateEvaluation(
        config.symbol,
        selected.strategy,
        regime.dominantRegime,
        selected.score,
        selected.expectedValue.expectedValuePct,
        'candidate_selected'
      );

      // 8. Portfolio limits
      const portfolioCheck = portfolioManagerAgent.checkLimits(portfolio, {
        maxGrossExposurePct: 2.0,
        maxNetExposurePct: 1.5,
        maxSymbolConcentrationPct: 1.0,
      });
      if (!portfolioCheck.approved) {
        logger.info('Orchestrator vetoing due to portfolio limits', { reason: portfolioCheck.reason });
        log.riskDecision = { decision: 'veto', vetoReason: portfolioCheck.reason };
        await this.persistLog(log);
        return log;
      }

      // 8b. Circuit breakers
      const cb = circuitBreakerAgent.check(account, marketData, portfolio);
      if (cb.triggered && cb.severity === 'critical') {
        logger.error('Circuit breaker triggered — halting', { reason: cb.reason });
        this.halted = true;
        log.errors!.push(`Circuit breaker: ${cb.reason}`);
        log.completedAt = new Date();
        await this.persistLog(log);
        return log;
      }
      if (cb.triggered) {
        logger.warn('Circuit breaker warning', { reason: cb.reason });
      }

      // Convert selected candidate to legacy TradeSignal for risk/execution path.
      const signal: TradeSignal = {
        signal: selected.direction,
        strategyUsed: selected.strategy,
        confidence: Math.round(selected.statisticalConfidence * 100),
        triggeringRules: selected.evidence,
      };
      log.signal = signal;

      // Hard rule: ignore low-confidence signals.
      if (signal.confidence < config.minConfidence) {
        const reason = `Signal confidence ${signal.confidence} below minimum ${config.minConfidence}`;
        logger.info('Orchestrator vetoing low-confidence signal', { reason });
        log.riskDecision = { decision: 'veto', vetoReason: reason };
        log.completedAt = new Date();
        await this.persistLog(log);
        return log;
      }

      // 9. Risk Manager
      const riskDecision = await riskManagerAgent.evaluate(
        signal,
        marketData,
        technicalAnalysis,
        account,
        selected
      );
      log.riskDecision = riskDecision;

      if (riskDecision.decision === 'veto') {
        logger.info('Orchestrator respecting Risk Manager veto', { reason: riskDecision.vetoReason });
        await this.persistLog(log);
        return log;
      }

      // 10. Execution
        const executionRequest: ExecutionRequest = {
          cycleId,
          symbol: config.symbol,
          side: signal.signal === 'long' ? 'LONG' : 'SHORT',
          strategy: signal.strategyUsed,
          entry: riskDecision.entry!,
          stopLoss: riskDecision.stopLoss!,
          takeProfit: riskDecision.takeProfit!,
          positionSize: riskDecision.positionSize!,
          riskDecision,
        };
      const executionResults = await executionAgent.execute(executionRequest, marketData);
      log.execution = executionResults;

      await snapshotAccount(await loadAccountState());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Orchestrator cycle error', { cycleId, err: message });
      log.errors!.push(message);

      if (err instanceof ExecutionHaltedError) {
        this.halted = true;
        await redisBus.set('guardian:kill_switch', {
          triggered: true,
          reason: `Execution halted: ${message}`,
        });
        logger.error('Orchestrator halted due to execution failure', { reason: message });
      }
    }

    log.completedAt = new Date();
    await this.persistLog(log);
    logger.info('Orchestrator cycle complete', { cycleId, completedAt: log.completedAt });
    return log;
  }

  async runLoop(): Promise<void> {
    logger.info('Orchestrator entering run loop', { intervalMs: config.cycleIntervalMs });
    while (!this.halted) {
      await this.runOnce();
      await this.sleep(config.cycleIntervalMs);
    }
  }

  halt(): void {
    this.halted = true;
  }

  private emptyLog(error: string): ExpandedCycleLog {
    return {
      cycleId: randomUUID(),
      symbol: config.symbol,
      timeframe: config.timeframe,
      startedAt: new Date(),
      completedAt: new Date(),
      errors: [error],
    };
  }

  private async persistLog(log: ExpandedCycleLog): Promise<void> {
    try {
      await db.query(
        `INSERT INTO cycle_logs (cycle_id, symbol, timeframe, started_at, completed_at, orchestrator_output)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (cycle_id) DO UPDATE SET completed_at = EXCLUDED.completed_at, orchestrator_output = EXCLUDED.orchestrator_output`,
        [
          log.cycleId,
          log.symbol,
          log.timeframe,
          log.startedAt,
          log.completedAt ?? null,
          JSON.stringify(this.serializeLog(log)),
        ]
      );
    } catch (err) {
      logger.error('Failed to persist cycle log', { cycleId: log.cycleId, err });
    }
  }

  private serializeLog(log: ExpandedCycleLog): Record<string, unknown> {
    return {
      ...log,
      marketData: log.marketData
        ? {
            ...log.marketData,
            candles: log.marketData.candles.slice(-5),
          }
        : undefined,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const orchestrator = new Orchestrator();
export default orchestrator;

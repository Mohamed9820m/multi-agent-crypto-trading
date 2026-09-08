import logger from '../shared/logger';
import { activeStrategy } from '../strategies/playbook';
import { StrategyContext } from '../strategies/types';
import { MarketData, SentimentOutput, TechnicalAnalysis, TradeSignal } from '../shared/types';

export class StrategyFusionAgent {
  async fuse(
    marketData: MarketData,
    technicalAnalysis: TechnicalAnalysis,
    sentiment: SentimentOutput,
    strategyName: string
  ): Promise<TradeSignal> {
    logger.info('StrategyFusionAgent fusing', { strategy: strategyName });

    const strategy = activeStrategy(strategyName);
    const ctx: StrategyContext = {
      symbol: marketData.symbol,
      timeframe: marketData.timeframe,
      marketData,
      technicalAnalysis,
      sentiment,
    };

    const signal = strategy.computeSignal(ctx);

    logger.info('StrategyFusionAgent result', {
      signal: signal.signal,
      confidence: signal.confidence,
      rules: signal.triggeringRules,
    });

    return signal;
  }
}

export const strategyFusionAgent = new StrategyFusionAgent();
export default strategyFusionAgent;

import Decimal from 'decimal.js';
import { MarketRegime, PostTradeForensics, Position, TradeDirection } from '../shared/types';
import researchMemoryAgent from './researchMemory';

export class PostTradeForensicsAgent {
  async analyze(
    position: Position,
    exitPrice: Decimal,
    feesEUR: Decimal,
    slippagePct: number,
    regime: MarketRegime,
    expectedEdgeAtEntry: string
  ): Promise<PostTradeForensics> {
    const realizedPnlPct = position.side === 'LONG'
      ? exitPrice.minus(position.entryPrice).div(position.entryPrice).toNumber()
      : position.entryPrice.minus(exitPrice).div(position.entryPrice).toNumber();

    const realizedPnlEUR = position.entryPrice
      .times(position.quantity)
      .times(realizedPnlPct)
      .minus(feesEUR);

    const direction: TradeDirection = position.side === 'LONG' ? 'long' : 'short';
    const thesisFailed = realizedPnlPct < 0;
    const executionFailed = Math.abs(slippagePct) > 0.001;
    const modelFailed = thesisFailed && !executionFailed;
    const newsInvalidated = false; // Would require news agent input

    const lessons: string[] = [];
    if (executionFailed) lessons.push('Execution slippage exceeded threshold.');
    if (modelFailed) lessons.push('Model thesis failed; review signal quality for this regime.');
    if (regime === 'UNCERTAIN') lessons.push('Trade executed during uncertain regime.');
    if (realizedPnlPct > 0 && executionFailed) {
      lessons.push('Trade was profitable despite execution slippage.');
    }

    const forensics: PostTradeForensics = {
      positionId: position.positionId,
      symbol: position.symbol,
      strategy: position.strategy ?? 'unknown',
      direction,
      entryPrice: position.entryPrice,
      exitPrice,
      realizedPnlPct,
      realizedPnlEUR,
      feesEUR,
      slippagePct,
      expectedEdgeAtEntry,
      actualOutcome: realizedPnlPct >= 0 ? 'profit' : 'loss',
      marketRegime: regime,
      thesisFailed,
      executionFailed,
      modelFailed,
      newsInvalidated,
      lessons,
    };

    for (const lesson of lessons) {
      await researchMemoryAgent.recordLesson(
        position.symbol,
        position.strategy ?? 'unknown',
        regime,
        lesson,
        0.6
      );
    }

    return forensics;
  }
}

export const postTradeForensicsAgent = new PostTradeForensicsAgent();
export default postTradeForensicsAgent;

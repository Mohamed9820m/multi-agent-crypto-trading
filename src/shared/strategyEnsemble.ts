import Decimal from 'decimal.js';
import logger from './logger';
import { StrategyCandidate, TradeDirection } from './types';

export interface EnsembleDecision {
  direction: TradeDirection;
  entry: Decimal;
  stop: Decimal;
  takeProfit: Decimal | null;
  confidence: number;
  score: number;
  contributors: string[];
  evidence: string[];
  counterArguments: string[];
  correlationRisk: 'low' | 'medium' | 'high';
}

/**
 * Build an ensemble decision from the top strategy candidates.
 * Correlated strategies are down-weighted so five bullish momentum strategies
 * do not produce five independent votes.
 */
export function buildEnsemble(candidates: StrategyCandidate[], topK = 3): EnsembleDecision | null {
  const tradable = candidates
    .filter((c) => c.direction !== 'no_trade' && c.expectedValue.expectedValuePct > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (tradable.length === 0) return null;

  // Group by direction.
  const groups: Record<string, StrategyCandidate[]> = {
    long: [],
    short: [],
  };
  for (const c of tradable) {
    groups[c.direction].push(c);
  }

  const longScore = weightedGroupScore(groups.long);
  const shortScore = weightedGroupScore(groups.short);

  const chosenGroup = longScore >= shortScore ? groups.long : groups.short;
  const direction: TradeDirection = longScore >= shortScore ? 'long' : 'short';

  if (chosenGroup.length === 0) return null;

  const weights = chosenGroup.map((c) => c.score);

  const entry = weightedDecimal(chosenGroup.map((c) => c.entry), weights);
  const stop = weightedDecimal(chosenGroup.map((c) => c.stop), weights);
  const takeProfits = chosenGroup.map((c) => c.takeProfit).filter((tp): tp is Decimal => tp !== null);
  const takeProfit = takeProfits.length > 0 ? weightedDecimal(takeProfits, weights.slice(0, takeProfits.length)) : null;

  const confidence = weightedMean(
    chosenGroup.map((c) => c.statisticalConfidence),
    weights
  );
  const score = weightedMean(chosenGroup.map((c) => c.score), weights);

  const contributors = chosenGroup.map((c) => c.strategy);
  const evidence = Array.from(new Set(chosenGroup.flatMap((c) => c.evidence))).slice(0, 10);
  const counterArguments = Array.from(new Set(chosenGroup.flatMap((c) => c.counterArguments))).slice(0, 5);

  const correlationRisk = chosenGroup.length > 1 ? estimateCorrelationRisk(chosenGroup) : 'low';

  logger.info('Strategy ensemble built', {
    direction,
    contributors,
    confidence: Number(confidence.toFixed(4)),
    score: Number(score.toFixed(4)),
    correlationRisk,
  });

  return {
    direction,
    entry,
    stop,
    takeProfit,
    confidence,
    score,
    contributors,
    evidence,
    counterArguments,
    correlationRisk,
  };
}

function weightedGroupScore(group: StrategyCandidate[]): number {
  if (group.length === 0) return 0;
  // Down-weight correlated strategies: second+ candidate contributes at most 60% of its score.
  let score = 0;
  for (let i = 0; i < group.length; i++) {
    const factor = i === 0 ? 1 : 0.6;
    score += group[i].score * factor;
  }
  return score;
}

function weightedMean(values: number[], weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] * (weights[i] ?? 0);
  }
  return sum / total;
}

function weightedDecimal(values: Decimal[], weights: number[]): Decimal {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let sum = new Decimal(0);
  for (let i = 0; i < values.length; i++) {
    sum = sum.plus(values[i].times(weights[i] ?? 0));
  }
  return sum.div(total);
}

function estimateCorrelationRisk(group: StrategyCandidate[]): 'low' | 'medium' | 'high' {
  // Heuristic: if multiple strategies share similar evidence keywords, treat them as correlated.
  const keywords = group.flatMap((c) => c.evidence);
  const unique = new Set(keywords);
  const overlap = keywords.length > 0 ? 1 - unique.size / keywords.length : 0;
  if (overlap > 0.5) return 'high';
  if (overlap > 0.25) return 'medium';
  return 'low';
}

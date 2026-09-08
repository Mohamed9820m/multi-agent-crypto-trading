import logger from '../shared/logger';
import {
  MarketRegime,
  MicrostructureAnalysis,
  RegimeProbabilities,
  SentimentOutput,
  StrategyCandidate,
  StrategyVote,
  TechnicalAnalysis,
  TradeDirection,
} from '../shared/types';
import { ResearchAIResponse } from './researchAI';

export interface VotingContext {
  candidate: StrategyCandidate;
  regime: RegimeProbabilities;
  microstructure: MicrostructureAnalysis;
  technicalAnalysis: TechnicalAnalysis;
  sentiment: SentimentOutput;
  researchAI?: ResearchAIResponse;
}

export interface VotingResult {
  consensusSignal: TradeDirection;
  consensusConfidence: number; // 0-1
  weightedEdge: number;
  agreementScore: number; // 0-1, high = agents agree
  concerns: string[];
  decision: 'proceed' | 'caution' | 'reject';
  votes: StrategyVote[];
}

/**
 * Build independent votes from specialist agents.
 */
export function buildVotes(ctx: VotingContext): StrategyVote[] {
  const votes: StrategyVote[] = [];
  const direction = ctx.candidate.direction;

  // Regime vote: aligned if regime supports the candidate's direction.
  const regimeVote = voteFromRegime(ctx.regime, direction);
  votes.push({ agent: 'regime_detection', ...regimeVote });

  // Microstructure vote.
  const microVote = voteFromMicrostructure(ctx.microstructure, direction);
  votes.push({ agent: 'market_microstructure', ...microVote });

  // Technical vote.
  const techVote = voteFromTechnical(ctx.technicalAnalysis, direction);
  votes.push({ agent: 'technical_quant', ...techVote });

  // Sentiment vote.
  const sentimentVote = voteFromSentiment(ctx.sentiment, direction);
  votes.push({ agent: 'sentiment', ...sentimentVote });

  // Strategy selector vote (the candidate itself).
  votes.push({
    agent: 'strategy_selector',
    signal: direction,
    confidence: ctx.candidate.statisticalConfidence,
    expectedEdge: ctx.candidate.expectedValue.expectedValuePct,
    failureConditions: ctx.candidate.invalidationConditions,
    timeHorizon: ctx.candidate.timeHorizon,
  });

  // Red team vote (adversarial).
  votes.push({
    agent: 'red_team',
    signal: direction === 'long' ? 'short' : direction === 'short' ? 'long' : 'no_trade',
    confidence: 0.55,
    expectedEdge: -ctx.candidate.expectedValue.expectedValuePct,
    failureConditions: ctx.candidate.counterArguments,
    timeHorizon: ctx.candidate.timeHorizon,
  });

  // External Research AI / CLAWBOT vote.
  if (ctx.researchAI) {
    votes.push(voteFromResearchAI(ctx.researchAI, direction));
  }

  return votes;
}

function voteFromResearchAI(
  researchAI: ResearchAIResponse,
  candidateDirection: TradeDirection
): StrategyVote {
  const action = researchAI.recommendedAction;
  let signal: TradeDirection = 'no_trade';
  if (action.includes('BUY')) signal = 'long';
  else if (action.includes('SELL')) signal = 'short';

  const aligned = signal === candidateDirection;
  const confidence = aligned ? researchAI.confidence : researchAI.confidence * 0.8;

  return {
    agent: 'research_ai',
    signal,
    confidence,
    expectedEdge: researchAI.expectedEdge,
    failureConditions: researchAI.riskFactors.concat(researchAI.invalidationConditions),
    timeHorizon: 'medium',
  };
}

export function aggregateVotes(votes: StrategyVote[]): VotingResult {
  if (votes.length === 0) {
    return {
      consensusSignal: 'no_trade',
      consensusConfidence: 0,
      weightedEdge: 0,
      agreementScore: 0,
      concerns: ['No votes collected'],
      decision: 'reject',
      votes,
    };
  }

  // Weight votes by historical reliability placeholder.
  const weights: Record<string, number> = {
    strategy_selector: 1.0,
    research_ai: 0.9,
    market_microstructure: 0.85,
    technical_quant: 0.8,
    regime_detection: 0.75,
    sentiment: 0.5,
    red_team: -0.5, // adversarial vote subtracts from consensus
  };

  const longScore = votes
    .filter((v) => v.signal === 'long')
    .reduce((sum, v) => sum + v.confidence * (weights[v.agent] ?? 0.5), 0);

  const shortScore = votes
    .filter((v) => v.signal === 'short')
    .reduce((sum, v) => sum + v.confidence * (weights[v.agent] ?? 0.5), 0);

  const noTradeScore = votes
    .filter((v) => v.signal === 'no_trade')
    .reduce((sum, v) => sum + v.confidence * (weights[v.agent] ?? 0.5), 0);

  const totalAbsWeight = votes.reduce((sum, v) => sum + Math.abs(weights[v.agent] ?? 0.5), 0);

  const weightedEdge =
    votes.reduce((sum, v) => sum + v.expectedEdge * (weights[v.agent] ?? 0.5), 0) / totalAbsWeight;

  const scores = [
    { signal: 'long' as TradeDirection, score: longScore },
    { signal: 'short' as TradeDirection, score: shortScore },
    { signal: 'no_trade' as TradeDirection, score: noTradeScore },
  ];
  const winner = scores.reduce((a, b) => (a.score > b.score ? a : b));

  const agreementScore = totalAbsWeight > 0 ? winner.score / totalAbsWeight : 0;

  const concerns: string[] = [];
  for (const vote of votes) {
    if (vote.signal !== winner.signal && vote.confidence > 0.65) {
      concerns.push(`${vote.agent} disagrees (${vote.signal}, confidence ${vote.confidence.toFixed(2)})`);
    }
  }

  let decision: VotingResult['decision'] = 'proceed';
  if (winner.signal === 'no_trade' || agreementScore < 0.35) {
    decision = 'reject';
  } else if (agreementScore < 0.55 || concerns.length > 0) {
    decision = 'caution';
  }

  logger.info('VotingAggregator result', {
    consensus: winner.signal,
    confidence: Number(agreementScore.toFixed(4)),
    weightedEdge: Number(weightedEdge.toFixed(4)),
    decision,
  });

  return {
    consensusSignal: winner.signal,
    consensusConfidence: agreementScore,
    weightedEdge,
    agreementScore,
    concerns,
    decision,
    votes,
  };
}

function voteFromRegime(regime: RegimeProbabilities, direction: TradeDirection): Omit<StrategyVote, 'agent'> {
  const bullishRegimes: MarketRegime[] = ['TREND_UP', 'BREAKOUT_ACTIVE', 'EUPHORIA'];
  const bearishRegimes: MarketRegime[] = ['TREND_DOWN', 'PANIC', 'LIQUIDATION_CASCADE'];
  const neutralRegimes: MarketRegime[] = ['RANGE', 'MEAN_REVERSION', 'LOW_VOLATILITY', 'UNCERTAIN'];

  let signal: TradeDirection = 'no_trade';
  let confidence = 0.5;

  if (bullishRegimes.includes(regime.dominantRegime)) {
    signal = 'long';
    confidence = regime.confidence;
  } else if (bearishRegimes.includes(regime.dominantRegime)) {
    signal = 'short';
    confidence = regime.confidence;
  } else if (neutralRegimes.includes(regime.dominantRegime)) {
    signal = direction;
    confidence = regime.confidence * 0.6;
  }

  return {
    signal,
    confidence,
    expectedEdge: 0,
    failureConditions: ['Regime classification is wrong'],
    timeHorizon: 'medium',
  };
}

function voteFromMicrostructure(
  microstructure: MicrostructureAnalysis,
  direction: TradeDirection
): Omit<StrategyVote, 'agent'> {
  const aligned =
    (direction === 'long' && microstructure.bias === 'bullish') ||
    (direction === 'short' && microstructure.bias === 'bearish');

  return {
    signal: aligned ? direction : direction === 'long' ? 'short' : 'long',
    confidence: microstructure.confidence / 100,
    expectedEdge: 0,
    failureConditions: ['Order book flips', 'Large liquidity removal'],
    timeHorizon: 'short',
  };
}

function voteFromTechnical(technical: TechnicalAnalysis, direction: TradeDirection): Omit<StrategyVote, 'agent'> {
  const aligned =
    (direction === 'long' && technical.technicalBias === 'bullish') ||
    (direction === 'short' && technical.technicalBias === 'bearish');

  return {
    signal: aligned ? direction : 'no_trade',
    confidence: technical.confidence / 100,
    expectedEdge: 0,
    failureConditions: technical.conflicts,
    timeHorizon: 'medium',
  };
}

function voteFromSentiment(sentiment: SentimentOutput, direction: TradeDirection): Omit<StrategyVote, 'agent'> {
  const aligned =
    (direction === 'long' && sentiment.sentimentScore > 10) ||
    (direction === 'short' && sentiment.sentimentScore < -10);

  return {
    signal: aligned ? direction : 'no_trade',
    confidence: Math.min(Math.abs(sentiment.sentimentScore) / 100, 1),
    expectedEdge: 0,
    failureConditions: ['Sentiment shifts rapidly'],
    timeHorizon: 'short',
  };
}

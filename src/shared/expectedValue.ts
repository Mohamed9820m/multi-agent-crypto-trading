import Decimal from 'decimal.js';
import {
  ExecutionCosts,
  ExpectedValue,
  MarketData,
  MicrostructureAnalysis,
  RegimeProbabilities,
  SentimentOutput,
  StrategyCandidate,
  TradeDirection,
} from '../shared/types';
import { bayesianConfidence } from './bayesianConfidence';

const DEFAULT_WEIGHTS = {
  historicalEdge: 0.20,
  currentRegimeFit: 0.15,
  marketStructureQuality: 0.15,
  liquidityQuality: 0.10,
  orderFlowConfirmation: 0.10,
  statisticalConfidence: 0.10,
  newsContext: 0.05,
  executionQuality: 0.05,
  portfolioFit: 0.05,
  robustness: 0.05,
};

export function estimateExecutionCosts(
  marketData: MarketData,
  microstructure: MicrostructureAnalysis
): ExecutionCosts {
  const makerFeePct = 0.001;
  const takerFeePct = 0.001;
  const estimatedSpreadPct = microstructure.orderBook.spreadPct;

  // Slippage estimate based on liquidity score and depth
  const baseSlippage = 0.0005;
  const liquidityPenalty = Math.max(0, (70 - microstructure.liquidity.liquidityScore) / 10000);
  const estimatedSlippagePct = baseSlippage + liquidityPenalty;

  const fundingImpactPct = marketData.fundingRate
    ? marketData.fundingRate.fundingRate.abs().toNumber()
    : 0;

  const expectedTotalCostPct =
    takerFeePct * 2 + estimatedSpreadPct + estimatedSlippagePct * 2 + fundingImpactPct;

  return {
    makerFeePct,
    takerFeePct,
    estimatedSpreadPct,
    estimatedSlippagePct,
    fundingImpactPct,
    expectedTotalCostPct,
  };
}

export function estimateExpectedValue(
  _direction: TradeDirection,
  entry: Decimal,
  stop: Decimal,
  takeProfit: Decimal | null,
  costs: ExecutionCosts,
  winProbability?: number
): ExpectedValue {
  const riskPct = entry.minus(stop).abs().div(entry).toNumber();
  const rewardPct = takeProfit
    ? takeProfit.minus(entry).abs().div(entry).toNumber()
    : riskPct * 1.5;

  const estimatedWinProb =
    winProbability ?? (rewardPct > 0 ? riskPct / (riskPct + rewardPct) : 0.45);

  const avgWinPct = Math.max(0, rewardPct - costs.expectedTotalCostPct);
  const avgLossPct = Math.max(0, riskPct + costs.expectedTotalCostPct);

  const expectedValuePct = estimatedWinProb * avgWinPct - (1 - estimatedWinProb) * avgLossPct;
  const expectancyPerTrade = estimatedWinProb * avgWinPct - (1 - estimatedWinProb) * avgLossPct;

  const profitFactor =
    (1 - estimatedWinProb) * avgLossPct === 0
      ? 0
      : (estimatedWinProb * avgWinPct) / ((1 - estimatedWinProb) * avgLossPct);

  const notes: string[] = [];
  if (costs.expectedTotalCostPct > 0.005) notes.push('High expected costs reduce edge.');
  if (expectedValuePct <= 0) notes.push('Expected value is non-positive after costs.');

  return {
    winProbability: estimatedWinProb,
    avgWinPct,
    avgLossPct,
    expectancyPerTrade,
    profitFactor,
    expectedValuePct,
    dataQuality: 'medium',
    notes,
  };
}

export function buildStrategyCandidate(
  strategyName: string,
  direction: TradeDirection,
  opts: {
    entry: Decimal;
    stop: Decimal;
    takeProfit: Decimal | null;
    regime?: RegimeProbabilities;
    microstructure?: MicrostructureAnalysis;
    sentiment?: SentimentOutput;
    confidence: number;
    evidence: string[];
    counterArguments: string[];
    invalidationConditions: string[];
    timeHorizon: string;
    marketData: MarketData;
  }
): StrategyCandidate {
  const {
    entry,
    stop,
    takeProfit,
    regime,
    microstructure,
    sentiment,
    confidence,
    evidence,
    counterArguments,
    invalidationConditions,
    timeHorizon,
    marketData,
  } = opts;

  if (direction === 'no_trade') {
    return {
      strategy: strategyName,
      version: '1.0.0',
      symbol: marketData.symbol,
      direction: 'no_trade',
      entry,
      stop,
      takeProfit,
      regimeFit: 0,
      marketStructureQuality: 0,
      liquidityQuality: 0,
      orderFlowConfirmation: 0,
      statisticalConfidence: 0,
      newsContext: 0,
      executionQuality: 0,
      portfolioFit: 0,
      robustness: 0,
      historicalEdge: 0,
      overfitPenalty: 0,
      costPenalty: 0,
      correlationPenalty: 0,
      drawdownPenalty: 0,
      dataQualityPenalty: 0,
      eventRiskPenalty: 0,
      score: 0,
      expectedValue: {
        winProbability: 0,
        avgWinPct: 0,
        avgLossPct: 0,
        expectancyPerTrade: 0,
        profitFactor: 0,
        expectedValuePct: 0,
        dataQuality: 'medium',
        notes: ['No trade signal.'],
      },
      evidence,
      counterArguments,
      invalidationConditions,
      timeHorizon,
    };
  }

  const costs = microstructure
    ? estimateExecutionCosts(marketData, microstructure)
    : {
        makerFeePct: 0.001,
        takerFeePct: 0.001,
        estimatedSpreadPct: 0.001,
        estimatedSlippagePct: 0.0005,
        fundingImpactPct: 0,
        expectedTotalCostPct: 0.003,
      };

  const regimeFit = regime
    ? calculateRegimeFit(strategyName, regime)
    : 0.5;

  const liquidityQuality = microstructure
    ? Math.max(0, microstructure.liquidity.liquidityScore / 100)
    : 0.5;
  const orderFlowConfirmation = microstructure
    ? Math.max(0, 1 - Math.abs(microstructure.orderFlow.orderFlowImbalance))
    : 0.5;
  const executionQuality = Math.max(0, 1 - costs.expectedTotalCostPct * 100);
  const marketStructureQuality = 0.55;
  const dataQuality: 'high' | 'medium' | 'low' = marketData.dataQualityFlags.some(
    (f) => f.type === 'gap' || f.type === 'stale'
  )
    ? 'low'
    : marketData.dataQualityFlags.length > 0
      ? 'medium'
      : 'high';
  const statisticalConfidence = bayesianConfidence({
    signalConfidence: confidence,
    regimeFit,
    marketStructureQuality,
    liquidityQuality,
    orderFlowConfirmation,
    microstructureBias: microstructure?.bias ?? 'neutral',
    sentimentScore: sentiment?.sentimentScore ?? 0,
    dataQuality,
    direction,
  });
  const newsContext = sentiment ? Math.max(0, Math.min(1, (sentiment.sentimentScore + 100) / 200)) : 0.5;
  const portfolioFit = 0.75;
  const robustness = 0.6;
  const historicalEdge = 0.55;

  const expectedValue = estimateExpectedValue(
    direction,
    entry,
    stop,
    takeProfit,
    costs,
    statisticalConfidence
  );

  const costPenalty = Math.min(0.3, costs.expectedTotalCostPct * 10);
  const dataQualityPenalty = microstructure && microstructure.liquidity.gapRisk === 'high' ? 0.2 : 0;
  const overfitPenalty = 0.05;
  const correlationPenalty = 0;
  const drawdownPenalty = 0;
  const eventRiskPenalty = 0;

  const weightedScore =
    DEFAULT_WEIGHTS.historicalEdge * historicalEdge +
    DEFAULT_WEIGHTS.currentRegimeFit * regimeFit +
    DEFAULT_WEIGHTS.marketStructureQuality * marketStructureQuality +
    DEFAULT_WEIGHTS.liquidityQuality * liquidityQuality +
    DEFAULT_WEIGHTS.orderFlowConfirmation * orderFlowConfirmation +
    DEFAULT_WEIGHTS.statisticalConfidence * statisticalConfidence +
    DEFAULT_WEIGHTS.newsContext * newsContext +
    DEFAULT_WEIGHTS.executionQuality * executionQuality +
    DEFAULT_WEIGHTS.portfolioFit * portfolioFit +
    DEFAULT_WEIGHTS.robustness * robustness;

  const score = Math.max(
    0,
    weightedScore -
      overfitPenalty -
      costPenalty -
      correlationPenalty -
      drawdownPenalty -
      dataQualityPenalty -
      eventRiskPenalty
  );

  return {
    strategy: strategyName,
    version: '1.0.0',
    symbol: marketData.symbol,
    direction,
    entry,
    stop,
    takeProfit,
    regimeFit,
    marketStructureQuality,
    liquidityQuality,
    orderFlowConfirmation,
    statisticalConfidence,
    newsContext,
    executionQuality,
    portfolioFit,
    robustness,
    historicalEdge,
    overfitPenalty,
    costPenalty,
    correlationPenalty,
    drawdownPenalty,
    dataQualityPenalty,
    eventRiskPenalty,
    score,
    expectedValue,
    evidence,
    counterArguments,
    invalidationConditions,
    timeHorizon,
  };
}

function calculateRegimeFit(strategyName: string, regime: RegimeProbabilities): number {
  const dominant = regime.dominantRegime;
  const fitMap: Record<string, Partial<Record<string, number>>> = {
    trendFollowing: { TREND_UP: 0.9, TREND_DOWN: 0.85, BREAKOUT_ACTIVE: 0.7, RANGE: 0.3, UNCERTAIN: 0.2 },
    meanReversion: { RANGE: 0.9, MEAN_REVERSION: 0.9, LOW_VOLATILITY: 0.75, TREND_UP: 0.2, TREND_DOWN: 0.2 },
    momentumBreakout: { BREAKOUT_SETUP: 0.85, BREAKOUT_ACTIVE: 0.9, HIGH_VOLATILITY: 0.7, TREND_UP: 0.6 },
    scalping: { RANGE: 0.75, LOW_VOLATILITY: 0.75, TREND_UP: 0.5, TREND_DOWN: 0.5, HIGH_VOLATILITY: 0.4 },
    grid: { RANGE: 0.9, LOW_VOLATILITY: 0.85, TREND_UP: 0.2, TREND_DOWN: 0.2 },
    breakout: { BREAKOUT_SETUP: 0.9, BREAKOUT_ACTIVE: 0.9, HIGH_VOLATILITY: 0.75, TREND_UP: 0.55 },
  };

  const map = fitMap[strategyName] ?? {};
  return map[dominant] ?? 0.45;
}

export function selectBestCandidate(candidates: StrategyCandidate[]): StrategyCandidate | null {
  const tradable = candidates.filter((c) => c.direction !== 'no_trade' && c.expectedValue.expectedValuePct > 0);
  if (tradable.length === 0) return null;
  return tradable.reduce((best, c) => (c.score > best.score ? c : best));
}

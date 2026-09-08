import Decimal from 'decimal.js';
import { PositionState } from './stateMachine';

export type Side = 'LONG' | 'SHORT';
export type TradeDirection = 'long' | 'short' | 'no_trade';
export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface Candle {
  openTime: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  closeTime: number;
  quoteVolume: Decimal;
  trades: number;
  takerBuyBaseVolume: Decimal;
  takerBuyQuoteVolume: Decimal;
}

export interface OrderBookLevel {
  price: Decimal;
  quantity: Decimal;
}

export interface OrderBook {
  lastUpdateId: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface Ticker24h {
  priceChange: Decimal;
  priceChangePercent: Decimal;
  weightedAvgPrice: Decimal;
  prevClosePrice: Decimal;
  lastPrice: Decimal;
  lastQty: Decimal;
  bidPrice: Decimal;
  askPrice: Decimal;
  openPrice: Decimal;
  highPrice: Decimal;
  lowPrice: Decimal;
  volume: Decimal;
  quoteVolume: Decimal;
  openTime: number;
  closeTime: number;
  firstId: number;
  lastId: number;
  count: number;
}

export interface FundingRate {
  symbol: string;
  fundingRate: Decimal;
  fundingTime: number;
}

export interface MarketData {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  orderBook: OrderBook;
  ticker24h: Ticker24h;
  fundingRate?: FundingRate;
  openInterest?: Decimal;
  dataQualityFlags: DataQualityFlag[];
}

export type DataQualityFlag =
  | { type: 'gap'; message: string; from: number; to: number }
  | { type: 'stale'; message: string; lastCloseTime: number }
  | { type: 'maintenance'; message: string }
  | { type: 'low_volume'; message: string }
  | { type: 'api_warning'; message: string };

export interface IndicatorValue {
  value: Decimal | null;
  interpretation: string;
}

export interface TechnicalAnalysis {
  indicators: Record<string, IndicatorValue>;
  technicalBias: Bias;
  confidence: number; // 0-100
  conflicts: string[];
}

export interface SentimentOutput {
  sentimentScore: number; // -100 to +100
  keyEvents: string[];
  sources: string[];
  timeout?: boolean;
}

export interface TradeSignal {
  signal: TradeDirection;
  strategyUsed: string;
  confidence: number;
  triggeringRules: string[];
}

export interface RiskDecision {
  decision: 'approve' | 'veto';
  vetoReason?: string;
  positionSize?: Decimal;
  entry?: Decimal;
  stopLoss?: Decimal;
  takeProfit?: Decimal;
  riskAmountPct?: Decimal;
}

export interface OrderResult {
  orderId: string;
  status: 'submitted' | 'filled' | 'partial' | 'cancelled' | 'rejected';
  fillPrice?: Decimal;
  fillQty?: Decimal;
  fees?: Decimal;
  timestamp: Date;
  exchangeOrderId?: string;
  rawResponse?: unknown;
}

export interface AccountState {
  equityEUR: Decimal;
  cashEUR: Decimal;
  openExposureEUR: Decimal;
  dailyRealizedPnlEUR: Decimal;
  tradesToday: number;
  openPositions: Position[];
}

export interface Position {
  positionId: string;
  symbol: string;
  side: Side;
  strategy?: string;
  entryPrice: Decimal;
  quantity: Decimal;
  stopLoss?: Decimal;
  takeProfit?: Decimal;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  status: 'open' | 'closed';
  state: PositionState;
  openedAt: Date;
  closedAt?: Date;
}

export interface CycleLog {
  cycleId: string;
  symbol: string;
  timeframe: string;
  startedAt: Date;
  completedAt?: Date;
  marketData?: MarketData;
  technicalAnalysis?: TechnicalAnalysis;
  sentiment?: SentimentOutput;
  signal?: TradeSignal;
  riskDecision?: RiskDecision;
  execution?: OrderResult[];
  errors?: string[];
}

export interface BacktestMetrics {
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  winRatePct: number;
  expectancy: number;
  profitFactor: number;
  avgTradePct: number;
  calmarRatio: number;
  maxConsecutiveLosses: number;
  numberOfTrades: number;
}

export interface BacktestResult {
  pass: boolean;
  metrics: BacktestMetrics;
  sampleSize: number;
  notes: string[];
}

export interface GuardianTrigger {
  type: string;
  message: string;
  accountSnapshot: AccountState;
}

// =============================================================================
// INSTITUTIONAL QUANT FIRM EXTENSIONS
// =============================================================================

export type MarketRegime =
  | 'TREND_UP'
  | 'TREND_DOWN'
  | 'RANGE'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'BREAKOUT_SETUP'
  | 'BREAKOUT_ACTIVE'
  | 'MEAN_REVERSION'
  | 'PANIC'
  | 'EUPHORIA'
  | 'LIQUIDATION_CASCADE'
  | 'NEWS_DRIVEN'
  | 'UNCERTAIN';

export type StrategicRegime =
  | 'STRONG_TREND'
  | 'BUILDING_TREND'
  | 'CLEAN_RANGE'
  | 'CHOPPY_VOLATILE'
  | 'RANDOM_WALK';

export interface RegimeProbabilities {
  regimes: Partial<Record<MarketRegime, number>>;
  dominantRegime: MarketRegime;
  confidence: number;
  features: Record<string, number | null>;
  // Part 1 extensions
  adx: number;
  adxTrending: boolean;
  hurst: number | null;
  varianceRatio: number | null;
  strategicRegime: StrategicRegime;
  strategicConfidence: number;
  atrPercentile: number | null;
}

export interface OrderBookImbalance {
  bidAskImbalance: number; // (bidVol - askVol) / (bidVol + askVol)
  depthImbalance: number;
  bestBid: Decimal;
  bestAsk: Decimal;
  spread: Decimal;
  spreadPct: number;
  weightedMidPrice: Decimal | null;
  bidDepth5: Decimal;
  askDepth5: Decimal;
}

export interface VolumeDeltaMetrics {
  volumeDelta: Decimal; // buy volume - sell volume for the period
  cumulativeDelta: Decimal;
  buyVolume: Decimal;
  sellVolume: Decimal;
  deltaPerPeriod: Decimal[];
}

export interface OrderFlowMetrics {
  orderFlowImbalance: number; // ΔBidDepth - ΔAskDepth normalized
  tradeAggressorImbalance: number;
  absorptionScore: number; // 0-100, high = large limit absorption observed
  sweepScore: number; // 0-100, high = liquidity sweep pattern
  replenishmentScore: number; // 0-100
}

export interface LiquidityMetrics {
  bidDepth5: Decimal;
  askDepth5: Decimal;
  totalDepth5: Decimal;
  depthImbalance: number;
  liquidityScore: number; // 0-100, higher = deeper/more balanced
  gapRisk: 'low' | 'medium' | 'high';
}

export interface MicrostructureAnalysis {
  orderBook: OrderBookImbalance;
  volumeDelta: VolumeDeltaMetrics;
  orderFlow: OrderFlowMetrics;
  liquidity: LiquidityMetrics;
  timestamp: number;
  bias: Bias;
  confidence: number;
}

export interface ExecutionCosts {
  makerFeePct: number;
  takerFeePct: number;
  estimatedSpreadPct: number;
  estimatedSlippagePct: number;
  fundingImpactPct: number;
  expectedTotalCostPct: number;
}

export interface ExpectedValue {
  winProbability: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPerTrade: number;
  profitFactor: number;
  expectedValuePct: number;
  sharpe?: number;
  sortino?: number;
  maxDrawdownPct?: number;
  dataQuality: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface StrategyCandidate {
  strategy: string;
  version: string;
  symbol: string;
  direction: TradeDirection;
  entry: Decimal;
  stop: Decimal;
  takeProfit: Decimal | null;
  regimeFit: number; // 0-1
  marketStructureQuality: number; // 0-1
  liquidityQuality: number; // 0-1
  orderFlowConfirmation: number; // 0-1
  statisticalConfidence: number; // 0-1
  newsContext: number; // 0-1
  executionQuality: number; // 0-1
  portfolioFit: number; // 0-1
  robustness: number; // 0-1
  historicalEdge: number; // 0-1
  overfitPenalty: number;
  costPenalty: number;
  correlationPenalty: number;
  drawdownPenalty: number;
  dataQualityPenalty: number;
  eventRiskPenalty: number;
  score: number; // final score after weights and penalties
  expectedValue: ExpectedValue;
  evidence: string[];
  counterArguments: string[];
  invalidationConditions: string[];
  timeHorizon: string;
}

export interface TradeProposal {
  symbol: string;
  market: string;
  strategy: string;
  direction: TradeDirection;
  timeframe: string;
  regime: MarketRegime;
  entry: Decimal;
  stop: Decimal;
  takeProfit: Decimal | null;
  positionSize: Decimal;
  leverage: number;
  expectedMovePct: number;
  costs: ExecutionCosts;
  expectedValue: ExpectedValue;
  riskReward: number;
  confidence: number;
  evidence: string[];
  counterArguments: string[];
  invalidationConditions: string[];
  executionPlan: string;
  riskApproval: boolean;
}

export interface PortfolioExposure {
  grossExposureEUR: Decimal;
  netExposureEUR: Decimal;
  longExposureEUR: Decimal;
  shortExposureEUR: Decimal;
  perSymbolExposure: Record<string, Decimal>;
  perStrategyExposure: Record<string, Decimal>;
  correlatedExposure: number; // 0-1 estimate
  stablecoinExposureEUR: Decimal;
  cashEUR: Decimal;
}

export interface PortfolioState {
  account: AccountState;
  exposure: PortfolioExposure;
  openPositions: Position[];
  dailyRealizedPnlEUR: Decimal;
  maxDrawdownPct: number;
  sharpe30d?: number;
  sortino30d?: number;
}

export interface RedTeamChallenge {
  conclusion: 'valid' | 'weak' | 'invalid' | 'requires_more_data';
  confidence: number; // 0-1, how confident the red team is that the trade is wrong
  attacks: {
    area: string;
    issue: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    mitigatingEvidence?: string;
  }[];
  invalidationTriggers: string[];
  recommendation: 'proceed' | 'caution' | 'reject';
}

export interface TradeMonitorUpdate {
  positionId: string;
  currentPrice: Decimal;
  unrealizedPnlPct: number;
  unrealizedPnlEUR: Decimal;
  distanceToStopPct: number;
  distanceToTargetPct: number | null;
  slippage: number;
  fundingPaid: Decimal;
  liquidationDistance?: number;
  regime: MarketRegime;
  thesisValid: boolean;
  recommendedAction: 'hold' | 'reduce' | 'exit' | 'move_stop' | 'take_partial';
}

export interface PostTradeForensics {
  positionId: string;
  symbol: string;
  strategy: string;
  direction: TradeDirection;
  entryPrice: Decimal;
  exitPrice?: Decimal;
  realizedPnlPct: number;
  realizedPnlEUR: Decimal;
  feesEUR: Decimal;
  slippagePct: number;
  expectedEdgeAtEntry: string;
  actualOutcome: string;
  marketRegime: MarketRegime;
  thesisFailed: boolean;
  executionFailed: boolean;
  modelFailed: boolean;
  newsInvalidated: boolean;
  lessons: string[];
}

export interface StrategyVote {
  agent: string;
  signal: TradeDirection;
  confidence: number;
  expectedEdge: number;
  failureConditions: string[];
  timeHorizon: string;
}

export interface MarketSnapshot {
  symbol: string;
  timestamp: number;
  lastPrice: Decimal;
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
  spreadPct: number;
  weightedMid: Decimal | null;
  change24hPct: number;
  volume24h: Decimal;
  quoteVolume24h: Decimal;
  fundingRate: number | null;
  atr14: Decimal | null;
  atrPct: number;
  sma20: Decimal | null;
  ema9: Decimal | null;
  ema21: Decimal | null;
  adx14: Decimal | null;
  liquidityScore: number;
  bidAskImbalance: number;
  depthImbalance: number;
  dominantRegime: MarketRegime;
  regimeConfidence: number;
  dataQuality: 'high' | 'medium' | 'low';
}

export interface MarketIntelligence {
  snapshot: MarketSnapshot;
  summary: string;
  bias: Bias;
  confidence: number; // 0-1
  tradeStance: 'aggressive' | 'neutral' | 'defensive' | 'no_trade';
  recommendedDirection: TradeDirection;
  keyRisks: string[];
  invalidationConditions: string[];
  source: 'llm' | 'local';
}

export interface SpecialistAnalysis {
  regime?: RegimeProbabilities;
  microstructure?: MicrostructureAnalysis;
  portfolio?: PortfolioState;
  redTeam?: RedTeamChallenge;
  votes?: StrategyVote[];
  marketIntelligence?: MarketIntelligence;
}

export interface StrategyAllocation {
  strategy: string;
  direction: TradeDirection;
  allocation: number;
  score: number;
  vetoReason?: string;
}

export interface ExpandedCycleLog extends CycleLog {
  specialistAnalysis?: SpecialistAnalysis;
  strategyCandidates?: StrategyCandidate[];
  selectedCandidate?: StrategyCandidate;
  strategyAllocations?: StrategyAllocation[];
  tradeProposal?: TradeProposal;
  marketIntelligence?: MarketIntelligence;
}

import Decimal from 'decimal.js';
import {
  Bias,
  Candle,
  MarketData,
  MarketIntelligence,
  MicrostructureAnalysis,
  OrderBookLevel,
  RegimeProbabilities,
  SentimentOutput,
  TechnicalAnalysis,
  TradeSignal,
} from '../shared/types';

export interface StrategyContext {
  symbol: string;
  timeframe: string;
  marketData: MarketData;
  technicalAnalysis: TechnicalAnalysis;
  sentiment: SentimentOutput;
  regime?: RegimeProbabilities;
  microstructure?: MicrostructureAnalysis;
  marketIntelligence?: MarketIntelligence;
}

export interface Strategy {
  name: string;
  version: string;
  description: string;
  params: Record<string, number>;
  computeSignal(ctx: StrategyContext): TradeSignal;
  computeStopLoss(ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal): Decimal;
  computeTakeProfit(ctx: StrategyContext, direction: 'LONG' | 'SHORT', entry: Decimal, stopLoss: Decimal): Decimal | null;
}

export function weightedMidPrice(bids: OrderBookLevel[], asks: OrderBookLevel[]): Decimal | null {
  if (bids.length === 0 || asks.length === 0) return null;
  const bestBid = bids[0];
  const bestAsk = asks[0];
  return bestBid.price.times(bestBid.quantity).plus(bestAsk.price.times(bestAsk.quantity))
    .div(bestBid.quantity.plus(bestAsk.quantity));
}

export function biasMatchesDirection(bias: Bias, direction: 'LONG' | 'SHORT'): boolean {
  if (direction === 'LONG') return bias === 'bullish';
  return bias === 'bearish';
}

export interface BacktestCandle extends Candle {
  signal?: TradeSignal;
}

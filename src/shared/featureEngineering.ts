import Decimal from 'decimal.js';
import { Candle } from './types';

export interface FeatureInput {
  symbol: string;
  candles: Candle[];
  close: Decimal;
  volume: Decimal;
  spreadPct: number;
  bidAskImbalance: number;
  orderFlowImbalance: number;
  fundingRate?: Decimal;
  fundingChange?: Decimal;
  openInterest?: Decimal;
  oiChange?: Decimal;
  sentimentScore: number;
  newsIntensity: number;
  liquidationIntensity?: number;
  volatilityPercentile: number;
  trendStrength: number;
  regime?: string;
}

export interface FeatureVector {
  symbol: string;
  timestamp: number;
  returns: number;
  logReturns: number;
  atr: number;
  realizedVolatility: number;
  volumeZScore: number;
  spread: number;
  orderbookImbalance: number;
  cumulativeVolumeDelta: number;
  funding: number;
  fundingChange: number;
  openInterest: number;
  oiChange: number;
  liquidationIntensity: number;
  vwapDistance: number;
  emaDistance: number;
  rangePercentile: number;
  momentum: number;
  autocorrelation: number;
  marketBeta: number;
  sentiment: number;
  newsIntensity: number;
  volatilityPercentile: number;
  trendStrength: number;
  regime: string;
}

/**
 * Compute a normalized feature vector from raw market inputs.
 * This is intentionally simple and stable; it can be consumed by the ML layer.
 */
export function computeFeatureVector(input: FeatureInput): FeatureVector {
  const closes = input.candles.map((c) => c.close.toNumber());
  const volumes = input.candles.map((c) => c.volume.toNumber());

  const returns = closes.length >= 2 ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] : 0;
  const logReturns = closes.length >= 2 ? Math.log(closes[closes.length - 1] / closes[closes.length - 2]) : 0;

  const atr = computeATR(input.candles.slice(-14));
  const realizedVolatility = computeRealizedVolatility(closes.slice(-20));
  const volumeZScore = zScore(volumes.slice(-20));
  const vwap = computeVWAP(input.candles.slice(-20));
  const vwapDistance = vwap > 0 ? (input.close.toNumber() - vwap) / vwap : 0;

  const ema20 = computeEMA(closes.slice(-25), 20);
  const emaDistance = ema20 > 0 ? (input.close.toNumber() - ema20) / ema20 : 0;

  const rangePercentile = computeRangePercentile(closes.slice(-20), input.close.toNumber());
  const momentum = closes.length >= 6 ? (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] : 0;
  const autocorrelation = computeAutocorrelation(returns ? [returns] : closes.slice(-20), 1);

  return {
    symbol: input.symbol,
    timestamp: Date.now(),
    returns,
    logReturns,
    atr,
    realizedVolatility,
    volumeZScore,
    spread: input.spreadPct,
    orderbookImbalance: input.bidAskImbalance,
    cumulativeVolumeDelta: input.orderFlowImbalance,
    funding: input.fundingRate?.toNumber() ?? 0,
    fundingChange: input.fundingChange?.toNumber() ?? 0,
    openInterest: input.openInterest?.toNumber() ?? 0,
    oiChange: input.oiChange?.toNumber() ?? 0,
    liquidationIntensity: input.liquidationIntensity ?? 0,
    vwapDistance,
    emaDistance,
    rangePercentile,
    momentum,
    autocorrelation,
    marketBeta: 1, // placeholder: requires market benchmark
    sentiment: input.sentimentScore / 100,
    newsIntensity: input.newsIntensity,
    volatilityPercentile: input.volatilityPercentile,
    trendStrength: input.trendStrength,
    regime: input.regime ?? 'UNCERTAIN',
  };
}

function computeATR(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high.toNumber();
    const low = candles[i].low.toNumber();
    const prevClose = candles[i - 1].close.toNumber();
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    sum += tr;
  }
  return sum / (candles.length - 1);
}

function computeRealizedVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    logReturns.push(Math.log(prices[i] / prices[i - 1]));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / logReturns.length;
  return Math.sqrt(variance);
}

function zScore(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  const std = Math.sqrt(variance) || 1e-9;
  return (values[values.length - 1] - mean) / std;
}

function computeVWAP(candles: Candle[]): number {
  let totalQuote = 0;
  let totalVolume = 0;
  for (const c of candles) {
    const typical = (c.high.toNumber() + c.low.toNumber() + c.close.toNumber()) / 3;
    totalQuote += typical * c.volume.toNumber();
    totalVolume += c.volume.toNumber();
  }
  return totalVolume > 0 ? totalQuote / totalVolume : 0;
}

function computeEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeRangePercentile(prices: number[], current: number): number {
  if (prices.length < 2) return 0.5;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (max === min) return 0.5;
  return (current - min) / (max - min);
}

function computeAutocorrelation(values: number[], lag: number): number {
  if (values.length < lag + 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let num = 0;
  let denom = 0;
  for (let i = 0; i < values.length - lag; i++) {
    num += (values[i] - mean) * (values[i + lag] - mean);
  }
  for (let i = 0; i < values.length; i++) {
    denom += Math.pow(values[i] - mean, 2);
  }
  return denom === 0 ? 0 : num / denom;
}

export function featureVectorToArray(fv: FeatureVector): number[] {
  return [
    fv.returns,
    fv.logReturns,
    fv.atr,
    fv.realizedVolatility,
    fv.volumeZScore,
    fv.spread,
    fv.orderbookImbalance,
    fv.cumulativeVolumeDelta,
    fv.funding,
    fv.fundingChange,
    fv.openInterest,
    fv.oiChange,
    fv.liquidationIntensity,
    fv.vwapDistance,
    fv.emaDistance,
    fv.rangePercentile,
    fv.momentum,
    fv.autocorrelation,
    fv.marketBeta,
    fv.sentiment,
    fv.newsIntensity,
    fv.volatilityPercentile,
    fv.trendStrength,
  ];
}

export function featureNames(): string[] {
  return [
    'returns',
    'logReturns',
    'atr',
    'realizedVolatility',
    'volumeZScore',
    'spread',
    'orderbookImbalance',
    'cumulativeVolumeDelta',
    'funding',
    'fundingChange',
    'openInterest',
    'oiChange',
    'liquidationIntensity',
    'vwapDistance',
    'emaDistance',
    'rangePercentile',
    'momentum',
    'autocorrelation',
    'marketBeta',
    'sentiment',
    'newsIntensity',
    'volatilityPercentile',
    'trendStrength',
  ];
}

import Decimal from 'decimal.js';
import { Candle, MarketRegime, RegimeProbabilities, StrategicRegime } from '../shared/types';
import { adx, atr, sma, hurstExponent, varianceRatio } from '../shared/indicators';

function zScore(values: Decimal[], current: Decimal): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a.plus(b), new Decimal(0)).div(values.length);
  const variance = values
    .reduce((a, b) => a.plus(b.minus(mean).pow(2)), new Decimal(0))
    .div(values.length);
  const std = variance.sqrt();
  if (std.eq(0)) return 0;
  return current.minus(mean).div(std).toNumber();
}

function linearRegressionSlope(closes: Decimal[]): number {
  if (closes.length < 10) return 0;
  const n = closes.length;
  const xMean = (n - 1) / 2;
  const yMean = closes.reduce((a, b) => a.plus(b), new Decimal(0)).div(n).toNumber();
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const xDiff = i - xMean;
    num += xDiff * (closes[i].toNumber() - yMean);
    den += xDiff * xDiff;
  }
  if (den === 0) return 0;
  return num / den;
}

function percentileRank(values: number[], current: number): number {
  if (values.length < 2) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  let below = 0;
  for (const v of sorted) {
    if (v < current) below++;
  }
  return below / sorted.length;
}

function classifyStrategicRegime(
  hurst: number | null,
  adxValue: number,
  varianceRatio: number | null
): { regime: StrategicRegime; confidence: number } {
  const h = hurst ?? 0.5;
  const vr = varianceRatio ?? 1;

  // Tie-breaker: variance ratio can nudge a borderline Hurst reading.
  const effectiveH = h + (vr > 1.05 ? 0.03 : vr < 0.95 ? -0.03 : 0);

  let regime: StrategicRegime;
  let confidence = 0.6;

  if (effectiveH > 0.55 && adxValue > 25) {
    regime = 'STRONG_TREND';
    confidence = Math.min(0.95, 0.6 + (effectiveH - 0.55) * 2 + (adxValue - 25) / 50);
  } else if (effectiveH > 0.55 && adxValue < 20) {
    regime = 'BUILDING_TREND';
    confidence = Math.min(0.85, 0.6 + (effectiveH - 0.55) * 2);
  } else if (effectiveH < 0.45 && adxValue < 20) {
    regime = 'CLEAN_RANGE';
    confidence = Math.min(0.9, 0.6 + (0.45 - effectiveH) * 2);
  } else if (effectiveH < 0.45 && adxValue > 25) {
    regime = 'CHOPPY_VOLATILE';
    confidence = Math.min(0.85, 0.6 + (0.45 - effectiveH) * 2 + (adxValue - 25) / 50);
  } else {
    regime = 'RANDOM_WALK';
    confidence = 0.55;
  }

  return { regime, confidence };
}

export class RegimeDetectionAgent {
  analyze(candles: Candle[]): RegimeProbabilities {
    if (candles.length < 100) {
      return {
        regimes: { UNCERTAIN: 1.0 },
        dominantRegime: 'UNCERTAIN',
        confidence: 0,
        features: { data: null },
        adx: 0,
        adxTrending: false,
        hurst: null,
        varianceRatio: null,
        strategicRegime: 'RANDOM_WALK',
        strategicConfidence: 0,
        atrPercentile: null,
      };
    }

    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

    // 1.1 ADX
    const adxResult = adx(candles, 14);
    const adxValue = adxResult?.adx?.toNumber() ?? 0;
    const plusDi = adxResult?.plusDi?.toNumber() ?? 0;
    const minusDi = adxResult?.minusDi?.toNumber() ?? 0;
    const adxRising = this.isAdxRising(candles);
    const adxTrending = adxValue > 25;

    // 1.2 Hurst
    const returns = candles.slice(1).map((c, i) => c.close.div(candles[i].close).minus(1));
    const hurst = hurstExponent(returns, 8, Math.min(150, Math.floor(returns.length / 2)));

    // Variance ratio tie-breaker
    const vr = varianceRatio(returns, 5);

    // 1.4 Volatility overlay
    const atr14 = atr(candles, 14);
    const atr50 = atr(candles, 50);
    const currentATR = atr14 ?? new Decimal(0);
    const longATR = atr50 ?? currentATR;
    const compressionRatio = longATR.eq(0) ? 1 : currentATR.div(longATR).toNumber();

    const vol20 = realizedVolatility(returns.slice(-20));
    const vol100 = realizedVolatility(returns.slice(-100));
    const volZ = vol100 && vol100 > 0 ? (vol20 - vol100) / vol100 : 0;

    const atrHistory = candles.slice(-100).map((c, i, arr) => {
      if (i === 0) return 0;
      return Decimal.max(
        c.high.minus(c.low),
        c.high.minus(arr[i - 1].close).abs(),
        c.low.minus(arr[i - 1].close).abs()
      ).toNumber();
    });
    const currentATRNum = currentATR.toNumber();
    const atrPercentile = atrHistory.length > 0 ? percentileRank(atrHistory, currentATRNum) : null;

    const slope = linearRegressionSlope(closes.slice(-30));
    const priceRange = closes.slice(-30).reduce(
      (acc, c) => ({ max: Decimal.max(acc.max, c), min: Decimal.min(acc.min, c) }),
      { max: closes[closes.length - 1], min: closes[closes.length - 1] }
    );
    const rangePct = priceRange.max.eq(0)
      ? 0
      : priceRange.max.minus(priceRange.min).div(priceRange.max).toNumber();

    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const price = closes[closes.length - 1];
    const trendStrength =
      sma20 && sma50
        ? price.minus(sma20).div(sma20).toNumber() + price.minus(sma50).div(sma50).toNumber()
        : 0;

    const volumeZ = zScore(volumes.slice(-30), volumes[volumes.length - 1]);

    // 1.3 Strategic regime matrix
    const { regime: strategicRegime, confidence: strategicConfidence } = classifyStrategicRegime(
      hurst,
      adxValue,
      vr
    );

    const features: Record<string, number | null> = {
      compressionRatio,
      volatilityZ: volZ,
      trendStrength,
      rangePct,
      volumeZ,
      slope30: slope,
      adx: adxValue,
      plusDi,
      minusDi,
      adxRising: adxRising ? 1 : 0,
      hurst,
      varianceRatio: vr,
      atrPercentile,
    };

    const probabilities: Partial<Record<MarketRegime, number>> = {
      UNCERTAIN: 0.02,
    };

    // Trend
    if (trendStrength > 0.02 && slope > 0) {
      probabilities.TREND_UP = Math.min(0.75, 0.4 + trendStrength * 10 + Math.max(0, -volZ));
    } else if (trendStrength < -0.02 && slope < 0) {
      probabilities.TREND_DOWN = Math.min(0.75, 0.4 - trendStrength * 10 + Math.max(0, -volZ));
    }

    // Range
    if (rangePct < 0.06 && Math.abs(trendStrength) < 0.02) {
      probabilities.RANGE = Math.min(0.7, 0.35 + Math.max(0, 0.1 - rangePct) * 5);
    }

    // Volatility
    if (volZ > 1.0) {
      probabilities.HIGH_VOLATILITY = Math.min(0.7, 0.3 + volZ * 0.2);
    } else if (volZ < -0.5) {
      probabilities.LOW_VOLATILITY = Math.min(0.6, 0.3 - volZ * 0.15);
    }

    // Breakout setup
    if (compressionRatio < 0.7 && Math.abs(trendStrength) < 0.02) {
      probabilities.BREAKOUT_SETUP = Math.min(0.55, 0.25 + (0.7 - compressionRatio));
    }

    // Breakout active
    if (compressionRatio < 0.9 && Math.abs(trendStrength) > 0.025 && volumeZ > 1) {
      probabilities.BREAKOUT_ACTIVE = Math.min(
        0.6,
        0.25 + Math.abs(trendStrength) * 8 + (volumeZ - 1) * 0.1
      );
    }

    // Mean reversion
    if (volZ > 0.5 && Math.abs(trendStrength) > 0.03) {
      probabilities.MEAN_REVERSION = Math.min(0.45, 0.2 + volZ * 0.1);
    }

    // Panic / euphoria are extreme cases; keep very low unless extreme
    if (volZ > 2.5 && trendStrength < -0.05) {
      probabilities.PANIC = Math.min(0.35, 0.15 + (volZ - 2.5) * 0.1);
    }
    if (volZ > 2.5 && trendStrength > 0.05) {
      probabilities.EUPHORIA = Math.min(0.35, 0.15 + (volZ - 2.5) * 0.1);
    }

    // Normalize to sum to 1
    const sum = Object.values(probabilities).reduce((a, b = 0) => a + b, 0);
    if (sum > 0) {
      for (const key of Object.keys(probabilities) as MarketRegime[]) {
        probabilities[key] = (probabilities[key] ?? 0) / sum;
      }
    }

    const entries = Object.entries(probabilities) as [MarketRegime, number][];
    const dominant = entries.reduce((a, b) => (a[1] > b[1] ? a : b));

    return {
      regimes: probabilities,
      dominantRegime: dominant[0],
      confidence: dominant[1],
      features,
      adx: adxValue,
      adxTrending,
      hurst,
      varianceRatio: vr,
      strategicRegime,
      strategicConfidence,
      atrPercentile,
    };
  }

  private isAdxRising(candles: Candle[]): boolean {
    if (candles.length < 30) return false;
    const prev = adx(candles.slice(0, -5), 14)?.adx;
    const cur = adx(candles, 14)?.adx;
    if (!prev || !cur) return false;
    return cur.gt(prev);
  }
}

export const regimeDetectionAgent = new RegimeDetectionAgent();
export default regimeDetectionAgent;

function realizedVolatility(returns: Decimal[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a.plus(b), new Decimal(0)).div(returns.length);
  const variance = returns
    .reduce((a, b) => a.plus(b.minus(mean).pow(2)), new Decimal(0))
    .div(returns.length);
  return variance.sqrt().toNumber();
}

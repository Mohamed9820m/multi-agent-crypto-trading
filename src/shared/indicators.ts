import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const HUNDRED = new Decimal(100);

function mean(values: Decimal[]): Decimal {
  if (values.length === 0) return ZERO;
  return values.reduce((a, b) => a.plus(b), ZERO).div(values.length);
}

function stdDev(values: Decimal[]): Decimal {
  if (values.length < 2) return ZERO;
  const m = mean(values);
  const variance = values
    .reduce((acc, v) => acc.plus(v.minus(m).pow(2)), ZERO)
    .div(values.length);
  return variance.sqrt();
}

// -------------------- Trend --------------------

export function sma(closes: Decimal[], n: number): Decimal | null {
  if (closes.length < n) return null;
  return mean(closes.slice(-n));
}

export function ema(closes: Decimal[], n: number): Decimal | null {
  if (closes.length < n) return null;
  const k = new Decimal(2).div(n + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) {
    e = closes[i].times(k).plus(e.times(ONE.minus(k)));
  }
  return e;
}

export interface MacdResult {
  macdLine: Decimal | null;
  signalLine: Decimal | null;
  histogram: Decimal | null;
}

export function macd(
  closes: Decimal[],
  fast = 12,
  slow = 26,
  signal = 9
): MacdResult {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  if (!fastEma || !slowEma) {
    return { macdLine: null, signalLine: null, histogram: null };
  }
  const macdLine = fastEma.minus(slowEma);
  // Signal line is EMA of MACD line; we need a series. Approximate from available data.
  const macdSeries: Decimal[] = [];
  for (let i = slow; i <= closes.length; i++) {
    const f = ema(closes.slice(0, i), fast);
    const s = ema(closes.slice(0, i), slow);
    if (f && s) macdSeries.push(f.minus(s));
  }
  const signalLine = ema(macdSeries, signal);
  return {
    macdLine,
    signalLine,
    histogram: signalLine ? macdLine.minus(signalLine) : null,
  };
}

export interface AdxResult {
  adx: Decimal | null;
  plusDi: Decimal | null;
  minusDi: Decimal | null;
}

export function adx(candles: { high: Decimal; low: Decimal; close: Decimal }[], n = 14): AdxResult {
  if (candles.length < n + 1) return { adx: null, plusDi: null, minusDi: null };

  const trs: Decimal[] = [];
  const plusDMs: Decimal[] = [];
  const minusDMs: Decimal[] = [];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const tr = Decimal.max(
      cur.high.minus(cur.low),
      cur.high.minus(prev.close).abs(),
      cur.low.minus(prev.close).abs()
    );
    trs.push(tr);

    const upMove = cur.high.minus(prev.high);
    const downMove = prev.low.minus(cur.low);
    let plusDM = ZERO;
    let minusDM = ZERO;
    if (upMove.gt(downMove) && upMove.gt(0)) plusDM = upMove;
    if (downMove.gt(upMove) && downMove.gt(0)) minusDM = downMove;
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  const atr = sma(trs.slice(0, n), n);
  const smoothedPlusDM = sma(plusDMs.slice(0, n), n);
  const smoothedMinusDM = sma(minusDMs.slice(0, n), n);
  if (!atr || atr.eq(0) || !smoothedPlusDM || !smoothedMinusDM) {
    return { adx: null, plusDi: null, minusDi: null };
  }

  let plusDi = smoothedPlusDM.div(atr).times(100);
  let minusDi = smoothedMinusDM.div(atr).times(100);
  const dxValues: Decimal[] = [];

  for (let i = n; i < trs.length; i++) {
    const prevPlusDM = smoothedPlusDM;
    const prevMinusDM = smoothedMinusDM;
    const prevATR = atr;
    // Wilder's smoothing
    const curATR = prevATR.times(n - 1).plus(trs[i]).div(n);
    const curPlusDM = prevPlusDM.times(n - 1).plus(plusDMs[i]).div(n);
    const curMinusDM = prevMinusDM.times(n - 1).plus(minusDMs[i]).div(n);
    plusDi = curPlusDM.div(curATR).times(100);
    minusDi = curMinusDM.div(curATR).times(100);
    const dx = plusDi.minus(minusDi).abs().div(plusDi.plus(minusDi)).times(100);
    dxValues.push(dx);
  }

  const adxValue = sma(dxValues, n);
  return { adx: adxValue, plusDi, minusDi };
}

export interface ParabolicSarResult {
  sar: Decimal;
  trend: 'up' | 'down';
}

export function parabolicSar(
  highs: Decimal[],
  lows: Decimal[],
  afStep = 0.02,
  afMax = 0.2
): ParabolicSarResult | null {
  if (highs.length < 2 || lows.length < 2) return null;

  const afStepD = new Decimal(afStep);
  const afMaxD = new Decimal(afMax);

  let trend: 'up' | 'down' = lows[0].lt(lows[1]) ? 'up' : 'down';
  let sar = trend === 'up' ? lows[0] : highs[0];
  let ep = trend === 'up' ? highs[1] : lows[1];
  let af = afStepD;

  for (let i = 2; i < highs.length; i++) {
    const priorSar = sar;
    sar = priorSar.plus(af.times(ep.minus(priorSar)));

    if (trend === 'up') {
      if (sar.gt(lows[i - 1])) sar = lows[i - 1];
      if (sar.gt(lows[i])) sar = lows[i];
      if (highs[i].gt(ep)) {
        ep = highs[i];
        af = Decimal.min(af.plus(afStepD), afMaxD);
      }
      if (lows[i].lt(sar)) {
        trend = 'down';
        sar = ep;
        ep = lows[i];
        af = afStepD;
      }
    } else {
      if (sar.lt(highs[i - 1])) sar = highs[i - 1];
      if (sar.lt(highs[i])) sar = highs[i];
      if (lows[i].lt(ep)) {
        ep = lows[i];
        af = Decimal.min(af.plus(afStepD), afMaxD);
      }
      if (highs[i].gt(sar)) {
        trend = 'up';
        sar = ep;
        ep = highs[i];
        af = afStepD;
      }
    }
  }

  return { sar, trend };
}

export interface IchimokuResult {
  tenkanSen: Decimal | null;
  kijunSen: Decimal | null;
  senkouSpanA: Decimal | null;
  senkouSpanB: Decimal | null;
  chikouSpan: Decimal | null;
}

export function ichimoku(
  highs: Decimal[],
  lows: Decimal[],
  closes: Decimal[]
): IchimokuResult {
  const donchian = (h: Decimal[], l: Decimal[], n: number): Decimal | null => {
    if (h.length < n || l.length < n) return null;
    const hh = Decimal.max(...h.slice(-n));
    const ll = Decimal.min(...l.slice(-n));
    return hh.plus(ll).div(2);
  };

  const tenkanSen = donchian(highs, lows, 9);
  const kijunSen = donchian(highs, lows, 26);
  const senkouSpanA = tenkanSen && kijunSen ? tenkanSen.plus(kijunSen).div(2) : null;
  const senkouSpanB = donchian(highs, lows, 52);
  const chikouSpan = closes.length > 0 ? closes[closes.length - 1] : null;

  return { tenkanSen, kijunSen, senkouSpanA, senkouSpanB, chikouSpan };
}

// -------------------- Momentum --------------------

export function rsi(closes: Decimal[], n = 14): Decimal | null {
  if (closes.length < n + 1) return null;
  const gains: Decimal[] = [];
  const losses: Decimal[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i].minus(closes[i - 1]);
    gains.push(diff.gt(0) ? diff : ZERO);
    losses.push(diff.lt(0) ? diff.abs() : ZERO);
  }

  let avgGain = sma(gains.slice(0, n), n);
  let avgLoss = sma(losses.slice(0, n), n);
  if (!avgGain || !avgLoss) return null;

  for (let i = n; i < gains.length; i++) {
    avgGain = avgGain!.times(n - 1).plus(gains[i]).div(n);
    avgLoss = avgLoss!.times(n - 1).plus(losses[i]).div(n);
  }

  if (avgLoss.eq(0)) return HUNDRED;
  const rs = avgGain.div(avgLoss);
  return HUNDRED.minus(HUNDRED.div(ONE.plus(rs)));
}

export interface StochasticResult {
  k: Decimal | null;
  d: Decimal | null;
}

export function stochastic(
  highs: Decimal[],
  lows: Decimal[],
  closes: Decimal[],
  n = 14,
  kSmooth = 3,
  dSmooth = 3
): StochasticResult {
  if (closes.length < n) return { k: null, d: null };
  const rawKs: Decimal[] = [];
  for (let i = n - 1; i < closes.length; i++) {
    const hh = Decimal.max(...highs.slice(i - n + 1, i + 1));
    const ll = Decimal.min(...lows.slice(i - n + 1, i + 1));
    const k = closes[i].minus(ll).div(hh.minus(ll)).times(100);
    rawKs.push(k);
  }
  const k = sma(rawKs.slice(-kSmooth), kSmooth);
  const dSeries: Decimal[] = [];
  for (let i = dSmooth - 1; i < rawKs.length; i++) {
    dSeries.push(sma(rawKs.slice(i - dSmooth + 1, i + 1), dSmooth)!);
  }
  const d = sma(dSeries.slice(-dSmooth), dSmooth);
  return { k, d };
}

export function cci(
  highs: Decimal[],
  lows: Decimal[],
  closes: Decimal[],
  n = 20
): Decimal | null {
  if (closes.length < n) return null;
  const tps: Decimal[] = [];
  for (let i = 0; i < closes.length; i++) {
    tps.push(highs[i].plus(lows[i]).plus(closes[i]).div(3));
  }
  const tpSma = sma(tps.slice(-n), n);
  if (!tpSma) return null;
  const meanDev = tps
    .slice(-n)
    .reduce((acc, tp) => acc.plus(tp.minus(tpSma).abs()), ZERO)
    .div(n);
  if (meanDev.eq(0)) return null;
  return tps[tps.length - 1].minus(tpSma).div(meanDev.times(0.015));
}

export function williamsR(
  highs: Decimal[],
  lows: Decimal[],
  closes: Decimal[],
  n = 14
): Decimal | null {
  if (closes.length < n) return null;
  const hh = Decimal.max(...highs.slice(-n));
  const ll = Decimal.min(...lows.slice(-n));
  const denom = hh.minus(ll);
  if (denom.eq(0)) return null;
  return hh.minus(closes[closes.length - 1]).div(denom).times(-100);
}

export function roc(closes: Decimal[], n = 12): Decimal | null {
  if (closes.length <= n) return null;
  const prev = closes[closes.length - 1 - n];
  const cur = closes[closes.length - 1];
  return cur.minus(prev).div(prev).times(100);
}

// -------------------- Volatility --------------------

export interface BollingerBandsResult {
  middle: Decimal | null;
  upper: Decimal | null;
  lower: Decimal | null;
}

export function bollingerBands(
  closes: Decimal[],
  n = 20,
  k = 2
): BollingerBandsResult {
  if (closes.length < n) return { middle: null, upper: null, lower: null };
  const middle = sma(closes.slice(-n), n)!;
  const sd = stdDev(closes.slice(-n));
  const width = sd.times(k);
  return { middle, upper: middle.plus(width), lower: middle.minus(width) };
}

export function atr(
  candles: { high: Decimal; low: Decimal; close: Decimal }[],
  n = 14
): Decimal | null {
  if (candles.length < n + 1) return null;
  const trs: Decimal[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    trs.push(
      Decimal.max(
        cur.high.minus(cur.low),
        cur.high.minus(prev.close).abs(),
        cur.low.minus(prev.close).abs()
      )
    );
  }
  return ema(trs, n);
}

export { stdDev };

export interface KeltnerChannelsResult {
  middle: Decimal | null;
  upper: Decimal | null;
  lower: Decimal | null;
}

export function keltnerChannels(
  candles: { high: Decimal; low: Decimal; close: Decimal }[],
  emaN = 20,
  atrN = 14,
  multiplier = 2
): KeltnerChannelsResult {
  const closes = candles.map((c) => c.close);
  const middle = ema(closes, emaN);
  const atrValue = atr(candles, atrN);
  if (!middle || !atrValue) return { middle: null, upper: null, lower: null };
  const width = atrValue.times(multiplier);
  return { middle, upper: middle.plus(width), lower: middle.minus(width) };
}

// -------------------- Volume --------------------

export function obv(closes: Decimal[], volumes: Decimal[]): Decimal | null {
  if (closes.length < 2 || volumes.length < 2) return null;
  let obvValue = ZERO;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i].gt(closes[i - 1])) obvValue = obvValue.plus(volumes[i]);
    else if (closes[i].lt(closes[i - 1])) obvValue = obvValue.minus(volumes[i]);
  }
  return obvValue;
}

export function vwap(
  candles: { high: Decimal; low: Decimal; close: Decimal; volume: Decimal }[]
): Decimal | null {
  if (candles.length === 0) return null;
  let cumulativeTPV = ZERO;
  let cumulativeVol = ZERO;
  for (const c of candles) {
    const tp = c.high.plus(c.low).plus(c.close).div(3);
    cumulativeTPV = cumulativeTPV.plus(tp.times(c.volume));
    cumulativeVol = cumulativeVol.plus(c.volume);
  }
  if (cumulativeVol.eq(0)) return null;
  return cumulativeTPV.div(cumulativeVol);
}

export function mfi(
  highs: Decimal[],
  lows: Decimal[],
  closes: Decimal[],
  volumes: Decimal[],
  n = 14
): Decimal | null {
  if (closes.length < n + 1) return null;
  const tps: Decimal[] = [];
  const raws: Decimal[] = [];
  for (let i = 0; i < closes.length; i++) {
    tps.push(highs[i].plus(lows[i]).plus(closes[i]).div(3));
  }
  for (let i = 1; i < tps.length; i++) {
    raws.push(tps[i].times(volumes[i]));
  }
  const pos: Decimal[] = [];
  const neg: Decimal[] = [];
  for (let i = 0; i < raws.length; i++) {
    const diff = tps[i + 1].minus(tps[i]);
    if (diff.gte(0)) pos.push(raws[i]);
    else neg.push(raws[i].abs());
  }
  const posSum = pos.slice(-n).reduce((a, b) => a.plus(b), ZERO);
  const negSum = neg.slice(-n).reduce((a, b) => a.plus(b), ZERO);
  if (negSum.eq(0)) return HUNDRED;
  const ratio = posSum.div(negSum);
  return HUNDRED.minus(HUNDRED.div(ONE.plus(ratio)));
}

// -------------------- Price Levels --------------------

export interface PivotPointsResult {
  pivot: Decimal;
  r1: Decimal;
  s1: Decimal;
  r2: Decimal;
  s2: Decimal;
}

export function pivotPoints(
  high: Decimal,
  low: Decimal,
  close: Decimal
): PivotPointsResult {
  const pivot = high.plus(low).plus(close).div(3);
  const range = high.minus(low);
  return {
    pivot,
    r1: pivot.times(2).minus(low),
    s1: pivot.times(2).minus(high),
    r2: pivot.plus(range),
    s2: pivot.minus(range),
  };
}

export interface FibonacciResult {
  retracements: Record<string, Decimal>;
  extensions: Record<string, Decimal>;
}

export function fibonacciLevels(
  swingLow: Decimal,
  swingHigh: Decimal
): FibonacciResult {
  const diff = swingHigh.minus(swingLow);
  const retracements: Record<string, Decimal> = {
    '23.6%': swingHigh.minus(diff.times(0.236)),
    '38.2%': swingHigh.minus(diff.times(0.382)),
    '50%': swingHigh.minus(diff.times(0.5)),
    '61.8%': swingHigh.minus(diff.times(0.618)),
    '78.6%': swingHigh.minus(diff.times(0.786)),
  };
  const extensions: Record<string, Decimal> = {
    '127.2%': swingHigh.plus(diff.times(0.272)),
    '161.8%': swingHigh.plus(diff.times(0.618)),
  };
  return { retracements, extensions };
}

// -------------------- Regime / Persistence --------------------

/**
 * Hurst exponent via Rescaled Range (R/S) analysis on a return series.
 * Uses window sizes from minWindow to maxWindow, regressing log(R/S) on log(n).
 * H > 0.55 suggests persistence/trending; H < 0.45 suggests mean-reversion;
 * 0.45-0.55 is random walk. Returns null if insufficient data.
 */
export function hurstExponent(
  returns: Decimal[],
  minWindow = 8,
  maxWindow = 100
): number | null {
  if (returns.length < minWindow * 2) return null;

  const upper = Math.min(maxWindow, Math.floor(returns.length / 2));
  const windows: number[] = [];
  for (let n = minWindow; n <= upper; n = Math.floor(n * 1.5)) {
    windows.push(n);
  }
  if (windows.length < 3) return null;

  const logN: number[] = [];
  const logRS: number[] = [];

  for (const n of windows) {
    const rsValues: number[] = [];
    for (let start = 0; start + n <= returns.length; start += n) {
      const slice = returns.slice(start, start + n);
      const mean = slice.reduce((a, b) => a.plus(b), ZERO).div(n);
      const deviations = slice.map((r) => r.minus(mean));
      const cumulative = deviations.reduce<number[]>(
        (acc, d) => {
          const prev = acc.length > 0 ? acc[acc.length - 1] : 0;
          acc.push(prev + d.toNumber());
          return acc;
        },
        []
      );
      const range = Math.max(...cumulative) - Math.min(...cumulative);
      const variance = slice
        .reduce((a, b) => a.plus(b.minus(mean).pow(2)), ZERO)
        .div(n)
        .toNumber();
      const std = Math.sqrt(variance) || 1e-12;
      rsValues.push(range / std);
    }
    if (rsValues.length === 0) continue;
    const avgRS = rsValues.reduce((a, b) => a + b, 0) / rsValues.length;
    if (avgRS > 0) {
      logN.push(Math.log(n));
      logRS.push(Math.log(avgRS));
    }
  }

  if (logN.length < 3) return null;
  return linearRegressionSlope(logN, logRS);
}

/**
 * Variance ratio for a return series.
 * VR(q) = Var(q-period returns) / (q * Var(1-period returns))
 * VR > 1 suggests trending/persistence; VR < 1 suggests mean-reversion.
 */
export function varianceRatio(returns: Decimal[], q = 5): number | null {
  if (returns.length < q * 2 + 1) return null;

  const onePeriodReturns = returns.slice(-(q * 10));
  const qPeriodReturns: Decimal[] = [];
  for (let i = q; i < onePeriodReturns.length; i++) {
    let cum = ZERO;
    for (let j = 0; j < q; j++) {
      cum = cum.plus(onePeriodReturns[i - j]);
    }
    qPeriodReturns.push(cum);
  }

  if (qPeriodReturns.length < 5) return null;

  const var1 = variance(onePeriodReturns).toNumber();
  const varQ = variance(qPeriodReturns).toNumber();

  if (!isFinite(var1) || var1 === 0 || !isFinite(varQ)) return null;
  return varQ / (q * var1);
}

function variance(values: Decimal[]): Decimal {
  if (values.length < 2) return ZERO;
  const m = mean(values);
  return values.reduce((a, b) => a.plus(b.minus(m).pow(2)), ZERO).div(values.length);
}

function linearRegressionSlope(x: number[], y: number[]): number {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - meanX) * (y[i] - meanY);
    den += Math.pow(x[i] - meanX, 2);
  }
  if (den === 0) return 0;
  return num / den;
}

// -------------------- Risk & Performance --------------------

export function fixedFractionalPositionSize(
  equity: Decimal,
  riskPct: Decimal,
  entryPrice: Decimal,
  stopLossPrice: Decimal
): Decimal | null {
  const riskAmount = equity.times(riskPct).div(100);
  const priceRisk = entryPrice.minus(stopLossPrice).abs();
  if (priceRisk.eq(0)) return null;
  return riskAmount.div(priceRisk);
}

export function kellyCriterion(winRate: Decimal, avgWin: Decimal, avgLoss: Decimal): Decimal | null {
  if (avgLoss.eq(0)) return null;
  const b = avgWin.div(avgLoss);
  const p = winRate;
  const q = ONE.minus(p);
  const f = b.times(p).minus(q).div(b);
  return f.lt(0) ? ZERO : f;
}

export function riskRewardRatio(
  entry: Decimal,
  stopLoss: Decimal,
  takeProfit: Decimal,
  _side: 'LONG' | 'SHORT'
): Decimal | null {
  const risk = entry.minus(stopLoss).abs();
  const reward = takeProfit.minus(entry).abs();
  if (risk.eq(0)) return null;
  return reward.div(risk);
}

export function expectancy(
  winRatePct: Decimal,
  avgWin: Decimal,
  avgLoss: Decimal
): Decimal {
  const lossRatePct = HUNDRED.minus(winRatePct);
  return winRatePct.div(100).times(avgWin).minus(lossRatePct.div(100).times(avgLoss));
}

export function sharpeRatio(returns: Decimal[], riskFreeRate = 0): Decimal | null {
  if (returns.length < 2) return null;
  const excessReturns = returns.map((r) => r.minus(riskFreeRate));
  const meanExcess = mean(excessReturns);
  const sd = stdDev(excessReturns);
  if (sd.eq(0)) return null;
  return meanExcess.div(sd);
}

export function sortinoRatio(returns: Decimal[], riskFreeRate = 0): Decimal | null {
  if (returns.length < 2) return null;
  const excessReturns = returns.map((r) => r.minus(riskFreeRate));
  const meanExcess = mean(excessReturns);
  const downside = excessReturns.filter((r) => r.lt(0));
  if (downside.length === 0) return null;
  const downsideDev = stdDev(downside);
  if (downsideDev.eq(0)) return null;
  return meanExcess.div(downsideDev);
}

export function maxDrawdown(equityCurve: Decimal[]): Decimal | null {
  if (equityCurve.length < 2) return null;
  let peak = equityCurve[0];
  let maxDd = ZERO;
  for (const value of equityCurve) {
    if (value.gt(peak)) peak = value;
    const dd = value.minus(peak).div(peak);
    if (dd.lt(maxDd)) maxDd = dd;
  }
  return maxDd.times(100);
}

export function valueAtRisk(returns: Decimal[], confidence = 0.95): Decimal | null {
  if (returns.length === 0) return null;
  const sorted = [...returns].sort((a, b) => a.minus(b).toNumber());
  const index = Math.floor((1 - confidence) * sorted.length);
  return sorted[Math.max(0, index)];
}

export function winRatePct(tradesPnl: Decimal[]): Decimal {
  if (tradesPnl.length === 0) return ZERO;
  const wins = tradesPnl.filter((p) => p.gt(0)).length;
  return new Decimal(wins).div(tradesPnl.length).times(100);
}

export function averageWin(tradesPnl: Decimal[]): Decimal | null {
  const wins = tradesPnl.filter((p) => p.gt(0));
  if (wins.length === 0) return null;
  return mean(wins);
}

export function averageLoss(tradesPnl: Decimal[]): Decimal | null {
  const losses = tradesPnl.filter((p) => p.lt(0));
  if (losses.length === 0) return null;
  return mean(losses).abs();
}

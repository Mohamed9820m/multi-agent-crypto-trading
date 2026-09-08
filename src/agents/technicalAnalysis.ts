import Decimal from 'decimal.js';
import logger from '../shared/logger';
import {
  adx,
  atr,
  bollingerBands,
  cci,
  ema,
  ichimoku,
  keltnerChannels,
  macd,
  mfi,
  obv,
  parabolicSar,
  pivotPoints,
  roc,
  rsi,
  sma,
  stochastic,
  vwap,
  williamsR,
} from '../shared/indicators';
import { Candle, IndicatorValue, TechnicalAnalysis } from '../shared/types';

export interface IndicatorConfig {
  name: string;
  compute(candles: Candle[]): IndicatorValue;
}

function iv(value: Decimal | null, interpretation: string): IndicatorValue {
  return { value, interpretation };
}

export const allIndicators: IndicatorConfig[] = [
  {
    name: 'SMA(20)',
    compute: (c) => iv(sma(c.map((x) => x.close), 20), 'Trend filter: price vs 20-period SMA'),
  },
  {
    name: 'SMA(50)',
    compute: (c) => iv(sma(c.map((x) => x.close), 50), 'Medium-term trend filter'),
  },
  {
    name: 'SMA(200)',
    compute: (c) => iv(sma(c.map((x) => x.close), 200), 'Long-term trend filter'),
  },
  {
    name: 'EMA(9)',
    compute: (c) => iv(ema(c.map((x) => x.close), 9), 'Fast trend component'),
  },
  {
    name: 'EMA(21)',
    compute: (c) => iv(ema(c.map((x) => x.close), 21), 'Slow trend component'),
  },
  {
    name: 'MACD(12,26,9).line',
    compute: (c) => {
      const m = macd(c.map((x) => x.close));
      return iv(m.macdLine, m.macdLine ? (m.macdLine.gt(0) ? 'bullish' : 'bearish') : 'insufficient data');
    },
  },
  {
    name: 'MACD(12,26,9).signal',
    compute: (c) => iv(macd(c.map((x) => x.close)).signalLine, 'MACD signal line'),
  },
  {
    name: 'MACD(12,26,9).histogram',
    compute: (c) => {
      const m = macd(c.map((x) => x.close));
      return iv(m.histogram, m.histogram ? (m.histogram.gt(0) ? 'growing bullish momentum' : 'growing bearish momentum') : 'insufficient data');
    },
  },
  {
    name: 'ADX(14)',
    compute: (c) => {
      const a = adx(c, 14);
      return iv(a.adx, a.adx ? (a.adx.gte(25) ? 'strong trend' : a.adx.gte(20) ? 'trend emerging' : 'weak/ranging') : 'insufficient data');
    },
  },
  {
    name: '+DI(14)',
    compute: (c) => {
      const a = adx(c, 14);
      return iv(a.plusDi, 'Bullish directional movement');
    },
  },
  {
    name: '-DI(14)',
    compute: (c) => {
      const a = adx(c, 14);
      return iv(a.minusDi, 'Bearish directional movement');
    },
  },
  {
    name: 'ParabolicSAR',
    compute: (c) => {
      const ps = parabolicSar(c.map((x) => x.high), c.map((x) => x.low));
      return iv(ps?.sar ?? null, ps ? `trend ${ps.trend}` : 'insufficient data');
    },
  },
  {
    name: 'Ichimoku.tenkan',
    compute: (c) => iv(ichimoku(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close)).tenkanSen, 'Conversion line'),
  },
  {
    name: 'RSI(14)',
    compute: (c) => {
      const r = rsi(c.map((x) => x.close));
      return iv(r, r ? (r.gt(70) ? 'overbought' : r.lt(30) ? 'oversold' : 'neutral') : 'insufficient data');
    },
  },
  {
    name: 'Stochastic(14,3,3).k',
    compute: (c) => {
      const s = stochastic(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close));
      return iv(s.k, s.k ? (s.k.gt(80) ? 'overbought' : s.k.lt(20) ? 'oversold' : 'neutral') : 'insufficient data');
    },
  },
  {
    name: 'Stochastic(14,3,3).d',
    compute: (c) => iv(stochastic(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close)).d, 'Signal line'),
  },
  {
    name: 'CCI(20)',
    compute: (c) => {
      const v = cci(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close));
      return iv(v, v ? (v.gt(100) ? 'overbought' : v.lt(-100) ? 'oversold' : 'neutral') : 'insufficient data');
    },
  },
  {
    name: 'Williams%R(14)',
    compute: (c) => {
      const v = williamsR(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close));
      return iv(v, v ? (v.lt(-80) ? 'oversold' : v.gt(-20) ? 'overbought' : 'neutral') : 'insufficient data');
    },
  },
  {
    name: 'ROC(12)',
    compute: (c) => {
      const v = roc(c.map((x) => x.close));
      return iv(v, v ? (v.gt(0) ? 'positive momentum' : 'negative momentum') : 'insufficient data');
    },
  },
  {
    name: 'BB(20,2).middle',
    compute: (c) => iv(bollingerBands(c.map((x) => x.close)).middle, 'Bollinger middle band'),
  },
  {
    name: 'BB(20,2).upper',
    compute: (c) => iv(bollingerBands(c.map((x) => x.close)).upper, 'Upper Bollinger band'),
  },
  {
    name: 'BB(20,2).lower',
    compute: (c) => iv(bollingerBands(c.map((x) => x.close)).lower, 'Lower Bollinger band'),
  },
  {
    name: 'ATR(14)',
    compute: (c) => iv(atr(c, 14), 'Volatility measure for stops/sizing'),
  },
  {
    name: 'KC(20,14,1.5).upper',
    compute: (c) => iv(keltnerChannels(c).upper, 'Upper Keltner channel'),
  },
  {
    name: 'KC(20,14,1.5).lower',
    compute: (c) => iv(keltnerChannels(c).lower, 'Lower Keltner channel'),
  },
  {
    name: 'OBV',
    compute: (c) => iv(obv(c.map((x) => x.close), c.map((x) => x.volume)), 'Cumulative volume flow'),
  },
  {
    name: 'VWAP',
    compute: (c) => iv(vwap(c), 'Volume-weighted average price'),
  },
  {
    name: 'MFI(14)',
    compute: (c) => {
      const v = mfi(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), c.map((x) => x.volume));
      return iv(v, v ? (v.gt(80) ? 'overbought' : v.lt(20) ? 'oversold' : 'neutral') : 'insufficient data');
    },
  },
  {
    name: 'Pivot(classic).p',
    compute: (c) => {
      const last = c[c.length - 2];
      if (!last) return iv(null, 'insufficient data');
      return iv(pivotPoints(last.high, last.low, last.close).pivot, 'Classic pivot point');
    },
  },
  {
    name: 'Pivot(classic).r1',
    compute: (c) => {
      const last = c[c.length - 2];
      if (!last) return iv(null, 'insufficient data');
      return iv(pivotPoints(last.high, last.low, last.close).r1, 'Pivot resistance 1');
    },
  },
  {
    name: 'Pivot(classic).s1',
    compute: (c) => {
      const last = c[c.length - 2];
      if (!last) return iv(null, 'insufficient data');
      return iv(pivotPoints(last.high, last.low, last.close).s1, 'Pivot support 1');
    },
  },
];

export class TechnicalAnalysisAgent {
  private requiredIndicatorsByStrategy: Record<string, string[]> = {
    trendFollowing: ['EMA(9)', 'EMA(21)', 'ADX(14)', '+DI(14)', '-DI(14)', 'MACD(12,26,9).histogram', 'ATR(14)', 'RSI(14)'],
    meanReversion: ['RSI(14)', 'ADX(14)', 'BB(20,2).lower', 'BB(20,2).upper', 'ATR(14)'],
    momentumBreakout: ['BB(20,2).upper', 'BB(20,2).lower', 'KC(20,14,1.5).upper', 'KC(20,14,1.5).lower', 'ADX(14)', 'ATR(14)'],
    breakout: ['ATR(14)', 'ADX(14)'],
    scalping: ['ATR(14)'],
    grid: ['ATR(14)', 'ADX(14)'],
    fundingArb: [],
    statArb: [],
  };

  async analyze(candles: Candle[], strategyName: string): Promise<TechnicalAnalysis> {
    logger.info('TechnicalAnalysisAgent analyzing', { candles: candles.length, strategy: strategyName });

    const required = this.requiredIndicatorsByStrategy[strategyName] ?? allIndicators.map((i) => i.name);
    const indicators: Record<string, IndicatorValue> = {};

    for (const indicator of allIndicators) {
      if (required.includes(indicator.name) || required.length === 0) {
        indicators[indicator.name] = indicator.compute(candles);
      }
    }

    const bias = this.aggregateBias(indicators);
    const confidence = this.computeConfidence(indicators, bias);
    const conflicts = this.detectConflicts(indicators, bias);

    logger.info('TechnicalAnalysisAgent complete', { bias, confidence, conflicts });

    return {
      indicators,
      technicalBias: bias,
      confidence,
      conflicts,
    };
  }

  private aggregateBias(indicators: Record<string, IndicatorValue>): 'bullish' | 'bearish' | 'neutral' {
    let bullish = 0;
    let bearish = 0;

    const check = (name: string, bullishCond: boolean, bearishCond: boolean) => {
      const v = indicators[name]?.value;
      if (!v) return;
      if (bullishCond) bullish++;
      else if (bearishCond) bearish++;
    };

    const close = indicators['SMA(20)']?.value; // placeholder for price context
    if (close) {
      check('EMA(9)', indicators['EMA(9)']?.value?.gt(indicators['EMA(21)']?.value ?? Infinity) ?? false, indicators['EMA(9)']?.value?.lt(indicators['EMA(21)']?.value ?? 0) ?? false);
    }

    check('MACD(12,26,9).histogram', indicators['MACD(12,26,9).histogram']?.value?.gt(0) ?? false, indicators['MACD(12,26,9).histogram']?.value?.lt(0) ?? false);
    check('RSI(14)', indicators['RSI(14)']?.value?.gt(50) ?? false, indicators['RSI(14)']?.value?.lt(50) ?? false);
    check('+DI(14)', indicators['+DI(14)']?.value?.gt(indicators['-DI(14)']?.value ?? 0) ?? false, indicators['+DI(14)']?.value?.lt(indicators['-DI(14)']?.value ?? 0) ?? false);
    check('Stochastic(14,3,3).k', indicators['Stochastic(14,3,3).k']?.value?.gt(50) ?? false, indicators['Stochastic(14,3,3).k']?.value?.lt(50) ?? false);
    check('CCI(20)', indicators['CCI(20)']?.value?.gt(0) ?? false, indicators['CCI(20)']?.value?.lt(0) ?? false);
    check('ROC(12)', indicators['ROC(12)']?.value?.gt(0) ?? false, indicators['ROC(12)']?.value?.lt(0) ?? false);

    if (bullish > bearish + 1) return 'bullish';
    if (bearish > bullish + 1) return 'bearish';
    return 'neutral';
  }

  private computeConfidence(indicators: Record<string, IndicatorValue>, bias: 'bullish' | 'bearish' | 'neutral'): number {
    let agreeing = 0;
    let total = 0;
    const checks: { name: string; bullish: boolean; bearish: boolean }[] = [
      { name: 'EMA(9)', bullish: indicators['EMA(9)']?.value?.gt(indicators['EMA(21)']?.value ?? Infinity) ?? false, bearish: indicators['EMA(9)']?.value?.lt(indicators['EMA(21)']?.value ?? 0) ?? false },
      { name: 'MACD(12,26,9).histogram', bullish: indicators['MACD(12,26,9).histogram']?.value?.gt(0) ?? false, bearish: indicators['MACD(12,26,9).histogram']?.value?.lt(0) ?? false },
      { name: 'RSI(14)', bullish: indicators['RSI(14)']?.value?.gt(50) ?? false, bearish: indicators['RSI(14)']?.value?.lt(50) ?? false },
      { name: '+DI(14)', bullish: indicators['+DI(14)']?.value?.gt(indicators['-DI(14)']?.value ?? 0) ?? false, bearish: indicators['+DI(14)']?.value?.lt(indicators['-DI(14)']?.value ?? 0) ?? false },
      { name: 'Stochastic(14,3,3).k', bullish: indicators['Stochastic(14,3,3).k']?.value?.gt(50) ?? false, bearish: indicators['Stochastic(14,3,3).k']?.value?.lt(50) ?? false },
      { name: 'CCI(20)', bullish: indicators['CCI(20)']?.value?.gt(0) ?? false, bearish: indicators['CCI(20)']?.value?.lt(0) ?? false },
    ];

    for (const c of checks) {
      total++;
      if (bias === 'bullish' && c.bullish) agreeing++;
      if (bias === 'bearish' && c.bearish) agreeing++;
      if (bias === 'neutral' && !c.bullish && !c.bearish) agreeing++;
    }

    return total === 0 ? 0 : Math.round((agreeing / total) * 100);
  }

  private detectConflicts(indicators: Record<string, IndicatorValue>, bias: 'bullish' | 'bearish' | 'neutral'): string[] {
    const conflicts: string[] = [];
    if (bias === 'bullish') {
      if (indicators['RSI(14)']?.value?.gt(70)) conflicts.push('Trend indicators bullish but RSI overbought — mixed');
      if (indicators['MACD(12,26,9).histogram']?.value?.lt(0)) conflicts.push('Trend bullish but MACD histogram negative');
    }
    if (bias === 'bearish') {
      if (indicators['RSI(14)']?.value?.lt(30)) conflicts.push('Trend indicators bearish but RSI oversold — mixed');
      if (indicators['MACD(12,26,9).histogram']?.value?.gt(0)) conflicts.push('Trend bearish but MACD histogram positive');
    }
    if (bias === 'neutral' && indicators['ADX(14)']?.value?.gt(25)) {
      conflicts.push('ADX suggests strong trend but indicator aggregate is neutral');
    }
    return conflicts;
  }
}

export const technicalAnalysisAgent = new TechnicalAnalysisAgent();
export default technicalAnalysisAgent;

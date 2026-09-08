import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
  fixedFractionalPositionSize,
  riskRewardRatio,
  winRatePct,
  maxDrawdown,
} from '../src/shared/indicators';

const closes = Array.from({ length: 80 }, (_, i) => {
  const base = 100 + i * 0.5;
  const noise = Math.sin(i * 0.5) * 5;
  return new Decimal(base + noise);
});

const candles = closes.map((close, i) => ({
  open: close.minus(1),
  high: close.plus(2),
  low: close.minus(2),
  close,
  volume: new Decimal(1000 + i * 10),
}));

describe('Indicator library', () => {
  it('computes SMA', () => {
    const result = sma(closes, 5);
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBeGreaterThan(0);
  });

  it('computes EMA', () => {
    const result = ema(closes, 5);
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBeGreaterThan(0);
  });

  it('computes RSI', () => {
    const result = rsi(closes, 14);
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBeGreaterThanOrEqual(0);
    expect(result!.toNumber()).toBeLessThanOrEqual(100);
  });

  it('computes MACD', () => {
    const result = macd(closes);
    expect(result.macdLine).not.toBeNull();
    expect(result.signalLine).not.toBeNull();
  });

  it('computes Bollinger Bands', () => {
    const result = bollingerBands(closes);
    expect(result.upper).not.toBeNull();
    expect(result.lower).not.toBeNull();
    expect(result.upper!.gt(result.middle!)).toBe(true);
    expect(result.lower!.lt(result.middle!)).toBe(true);
  });

  it('computes ATR', () => {
    const result = atr(candles, 14);
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBeGreaterThan(0);
  });

  it('sizes positions via fixed fractional', () => {
    const size = fixedFractionalPositionSize(
      new Decimal(50),
      new Decimal(1),
      new Decimal(100),
      new Decimal(99)
    );
    expect(size).not.toBeNull();
    expect(size!.toNumber()).toBeCloseTo(0.5, 2);
  });

  it('computes risk/reward ratio', () => {
    const rr = riskRewardRatio(new Decimal(100), new Decimal(99), new Decimal(103), 'LONG');
    expect(rr).not.toBeNull();
    expect(rr!.toNumber()).toBeCloseTo(3, 2);
  });

  it('computes win rate', () => {
    const pnls = [new Decimal(10), new Decimal(-5), new Decimal(8), new Decimal(-2)].map((v) => v);
    expect(winRatePct(pnls).toNumber()).toBe(50);
  });

  it('computes max drawdown', () => {
    const curve = [100, 110, 105, 120, 115].map((v) => new Decimal(v));
    const dd = maxDrawdown(curve);
    expect(dd).not.toBeNull();
    expect(dd!.toNumber()).toBeLessThan(0);
  });
});

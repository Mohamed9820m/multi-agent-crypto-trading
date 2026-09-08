import { Candle, TradeSignal } from '../shared/types';
import { BacktestResult, BacktestMetrics } from '../shared/types';

export interface WalkForwardWindow {
  train: Candle[];
  validate: Candle[];
  test: Candle[];
}

export function createWalkForwardWindows(
  candles: Candle[],
  trainSize: number,
  validateSize: number,
  testSize: number,
  stepSize: number
): WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  for (let i = trainSize + validateSize; i + testSize <= candles.length; i += stepSize) {
    windows.push({
      train: candles.slice(i - trainSize - validateSize, i - validateSize),
      validate: candles.slice(i - validateSize, i),
      test: candles.slice(i, i + testSize),
    });
  }
  return windows;
}

export interface WalkForwardResult {
  pass: boolean;
  windows: BacktestResult[];
  stabilityScore: number;
  notes: string[];
}

export async function runWalkForward(
  candles: Candle[],
  strategy: (candles: Candle[]) => { signal: TradeSignal; pnl: number }[],
  opts: {
    trainSize: number;
    validateSize: number;
    testSize: number;
    stepSize: number;
    minTradesPerWindow: number;
    minStabilityScore: number;
  }
): Promise<WalkForwardResult> {
  const windows = createWalkForwardWindows(
    candles,
    opts.trainSize,
    opts.validateSize,
    opts.testSize,
    opts.stepSize
  );

  if (windows.length === 0) {
    return { pass: false, windows: [], stabilityScore: 0, notes: ['Insufficient data for walk-forward'] };
  }

  const results: BacktestResult[] = [];
  let totalReturnSum = 0;
  let positiveWindows = 0;

  for (const w of windows) {
    const trades = strategy(w.test);
    const pnls = trades.map((t) => t.pnl);
    const wins = pnls.filter((p) => p > 0).length;
    const losses = pnls.filter((p) => p < 0).length;
    const winPnls = pnls.filter((p) => p > 0);
    const lossPnls = pnls.filter((p) => p < 0);
    const avgWin = winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
    const avgLoss = lossPnls.length > 0 ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0;
    const totalReturn = pnls.reduce((a, b) => a + b, 0);
    const maxDd = 0; // placeholder

    const metrics: BacktestMetrics = {
      totalReturnPct: totalReturn,
      maxDrawdownPct: maxDd,
      sharpeRatio: 0,
      sortinoRatio: 0,
      winRatePct: pnls.length > 0 ? (wins / pnls.length) * 100 : 0,
      expectancy: pnls.length > 0 ? totalReturn / pnls.length : 0,
      profitFactor: losses > 0 && avgLoss !== 0 ? (wins * avgWin) / (losses * avgLoss) : 0,
      avgTradePct: pnls.length > 0 ? totalReturn / pnls.length : 0,
      calmarRatio: maxDd !== 0 ? totalReturn / Math.abs(maxDd) : 0,
      maxConsecutiveLosses: 0,
      numberOfTrades: pnls.length,
    };

    results.push({
      pass: pnls.length >= opts.minTradesPerWindow && totalReturn > 0,
      metrics,
      sampleSize: pnls.length,
      notes: [`Window return ${totalReturn.toFixed(2)}%`, `${wins} wins / ${losses} losses`],
    });

    totalReturnSum += totalReturn;
    if (totalReturn > 0) positiveWindows++;
  }

  const stabilityScore = results.length > 0 ? positiveWindows / results.length : 0;
  const avgReturn = totalReturnSum / results.length;

  return {
    pass: stabilityScore >= opts.minStabilityScore && avgReturn > 0,
    windows: results,
    stabilityScore,
    notes: [
      `${results.length} windows evaluated`,
      `Stability score: ${(stabilityScore * 100).toFixed(1)}%`,
      `Average window return: ${avgReturn.toFixed(2)}%`,
    ],
  };
}

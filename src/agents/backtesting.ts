import Decimal from 'decimal.js';
import { binanceClient } from '../shared/binance';
import logger from '../shared/logger';
import { activeStrategy } from '../strategies/playbook';
import { StrategyContext } from '../strategies/types';
import {
  BacktestResult,
  Candle,
  TechnicalAnalysis,
  TradeSignal,
} from '../shared/types';
import { maxDrawdown, sharpeRatio, sortinoRatio } from '../shared/indicators';
import technicalAnalysisAgent from './technicalAnalysis';

export class BacktestingAgent {
  async validate(
    strategyName: string,
    symbol: string,
    timeframe: string,
    trainWindow = 500,
    testWindow = 200,
    totalCandles = 2000
  ): Promise<BacktestResult> {
    logger.info('BacktestingAgent starting walk-forward validation', {
      strategy: strategyName,
      symbol,
      timeframe,
    });

    const candles = await binanceClient.getKlines(symbol, timeframe, totalCandles);
    if (candles.length < trainWindow + testWindow) {
      return {
        pass: false,
        metrics: this.emptyMetrics(),
        sampleSize: 0,
        notes: ['Insufficient historical data for walk-forward test'],
      };
    }

    const strategy = activeStrategy(strategyName);
    const allReturns: Decimal[] = [];
    const allTrades: { pnl: Decimal; win: boolean }[] = [];
    let windows = 0;

    for (let start = 0; start + trainWindow + testWindow <= candles.length; start += testWindow) {
      windows++;
      const train = candles.slice(start, start + trainWindow);
      const test = candles.slice(start + trainWindow, start + trainWindow + testWindow);

      // In a real system, re-optimize params on train here. We use fixed params for simplicity.
      const { trades, returns } = await this.runTestWindow(strategy, train, test);
      allReturns.push(...returns);
      allTrades.push(...trades);
    }

    const equityCurve = this.equityCurveFromReturns(allReturns, new Decimal(100));
    const metrics = this.computeMetrics(allTrades, allReturns, equityCurve);

    const notes: string[] = [
      `Walk-forward windows: ${windows}`,
      `Total trades: ${allTrades.length}`,
    ];

    if (allTrades.length < 30) {
      notes.push('Sample size < 30 — performance stats not statistically meaningful');
    }

    if (metrics.maxDrawdownPct < -30) {
      notes.push('Max drawdown exceeds 30% — high risk');
    }

    if (metrics.sharpeRatio < 0.5) {
      notes.push('Sharpe ratio below 0.5 — weak risk-adjusted return');
    }

    const pass =
      allTrades.length >= 30 &&
      metrics.maxDrawdownPct >= -30 &&
      metrics.sharpeRatio >= 0.5 &&
      metrics.expectancy > 0 &&
      metrics.profitFactor > 1 &&
      metrics.calmarRatio >= 0.5;

    logger.info('BacktestingAgent validation complete', { pass, metrics });

    return { pass, metrics, sampleSize: allTrades.length, notes };
  }

  private async runTestWindow(
    strategy: ReturnType<typeof activeStrategy>,
    _train: Candle[],
    test: Candle[]
  ): Promise<{ trades: { pnl: Decimal; win: boolean }[]; returns: Decimal[] }> {
    const trades: { pnl: Decimal; win: boolean }[] = [];
    const returns: Decimal[] = [];
    let position: { side: 'LONG' | 'SHORT'; entry: Decimal; stopLoss: Decimal; takeProfit: Decimal } | null = null;

    for (let i = 50; i < test.length - 1; i++) {
      const window = test.slice(0, i + 1);
      const prev = test[i - 1];
      const cur = test[i];

      const technicalAnalysis: TechnicalAnalysis = await technicalAnalysisAgent.analyze(window, strategy.name);

      const ctx: StrategyContext = {
        symbol: 'BTCUSDT',
        timeframe: '1h',
        marketData: {
          symbol: 'BTCUSDT',
          timeframe: '1h',
          candles: window,
          orderBook: { lastUpdateId: 0, bids: [], asks: [] },
          ticker24h: {
            priceChange: new Decimal(0),
            priceChangePercent: new Decimal(0),
            weightedAvgPrice: cur.close,
            prevClosePrice: prev.close,
            lastPrice: cur.close,
            lastQty: new Decimal(0),
            bidPrice: cur.close,
            askPrice: cur.close,
            openPrice: prev.close,
            highPrice: cur.high,
            lowPrice: cur.low,
            volume: cur.volume,
            quoteVolume: cur.quoteVolume,
            openTime: cur.openTime,
            closeTime: cur.closeTime,
            firstId: 0,
            lastId: 0,
            count: 0,
          },
          dataQualityFlags: [],
        },
        technicalAnalysis,
        sentiment: { sentimentScore: 0, keyEvents: [], sources: [] },
      };

      const signal: TradeSignal = strategy.computeSignal(ctx);

      // Close existing position if signal flips or target/stop hit.
      if (position) {
        let exit: Decimal | null = null;
        if (position.side === 'LONG') {
          if (cur.low.lte(position.stopLoss)) exit = position.stopLoss;
          else if (cur.high.gte(position.takeProfit)) exit = position.takeProfit;
          else if (signal.signal === 'short') exit = cur.close;
        } else {
          if (cur.high.gte(position.stopLoss)) exit = position.stopLoss;
          else if (cur.low.lte(position.takeProfit)) exit = position.takeProfit;
          else if (signal.signal === 'long') exit = cur.close;
        }

        if (exit) {
          const pnl = position.side === 'LONG'
            ? exit.minus(position.entry).div(position.entry)
            : position.entry.minus(exit).div(position.entry);
          trades.push({ pnl, win: pnl.gt(0) });
          returns.push(pnl);
          position = null;
        }
      }

      // Open new position.
      if (!position && (signal.signal === 'long' || signal.signal === 'short')) {
        const side = signal.signal === 'long' ? 'LONG' : 'SHORT';
        const entry = cur.close;
        const stopLoss = strategy.computeStopLoss(ctx, side, entry);
        const takeProfit = strategy.computeTakeProfit(ctx, side, entry, stopLoss);
        if (takeProfit) {
          position = { side, entry, stopLoss, takeProfit };
        }
      }
    }

    return { trades, returns };
  }

  private equityCurveFromReturns(returns: Decimal[], initial: Decimal): Decimal[] {
    const curve: Decimal[] = [initial];
    let equity = initial;
    for (const r of returns) {
      equity = equity.times(r.plus(1));
      curve.push(equity);
    }
    return curve;
  }

  private computeMetrics(
    trades: { pnl: Decimal; win: boolean }[],
    returns: Decimal[],
    equityCurve: Decimal[]
  ) {
    const wins = trades.filter((t) => t.win);
    const losses = trades.filter((t) => !t.win);
    const winRatePct = trades.length ? (wins.length / trades.length) * 100 : 0;
    const avgWin = wins.length
      ? wins.reduce((a, t) => a.plus(t.pnl), new Decimal(0)).div(wins.length).times(100).toNumber()
      : 0;
    const avgLoss = losses.length
      ? losses.reduce((a, t) => a.plus(t.pnl.abs()), new Decimal(0)).div(losses.length).times(100).toNumber()
      : 0;
    const expectancy = trades.length
      ? (winRatePct / 100) * avgWin - ((100 - winRatePct) / 100) * avgLoss
      : 0;
    const totalReturn = equityCurve.length > 1
      ? equityCurve[equityCurve.length - 1].minus(equityCurve[0]).div(equityCurve[0]).times(100).toNumber()
      : 0;
    const maxDd = maxDrawdown(equityCurve)?.toNumber() ?? 0;
    const calmar = Math.abs(maxDd) > 0 ? totalReturn / Math.abs(maxDd) : 0;
    const avgTrade = trades.length ? totalReturn / trades.length : 0;
    const profitFactor =
      avgLoss > 0 && losses.length > 0
        ? (wins.length * avgWin) / (losses.length * avgLoss)
        : 0;

    let maxConsecutiveLosses = 0;
    let currentStreak = 0;
    for (const t of trades) {
      if (!t.win) {
        currentStreak++;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentStreak);
      } else {
        currentStreak = 0;
      }
    }

    return {
      totalReturnPct: Number(totalReturn.toFixed(2)),
      maxDrawdownPct: Number(maxDd.toFixed(2)),
      sharpeRatio: Number((sharpeRatio(returns)?.toNumber() ?? 0).toFixed(2)),
      sortinoRatio: Number((sortinoRatio(returns)?.toNumber() ?? 0).toFixed(2)),
      winRatePct: Number(winRatePct.toFixed(2)),
      expectancy: Number(expectancy.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      avgTradePct: Number(avgTrade.toFixed(3)),
      calmarRatio: Number(calmar.toFixed(2)),
      maxConsecutiveLosses,
      numberOfTrades: trades.length,
    };
  }

  private emptyMetrics() {
    return {
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      winRatePct: 0,
      expectancy: 0,
      profitFactor: 0,
      avgTradePct: 0,
      calmarRatio: 0,
      maxConsecutiveLosses: 0,
      numberOfTrades: 0,
    };
  }
}

export const backtestingAgent = new BacktestingAgent();
export default backtestingAgent;

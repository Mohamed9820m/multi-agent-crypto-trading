import db from './db';
import logger from './logger';

export interface StrategyPerformance {
  strategy: string;
  trades: number;
  wins: number;
  winRate: number;
  sharpe: number | null;
  averageWin: number;
  averageLoss: number;
  profitFactor: number | null;
  kellyFraction: number | null;
}

const MIN_TRADES_FOR_KELLY = 30;

class StrategyPerformanceTracker {
  private cache = new Map<string, StrategyPerformance>();
  private lastUpdated = 0;
  private readonly ttlMs = 60_000;

  async getPerformance(strategy: string): Promise<StrategyPerformance> {
    const now = Date.now();
    if (now - this.lastUpdated > this.ttlMs || !this.cache.has(strategy)) {
      await this.refresh();
    }
    return (
      this.cache.get(strategy) ?? {
        strategy,
        trades: 0,
        wins: 0,
        winRate: 0,
        sharpe: null,
        averageWin: 0,
        averageLoss: 0,
        profitFactor: null,
        kellyFraction: null,
      }
    );
  }

  private async refresh(): Promise<void> {
    try {
      const rows = await db.query<
        {
          strategy: string;
          trades: number;
          wins: number;
          avg_win: number | null;
          avg_loss: number | null;
          pnls: number[];
        }
      >(
        `SELECT
          strategy,
          COUNT(*) AS trades,
          COUNT(*) FILTER (WHERE realized_pnl > 0) AS wins,
          AVG(realized_pnl) FILTER (WHERE realized_pnl > 0) AS avg_win,
          AVG(realized_pnl) FILTER (WHERE realized_pnl < 0) AS avg_loss,
          ARRAY_AGG(realized_pnl ORDER BY closed_at) AS pnls
         FROM positions
         WHERE status = 'closed' AND strategy IS NOT NULL
         GROUP BY strategy`
      );

      const newCache = new Map<string, StrategyPerformance>();
      for (const row of rows) {
        const winRate = row.trades > 0 ? row.wins / row.trades : 0;
        const avgWin = row.avg_win ?? 0;
        const avgLoss = Math.abs(row.avg_loss ?? 0);
        const profitFactor =
          avgLoss === 0 || row.wins === 0
            ? null
            : (avgWin * row.wins) / (avgLoss * (row.trades - row.wins));
        const sharpe = this.sharpe(row.pnls ?? []);
        const kellyFraction =
          row.trades >= MIN_TRADES_FOR_KELLY && avgLoss > 0
            ? this.kelly(winRate, avgWin, avgLoss)
            : null;

        newCache.set(row.strategy, {
          strategy: row.strategy,
          trades: Number(row.trades),
          wins: Number(row.wins),
          winRate,
          sharpe,
          averageWin: avgWin,
          averageLoss: avgLoss,
          profitFactor,
          kellyFraction,
        });
      }

      this.cache = newCache;
      this.lastUpdated = Date.now();
    } catch (err) {
      logger.error('StrategyPerformanceTracker refresh failed', { err: (err as Error).message });
    }
  }

  private sharpe(pnls: number[]): number | null {
    if (pnls.length < 2) return null;
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pnls.length;
    const std = Math.sqrt(variance);
    if (std === 0) return null;
    return mean / std;
  }

  private kelly(winRate: number, avgWin: number, avgLoss: number): number {
    if (avgLoss === 0) return 0;
    const b = avgWin / avgLoss;
    const q = 1 - winRate;
    const f = (b * winRate - q) / b;
    return Math.max(0, f);
  }
}

export const strategyPerformanceTracker = new StrategyPerformanceTracker();
export default strategyPerformanceTracker;

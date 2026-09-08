import { AccountState, MarketData, PortfolioState } from '../shared/types';

export interface CircuitBreakerResult {
  triggered: boolean;
  reason?: string;
  severity: 'info' | 'warning' | 'critical';
}

export class CircuitBreakerAgent {
  private lastExecutionErrors: number[] = [];

  check(
    account: AccountState,
    marketData: MarketData,
    portfolio: PortfolioState,
    opts: {
      maxDailyLossPct?: number;
      maxDrawdownPct?: number;
      maxSpreadPct?: number;
      maxGrossExposurePct?: number;
      maxExecutionErrorRate?: number;
    } = {}
  ): CircuitBreakerResult {
    const {
      maxDailyLossPct = 3,
      maxDrawdownPct = 10,
      maxSpreadPct = 1,
      maxGrossExposurePct = 200,
      maxExecutionErrorRate = 0.3,
    } = opts;

    // Daily loss limit
    const dailyLossPct = account.equityEUR.gt(0)
      ? account.dailyRealizedPnlEUR.div(account.equityEUR).times(100).toNumber()
      : 0;
    if (dailyLossPct <= -maxDailyLossPct) {
      return {
        triggered: true,
        reason: `Daily loss ${dailyLossPct.toFixed(2)}% exceeded limit -${maxDailyLossPct}%`,
        severity: 'critical',
      };
    }

    // Max drawdown
    if (portfolio.maxDrawdownPct >= maxDrawdownPct) {
      return {
        triggered: true,
        reason: `Drawdown ${portfolio.maxDrawdownPct.toFixed(2)}% exceeded limit ${maxDrawdownPct}%`,
        severity: 'critical',
      };
    }

    // Stale data
    const now = Date.now();
    const lastCandleClose = marketData.candles[marketData.candles.length - 1]?.closeTime ?? 0;
    if (now - lastCandleClose > 10 * 60 * 1000) {
      return {
        triggered: true,
        reason: 'Market data stale (>10 minutes)',
        severity: 'critical',
      };
    }

    // Abnormal spread
    const bestBid = marketData.orderBook.bids[0]?.price;
    const bestAsk = marketData.orderBook.asks[0]?.price;
    const spreadPct = bestBid && bestAsk && bestAsk.gt(0)
      ? bestAsk.minus(bestBid).div(bestAsk).times(100).toNumber()
      : 0;
    if (spreadPct > maxSpreadPct) {
      return {
        triggered: true,
        reason: `Abnormal spread ${spreadPct.toFixed(3)}%`,
        severity: 'warning',
      };
    }

    // Data quality flags
    const criticalFlags = marketData.dataQualityFlags.filter((f) => f.type === 'gap' || f.type === 'stale');
    if (criticalFlags.length > 0) {
      return {
        triggered: true,
        reason: `Critical data flags: ${criticalFlags.map((f) => f.message).join('; ')}`,
        severity: 'critical',
      };
    }

    // Portfolio exposure
    const grossExposurePct = account.equityEUR.gt(0)
      ? portfolio.exposure.grossExposureEUR.div(account.equityEUR).times(100).toNumber()
      : 0;
    if (grossExposurePct > maxGrossExposurePct) {
      return {
        triggered: true,
        reason: `Gross exposure ${grossExposurePct.toFixed(2)}% exceeded ${maxGrossExposurePct}%`,
        severity: 'warning',
      };
    }

    // Execution error rate
    const recentErrors = this.lastExecutionErrors.filter((t) => now - t < 60 * 60 * 1000);
    if (recentErrors.length > 5) {
      const errorRate = recentErrors.length / Math.max(1, account.tradesToday);
      if (errorRate > maxExecutionErrorRate) {
        return {
          triggered: true,
          reason: `Execution error rate ${(errorRate * 100).toFixed(0)}% too high`,
          severity: 'critical',
        };
      }
    }

    return { triggered: false, severity: 'info' };
  }

  recordExecutionError(): void {
    this.lastExecutionErrors.push(Date.now());
    // keep last 100
    if (this.lastExecutionErrors.length > 100) {
      this.lastExecutionErrors.shift();
    }
  }

  reset(): void {
    this.lastExecutionErrors = [];
  }
}

export const circuitBreakerAgent = new CircuitBreakerAgent();
export default circuitBreakerAgent;

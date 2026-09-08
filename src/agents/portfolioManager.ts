import Decimal from 'decimal.js';
import { AccountState, PortfolioExposure, PortfolioState } from '../shared/types';

export class PortfolioManagerAgent {
  analyze(
    account: AccountState,
    proposedPosition?: { symbol: string; side: 'LONG' | 'SHORT'; notionalEUR: Decimal; strategy: string }
  ): PortfolioState {
    const openPositions = account.openPositions.filter((p) => p.status === 'open');

    const perSymbolExposure: Record<string, Decimal> = {};
    const perStrategyExposure: Record<string, Decimal> = {};
    let longExposureEUR = new Decimal(0);
    let shortExposureEUR = new Decimal(0);

    for (const p of openPositions) {
      const notional = p.entryPrice.times(p.quantity);
      perSymbolExposure[p.symbol] = (perSymbolExposure[p.symbol] ?? new Decimal(0)).plus(notional);
      perStrategyExposure[p.strategy ?? 'unknown'] = (perStrategyExposure[p.strategy ?? 'unknown'] ?? new Decimal(0)).plus(notional);

      if (p.side === 'LONG') {
        longExposureEUR = longExposureEUR.plus(notional);
      } else {
        shortExposureEUR = shortExposureEUR.plus(notional);
      }
    }

    if (proposedPosition) {
      const notional = proposedPosition.notionalEUR;
      perSymbolExposure[proposedPosition.symbol] = (perSymbolExposure[proposedPosition.symbol] ?? new Decimal(0)).plus(notional);
      perStrategyExposure[proposedPosition.strategy] = (perStrategyExposure[proposedPosition.strategy] ?? new Decimal(0)).plus(notional);
      if (proposedPosition.side === 'LONG') {
        longExposureEUR = longExposureEUR.plus(notional);
      } else {
        shortExposureEUR = shortExposureEUR.plus(notional);
      }
    }

    const grossExposureEUR = longExposureEUR.plus(shortExposureEUR);
    const netExposureEUR = longExposureEUR.minus(shortExposureEUR);

    // Simple stablecoin exposure: count USDT, USDC as stable.
    const stablecoinExposureEUR = account.cashEUR; // approximate
    const cashEUR = account.cashEUR;

    // Very rough correlated exposure heuristic: if multiple positions in same symbol or >2 positions total
    const symbolConcentration = Math.max(
      0,
      ...Object.values(perSymbolExposure).map((v) =>
        account.equityEUR.gt(0) ? v.div(account.equityEUR).toNumber() : 0
      )
    );
    const correlatedExposure = Math.min(1, symbolConcentration + openPositions.length * 0.1);

    const exposure: PortfolioExposure = {
      grossExposureEUR,
      netExposureEUR,
      longExposureEUR,
      shortExposureEUR,
      perSymbolExposure,
      perStrategyExposure,
      correlatedExposure,
      stablecoinExposureEUR,
      cashEUR,
    };

    return {
      account,
      exposure,
      openPositions,
      dailyRealizedPnlEUR: account.dailyRealizedPnlEUR,
      maxDrawdownPct: 0, // TODO: compute from account_snapshots history
    };
  }

  checkLimits(
    portfolio: PortfolioState,
    limits: {
      maxGrossExposurePct?: number;
      maxNetExposurePct?: number;
      maxSymbolConcentrationPct?: number;
      maxStrategyConcentrationPct?: number;
    }
  ): { approved: boolean; reason?: string } {
    const equity = portfolio.account.equityEUR;
    if (equity.lte(0)) return { approved: false, reason: 'Account equity is zero or negative' };

    const grossPct = portfolio.exposure.grossExposureEUR.div(equity).toNumber();
    const netPct = portfolio.exposure.netExposureEUR.abs().div(equity).toNumber();

    if (limits.maxGrossExposurePct && grossPct > limits.maxGrossExposurePct) {
      return { approved: false, reason: `Gross exposure ${grossPct.toFixed(2)} exceeds limit` };
    }
    if (limits.maxNetExposurePct && netPct > limits.maxNetExposurePct) {
      return { approved: false, reason: `Net exposure ${netPct.toFixed(2)} exceeds limit` };
    }

    for (const [symbol, exp] of Object.entries(portfolio.exposure.perSymbolExposure)) {
      const pct = exp.div(equity).toNumber();
      if (limits.maxSymbolConcentrationPct && pct > limits.maxSymbolConcentrationPct) {
        return { approved: false, reason: `Symbol concentration for ${symbol} exceeds limit` };
      }
    }

    return { approved: true };
  }
}

export const portfolioManagerAgent = new PortfolioManagerAgent();
export default portfolioManagerAgent;

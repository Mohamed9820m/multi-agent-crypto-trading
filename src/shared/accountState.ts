import Decimal from 'decimal.js';
import { binanceClient } from '../shared/binance';
import config from '../shared/config';
import db from '../shared/db';
import logger from '../shared/logger';
import { AccountState, Position } from '../shared/types';
import positionLifecycle from './positionLifecycle';

export async function loadAccountState(): Promise<AccountState> {
  logger.info('Loading account state');

    // Use testnet/paper cash default if no real balance available.
    let equityEUR = new Decimal(config.startingCapitalEUR);
    let cashEUR = new Decimal(config.startingCapitalEUR);

  try {
    const account = await binanceClient.getAccount();
    const usdt = account.balances.find((b) => b.asset === 'USDT');
    if (usdt) {
      cashEUR = usdt.free;
      equityEUR = usdt.free.plus(usdt.locked);
    }
  } catch (err) {
    logger.warn('Could not load Binance account; using paper starting capital', { err });
  }

  const openPositions = await loadOpenPositions();

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const todayTrades = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM orders WHERE timestamp >= $1 AND symbol = $2`,
    [todayStart, config.symbol]
  );
  const tradesToday = Number(todayTrades[0]?.count ?? 0);

  const realizedToday = await db.query<{ pnl: string | null }>(
    `SELECT COALESCE(SUM(realized_pnl), 0)::text as pnl FROM positions WHERE closed_at >= $1`,
    [todayStart]
  );
  const dailyRealizedPnlEUR = new Decimal(realizedToday[0]?.pnl ?? 0);

  const openExposureEUR = openPositions
    .filter((p) => p.status === 'open')
    .reduce((acc, p) => acc.plus(p.entryPrice.times(p.quantity)), new Decimal(0));

  return {
    equityEUR,
    cashEUR,
    openExposureEUR,
    dailyRealizedPnlEUR,
    tradesToday,
    openPositions,
  };
}

export async function loadOpenPositions(): Promise<Position[]> {
  return positionLifecycle.getOpenPositions();
}

export async function snapshotAccount(state: AccountState): Promise<void> {
  await db.query(
    `INSERT INTO account_snapshots (equity_eur, cash_eur, open_exposure_eur, daily_realized_pnl_eur, trades_today)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      state.equityEUR.toString(),
      state.cashEUR.toString(),
      state.openExposureEUR.toString(),
      state.dailyRealizedPnlEUR.toString(),
      state.tradesToday,
    ]
  );
}

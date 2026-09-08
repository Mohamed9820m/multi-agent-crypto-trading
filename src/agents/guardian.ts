import { binanceClient } from '../shared/binance';
import config from '../shared/config';
import db from '../shared/db';
import logger from '../shared/logger';
import redisBus from '../shared/redisBus';
import { loadAccountState } from '../shared/accountState';
import { AccountState } from '../shared/types';

export class GuardianAgent {
  private triggered = false;

  async runOnce(): Promise<void> {
    if (this.triggered) return;

    logger.info('GuardianAgent running watchdog checks');
    const account = await loadAccountState();

    const trigger = this.checkTriggers(account);
    if (trigger) {
      await this.triggerHalt(trigger.type, trigger.message, account);
    } else {
      logger.info('GuardianAgent checks passed');
    }
  }

  async runLoop(): Promise<void> {
    logger.info('GuardianAgent entering run loop');
    while (!this.triggered) {
      await this.runOnce();
      await this.sleep(30000); // 30s guardian heartbeat
    }
  }

  private checkTriggers(account: AccountState): { type: string; message: string } | null {
    // Daily realized loss exceeds hard limit.
    const dailyLossPct = account.dailyRealizedPnlEUR.div(account.equityEUR).times(100);
    if (dailyLossPct.lte(-config.maxDailyLossPct)) {
      return {
        type: 'daily_loss_limit',
        message: `Daily realized loss ${dailyLossPct.toFixed(2)}% exceeded limit -${config.maxDailyLossPct}%`,
      };
    }

    // Too many trades in one day signals a runaway loop.
    if (account.tradesToday > config.maxTradesPerDay) {
      return {
        type: 'max_trades_exceeded',
        message: `Trades today ${account.tradesToday} exceeded maximum ${config.maxTradesPerDay}`,
      };
    }

    // Account equity floor.
    if (account.equityEUR.lt(config.accountEquityFloorEUR)) {
      return {
        type: 'equity_floor',
        message: `Account equity ${account.equityEUR.toFixed(2)} EUR below floor ${config.accountEquityFloorEUR} EUR`,
      };
    }

    // Open exposure / leverage cap.
    const exposurePct = account.openExposureEUR.div(account.equityEUR).times(100);
    // For spot, 100% exposure is fully invested; for futures with leverage, much lower.
    const maxExposurePct = config.useFutures ? config.maxLeverage * 100 : 95;
    if (exposurePct.gt(maxExposurePct)) {
      return {
        type: 'max_exposure',
        message: `Open exposure ${exposurePct.toFixed(2)}% exceeds max ${maxExposurePct}%`,
      };
    }

    return null;
  }

  private async triggerHalt(type: string, message: string, account: AccountState): Promise<void> {
    this.triggered = true;
    logger.error('GuardianAgent HALT TRIGGERED', { type, message });

    await redisBus.set(
      'guardian:kill_switch',
      { triggered: true, type, message, at: new Date().toISOString() },
      86400
    );

    try {
      await binanceClient.cancelAllOpenOrders(config.symbol);
      logger.info('GuardianAgent cancelled open orders', { symbol: config.symbol });
    } catch (err) {
      logger.error('GuardianAgent failed to cancel open orders', { err });
    }

    await db.query(
      `INSERT INTO guardian_triggers (trigger_type, message, account_snapshot)
       VALUES ($1, $2, $3)`,
      [type, message, JSON.stringify(account)]
    );

    // In a real system this would send email/SMS/PagerDuty.
    logger.error('GUARDIAN ALERT — MANUAL RE-ENABLE REQUIRED', { type, message });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const guardianAgent = new GuardianAgent();
export default guardianAgent;

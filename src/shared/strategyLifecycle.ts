import db from './db';
import logger from './logger';
import { BacktestMetrics } from './types';

export type LifecycleState =
  | 'IDEA'
  | 'RESEARCH'
  | 'BACKTESTING'
  | 'VALIDATION'
  | 'PAPER'
  | 'TESTNET'
  | 'CANARY'
  | 'LIVE'
  | 'MONITORING'
  | 'DEGRADED'
  | 'SUSPENDED'
  | 'RETIRED';

export interface StrategyLifecycleRecord {
  strategyName: string;
  version: string;
  state: LifecycleState;
  capitalAllocationPct: number;
  liveTrades: number;
  liveWinRate: number;
  liveExpectancy: number;
  maxDrawdownPct: number;
  deployedAt?: Date;
  retiredAt?: Date;
  notes: string;
  updatedAt: Date;
}

export const allowedTradingStates: LifecycleState[] = ['TESTNET', 'CANARY', 'LIVE', 'MONITORING'];

export const validLifecycleTransitions: Record<LifecycleState, LifecycleState[]> = {
  IDEA: ['RESEARCH'],
  RESEARCH: ['IDEA', 'BACKTESTING'],
  BACKTESTING: ['RESEARCH', 'VALIDATION'],
  VALIDATION: ['BACKTESTING', 'PAPER'],
  PAPER: ['VALIDATION', 'TESTNET', 'SUSPENDED'],
  TESTNET: ['PAPER', 'CANARY', 'SUSPENDED'],
  CANARY: ['TESTNET', 'LIVE', 'SUSPENDED', 'DEGRADED'],
  LIVE: ['MONITORING', 'SUSPENDED', 'DEGRADED'],
  MONITORING: ['LIVE', 'SUSPENDED', 'DEGRADED'],
  DEGRADED: ['MONITORING', 'SUSPENDED'],
  SUSPENDED: ['BACKTESTING', 'TESTNET', 'RETIRED'],
  RETIRED: [],
};

/**
 * Strategy lifecycle manager.
 * Enforces staged promotion from idea → research → backtest → paper → testnet → canary → live.
 */
export class StrategyLifecycleManager {
  async getState(strategyName: string, version = '1.0.0'): Promise<StrategyLifecycleRecord | undefined> {
    const rows = await db.query<
      {
        strategy_name: string;
        version: string;
        state: LifecycleState;
        capital_allocation_pct: number;
        live_trades: number;
        live_win_rate: number;
        live_expectancy: number;
        max_drawdown_pct: number;
        deployed_at: Date | null;
        retired_at: Date | null;
        notes: string;
        updated_at: Date;
      }
    >('SELECT * FROM strategy_lifecycle WHERE strategy_name = $1 AND version = $2', [
      strategyName,
      version,
    ]);

    if (rows.length === 0) return undefined;
    const r = rows[0];
    return {
      strategyName: r.strategy_name,
      version: r.version,
      state: r.state,
      capitalAllocationPct: r.capital_allocation_pct,
      liveTrades: r.live_trades,
      liveWinRate: r.live_win_rate,
      liveExpectancy: r.live_expectancy,
      maxDrawdownPct: r.max_drawdown_pct,
      deployedAt: r.deployed_at ?? undefined,
      retiredAt: r.retired_at ?? undefined,
      notes: r.notes,
      updatedAt: r.updated_at,
    };
  }

  async initialize(strategyName: string, version = '1.0.0', initialState: LifecycleState = 'TESTNET'): Promise<void> {
    const existing = await this.getState(strategyName, version);
    if (existing) return;

    await db.query(
      `INSERT INTO strategy_lifecycle (strategy_name, version, state, capital_allocation_pct, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [strategyName, version, initialState, initialState === 'CANARY' ? 5 : initialState === 'LIVE' ? 100 : 0, 'Auto-initialized']
    );
    logger.info('Strategy lifecycle initialized', { strategyName, version, state: initialState });
  }

  async transition(
    strategyName: string,
    version: string,
    to: LifecycleState,
    reason: string,
    opts?: { capitalAllocationPct?: number; metrics?: Partial<BacktestMetrics> }
  ): Promise<boolean> {
    const current = await this.getState(strategyName, version);
    const from = current?.state ?? 'IDEA';
    const allowed = validLifecycleTransitions[from] ?? [];

    if (!allowed.includes(to)) {
      logger.warn('Invalid strategy lifecycle transition', {
        strategyName,
        version,
        from,
        to,
        reason,
      });
      return false;
    }

    const deployedAt = to === 'CANARY' || to === 'LIVE' ? 'NOW()' : null;
    const retiredAt = to === 'RETIRED' ? 'NOW()' : null;
    const allocation = opts?.capitalAllocationPct ?? current?.capitalAllocationPct ?? 0;

    await db.query(
      `INSERT INTO strategy_lifecycle (strategy_name, version, state, capital_allocation_pct, notes, deployed_at, retired_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, ${deployedAt}, ${retiredAt}, NOW())
       ON CONFLICT (strategy_name, version) DO UPDATE SET
         state = EXCLUDED.state,
         capital_allocation_pct = EXCLUDED.capital_allocation_pct,
         notes = EXCLUDED.notes,
         deployed_at = COALESCE(EXCLUDED.deployed_at, strategy_lifecycle.deployed_at),
         retired_at = COALESCE(EXCLUDED.retired_at, strategy_lifecycle.retired_at),
         updated_at = NOW()`,
      [strategyName, version, to, allocation, `${from} → ${to}: ${reason}`]
    );

    // Persist metrics if provided.
    if (opts?.metrics) {
      await db.query(
        `UPDATE strategy_lifecycle SET
           max_drawdown_pct = COALESCE($1, max_drawdown_pct)
         WHERE strategy_name = $2 AND version = $3`,
        [opts.metrics.maxDrawdownPct, strategyName, version]
      );
    }

    logger.info('Strategy lifecycle transition', {
      strategyName,
      version,
      from,
      to,
      reason,
    });
    return true;
  }

  async canTrade(strategyName: string, version = '1.0.0'): Promise<boolean> {
    const state = await this.getState(strategyName, version);
    if (!state) {
      // If no lifecycle record exists, auto-initialize conservatively.
      await this.initialize(strategyName, version, 'TESTNET');
      return true;
    }
    return allowedTradingStates.includes(state.state);
  }

  /**
   * Promote a strategy after a successful backtest / walk-forward validation.
   */
  async promoteAfterValidation(
    strategyName: string,
    version: string,
    metrics: BacktestMetrics
  ): Promise<LifecycleState> {
    const current = await this.getState(strategyName, version);
    const from = current?.state ?? 'BACKTESTING';

    if (from === 'BACKTESTING' || from === 'VALIDATION') {
      await this.transition(strategyName, version, 'PAPER', 'backtest_passed', { metrics });
      return 'PAPER';
    }
    if (from === 'PAPER') {
      await this.transition(strategyName, version, 'TESTNET', 'paper_performance_acceptable');
      return 'TESTNET';
    }
    if (from === 'TESTNET') {
      await this.transition(strategyName, version, 'CANARY', 'testnet_performance_acceptable', {
        capitalAllocationPct: 5,
      });
      return 'CANARY';
    }
    return from;
  }

  async listLive(): Promise<StrategyLifecycleRecord[]> {
    const rows = await db.query<
      {
        strategy_name: string;
        version: string;
        state: LifecycleState;
        capital_allocation_pct: number;
        live_trades: number;
        live_win_rate: number;
        live_expectancy: number;
        max_drawdown_pct: number;
        deployed_at: Date | null;
        retired_at: Date | null;
        notes: string;
        updated_at: Date;
      }
    >(
      `SELECT * FROM strategy_lifecycle WHERE state IN ('CANARY', 'LIVE', 'MONITORING') ORDER BY updated_at DESC`
    );

    return rows.map((r) => ({
      strategyName: r.strategy_name,
      version: r.version,
      state: r.state,
      capitalAllocationPct: r.capital_allocation_pct,
      liveTrades: r.live_trades,
      liveWinRate: r.live_win_rate,
      liveExpectancy: r.live_expectancy,
      maxDrawdownPct: r.max_drawdown_pct,
      deployedAt: r.deployed_at ?? undefined,
      retiredAt: r.retired_at ?? undefined,
      notes: r.notes,
      updatedAt: r.updated_at,
    }));
  }
}

export const strategyLifecycleManager = new StrategyLifecycleManager();
export default strategyLifecycleManager;

import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import db from './db';
import logger from './logger';
import { Position, Side } from './types';
import { PositionState, validTransitions } from './stateMachine';

export interface CreatePositionInput {
  cycleId?: string;
  symbol: string;
  side: Side;
  strategy?: string;
  entryPrice: Decimal;
  quantity: Decimal;
  stopLoss?: Decimal;
  takeProfit?: Decimal;
}

/**
 * Authoritative position lifecycle manager.
 * All position state transitions go through here so the database and the
 * in-memory state machine stay synchronized.
 */
export class PositionLifecycle {
  /**
   * Insert a new position record and immediately transition it to ENTRY_PENDING.
   */
  async create(input: CreatePositionInput, initialFillQty: Decimal): Promise<Position> {
    const positionId = randomUUID();
    const status = 'open' as const;

    await db.query(
      `INSERT INTO positions (position_id, symbol, strategy, side, entry_price, quantity, stop_loss, take_profit, status, state, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        positionId,
        input.symbol,
        input.strategy ?? 'unknown',
        input.side,
        input.entryPrice.toString(),
        input.quantity.toString(),
        input.stopLoss?.toString() ?? null,
        input.takeProfit?.toString() ?? null,
        status,
        'ENTRY_PENDING',
      ]
    );

    await this.logTransition(positionId, null, 'ENTRY_PENDING', 'position_created');

    const position: Position = {
      positionId,
      symbol: input.symbol,
      side: input.side,
      strategy: input.strategy,
      entryPrice: input.entryPrice,
      quantity: input.quantity,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      realizedPnl: new Decimal(0),
      unrealizedPnl: new Decimal(0),
      status,
      state: 'ENTRY_PENDING',
      openedAt: new Date(),
    };

    if (initialFillQty.gt(0)) {
      const toState: PositionState = initialFillQty.gte(input.quantity) ? 'OPEN' : 'PARTIALLY_FILLED';
      await this.transition(position.positionId, toState, `initial_fill_${initialFillQty.toFixed(6)}`);
      position.state = toState;
    }

    return position;
  }

  /**
   * Validate and apply a state transition for a position.
   */
  async transition(positionId: string, to: PositionState, reason?: string): Promise<boolean> {
    const row = await db.query<{ state: PositionState }>(
      'SELECT state FROM positions WHERE position_id = $1',
      [positionId]
    );
    if (row.length === 0) {
      logger.warn('PositionLifecycle.transition: position not found', { positionId, to });
      return false;
    }

    const from = row[0].state;
    const allowed = validTransitions[from] ?? [];
    if (!allowed.includes(to)) {
      logger.warn('PositionLifecycle.transition: invalid transition', {
        positionId,
        from,
        to,
        reason,
      });
      return false;
    }

    const closedAt = to === 'CLOSED' ? 'NOW()' : null;
    const status = to === 'CLOSED' ? 'closed' : 'open';

    await db.query(
      `UPDATE positions SET state = $1, status = $2, closed_at = COALESCE($3, closed_at) WHERE position_id = $4`,
      [to, status, closedAt, positionId]
    );
    await this.logTransition(positionId, from, to, reason);

    logger.info('Position transitioned', { positionId, from, to, reason });
    return true;
  }

  /**
   * Force a state transition without validation. Use only for reconciliation / emergency paths.
   */
  async forceTransition(positionId: string, to: PositionState, reason?: string): Promise<void> {
    const row = await db.query<{ state: PositionState }>(
      'SELECT state FROM positions WHERE position_id = $1',
      [positionId]
    );
    const from = row[0]?.state ?? null;

    const status = to === 'CLOSED' ? 'closed' : 'open';
    await db.query(
      `UPDATE positions SET state = $1, status = $2, closed_at = CASE WHEN $1 = 'CLOSED' THEN NOW() ELSE closed_at END WHERE position_id = $3`,
      [to, status, positionId]
    );
    await this.logTransition(positionId, from, to, `forced_${reason ?? 'manual'}`);
    logger.warn('Position force transitioned', { positionId, from, to, reason });
  }

  async getOpenPositions(): Promise<Position[]> {
    const rows = await db.query<
      {
        position_id: string;
        symbol: string;
        strategy: string | null;
        side: string;
        entry_price: string;
        quantity: string;
        stop_loss: string | null;
        take_profit: string | null;
        realized_pnl: string;
        unrealized_pnl: string;
        status: string;
        state: PositionState;
        opened_at: Date;
        closed_at: Date | null;
      }
    >(
      `SELECT * FROM positions WHERE status = 'open' AND state NOT IN ('CLOSED', 'RECONCILIATION_REQUIRED') ORDER BY opened_at DESC`
    );

    return rows.map((r) => ({
      positionId: r.position_id,
      symbol: r.symbol,
      side: r.side as Side,
      strategy: r.strategy ?? undefined,
      entryPrice: new Decimal(r.entry_price),
      quantity: new Decimal(r.quantity),
      stopLoss: r.stop_loss ? new Decimal(r.stop_loss) : undefined,
      takeProfit: r.take_profit ? new Decimal(r.take_profit) : undefined,
      realizedPnl: new Decimal(r.realized_pnl),
      unrealizedPnl: new Decimal(r.unrealized_pnl),
      status: r.status as 'open' | 'closed',
      state: r.state,
      openedAt: r.opened_at,
      closedAt: r.closed_at ?? undefined,
    }));
  }

  async getPositionById(positionId: string): Promise<Position | undefined> {
    const rows = await db.query<
      {
        position_id: string;
        symbol: string;
        strategy: string | null;
        side: string;
        entry_price: string;
        quantity: string;
        stop_loss: string | null;
        take_profit: string | null;
        realized_pnl: string;
        unrealized_pnl: string;
        status: string;
        state: PositionState;
        opened_at: Date;
        closed_at: Date | null;
      }
    >('SELECT * FROM positions WHERE position_id = $1', [positionId]);

    if (rows.length === 0) return undefined;
    const r = rows[0];
    return {
      positionId: r.position_id,
      symbol: r.symbol,
      side: r.side as Side,
      strategy: r.strategy ?? undefined,
      entryPrice: new Decimal(r.entry_price),
      quantity: new Decimal(r.quantity),
      stopLoss: r.stop_loss ? new Decimal(r.stop_loss) : undefined,
      takeProfit: r.take_profit ? new Decimal(r.take_profit) : undefined,
      realizedPnl: new Decimal(r.realized_pnl),
      unrealizedPnl: new Decimal(r.unrealized_pnl),
      status: r.status as 'open' | 'closed',
      state: r.state,
      openedAt: r.opened_at,
      closedAt: r.closed_at ?? undefined,
    };
  }

  async updateQuantity(positionId: string, newQuantity: Decimal, reason?: string): Promise<void> {
    await db.query('UPDATE positions SET quantity = $1 WHERE position_id = $2', [
      newQuantity.toString(),
      positionId,
    ]);
    await this.logTransition(positionId, null, null, `quantity_updated_${newQuantity.toFixed(6)}_${reason ?? ''}`);
  }

  async closePosition(positionId: string, realizedPnl: Decimal, reason?: string): Promise<void> {
    await db.query(
      `UPDATE positions SET realized_pnl = $1, unrealized_pnl = 0, status = 'closed', state = 'CLOSED', closed_at = NOW() WHERE position_id = $2`,
      [realizedPnl.toString(), positionId]
    );
    await this.logTransition(positionId, null, 'CLOSED', reason ?? 'position_closed');
  }

  private async logTransition(
    positionId: string,
    from: PositionState | null,
    to: PositionState | null,
    reason?: string
  ): Promise<void> {
    await db.query(
      `INSERT INTO position_state_history (position_id, from_state, to_state, reason) VALUES ($1, $2, $3, $4)`,
      [positionId, from, to, reason ?? null]
    );
  }
}

export const positionLifecycle = new PositionLifecycle();
export default positionLifecycle;

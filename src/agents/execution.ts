import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { binanceClient } from '../shared/binance';
import config from '../shared/config';
import db from '../shared/db';
import logger from '../shared/logger';
import { MarketData, OrderResult, RiskDecision, Side } from '../shared/types';
import { computeSlippagePct, ExecutionPlan } from '../shared/executionPlanner';
import { buildHybridExecutionPlan } from '../execution/hybridExecutionPlanner';
import { DexSwapPlan } from '../execution/types';
import { OrderResponse } from '../shared/exchangeAdapter';
import positionLifecycle from '../shared/positionLifecycle';

export interface ExecutionRequest {
  cycleId: string;
  symbol: string;
  side: Side;
  strategy?: string;
  entry: Decimal;
  stopLoss: Decimal;
  takeProfit: Decimal;
  positionSize: Decimal;
  riskDecision: RiskDecision;
}

export interface ExecutionQualityMetrics {
  decisionPrice: Decimal;
  avgFillPrice: Decimal;
  slippagePct: number;
  fees: Decimal;
  expectedCostPct: number;
  actualCostPct: number;
}

export class ExecutionHaltedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionHaltedError';
  }
}

export class ExecutionAgent {
  private consecutiveFailures = 0;

  async execute(req: ExecutionRequest, marketData: MarketData): Promise<OrderResult[]> {
    logger.info('ExecutionAgent executing', {
      cycleId: req.cycleId,
      symbol: req.symbol,
      side: req.side,
      entry: req.entry.toFixed(2),
      size: req.positionSize.toFixed(6),
    });

    const results: OrderResult[] = [];

    const hybridPlan = await buildHybridExecutionPlan(
      req.symbol,
      req.side,
      req.positionSize,
      req.entry,
      marketData,
      { style: 'patient' }
    );

    logger.info('Hybrid execution plan', {
      venue: hybridPlan.venue,
      reasoning: hybridPlan.venueSelection.reasoning,
      mempool: hybridPlan.mempoolSignal,
    });

    if (config.tradingMode === 'paper') {
      if (hybridPlan.venue === 'dex') {
        results.push(await this.simulateDexSwap(req, hybridPlan.dexPlan!));
      } else {
        results.push(await this.simulateOrder(req, 'entry', req.entry));
      }
      results.push(await this.simulateOrder(req, 'stop_loss', req.stopLoss));
      results.push(await this.simulateOrder(req, 'take_profit', req.takeProfit));
    } else if (hybridPlan.venue === 'dex' && config.dexEnabled) {
      const dexResult = await this.executeDexSwap(req, hybridPlan.dexPlan!);
      results.push(dexResult);
      // DeFi stop/target management is out of scope for the first iteration.
      logger.warn('DEX stop-loss/take-profit child orders are not yet automated');
    } else {
      const entryResult = await this.executeEntry(req, marketData, hybridPlan.cexPlan!);
      results.push(entryResult);

      if (entryResult.status === 'filled' || entryResult.status === 'partial') {
        const fillPrice = entryResult.fillPrice ?? req.entry;
        results.push(await this.placeWithRetry(() => this.placeStopLoss(req, fillPrice), 'stop-loss'));
        results.push(await this.placeWithRetry(() => this.placeTakeProfit(req, fillPrice), 'take-profit'));
      } else if (config.executionHaltOnError ?? true) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 2) {
          throw new ExecutionHaltedError(
            `Entry order failed repeatedly for ${req.symbol}; halting execution to prevent orphan risk`
          );
        }
      }
    }

    if (results[0]?.status === 'filled' || results[0]?.status === 'partial') {
      this.consecutiveFailures = 0;
    }

    await this.persistOrders(req.cycleId, req, results);
    await this.persistPosition(req, results);

    return results;
  }

  private async simulateOrder(
    req: ExecutionRequest,
    type: 'entry' | 'stop_loss' | 'take_profit',
    price: Decimal
  ): Promise<OrderResult> {
    const result: OrderResult = {
      orderId: randomUUID(),
      status: 'filled',
      fillPrice: price,
      fillQty: req.positionSize,
      fees: req.positionSize.times(price).times(0.001),
      timestamp: new Date(),
    };
    logger.info('ExecutionAgent simulated order', { type, ...this.serializeResult(result) });
    return result;
  }

  private async simulateDexSwap(req: ExecutionRequest, plan: DexSwapPlan): Promise<OrderResult> {
    const result: OrderResult = {
      orderId: randomUUID(),
      status: 'filled',
      fillPrice: req.entry,
      fillQty: req.positionSize,
      fees: req.positionSize.times(req.entry).times(0.003),
      timestamp: new Date(),
      rawResponse: { dexPlan: plan, simulated: true },
    };
    logger.info('ExecutionAgent simulated DEX swap', { ...this.serializeResult(result), dexPlan: plan });
    return result;
  }

  private async executeDexSwap(_req: ExecutionRequest, plan: DexSwapPlan): Promise<OrderResult> {
    if (!config.ethPrivateKey) {
      throw new ExecutionHaltedError('DEX execution requested but ETH_PRIVATE_KEY is not configured');
    }

    // TODO: wire up viem wallet client, sign, and submit the transaction.
    // For safety, this first iteration only logs the intended transaction.
    logger.warn('Live DEX execution not yet implemented; transaction would be submitted here', {
      dexPlan: plan,
    });

    return {
      orderId: randomUUID(),
      status: 'rejected',
      timestamp: new Date(),
      rawResponse: { dexPlan: plan, error: 'Live DEX execution not implemented' },
    };
  }

  private async executeEntry(
    req: ExecutionRequest,
    _marketData: MarketData,
    plan: ExecutionPlan
  ): Promise<OrderResult> {
    let totalFilledQty = new Decimal(0);
    let totalQuoteQty = new Decimal(0);
    let totalFees = new Decimal(0);
    let lastError: unknown = null;
    const exchangeOrderIds: string[] = [];

    for (let i = 0; i < plan.slices.length; i++) {
      const slice = plan.slices[i];
      logger.info('ExecutionAgent placing entry slice', {
        slice: i,
        symbol: req.symbol,
        side: req.side === 'LONG' ? 'BUY' : 'SELL',
        type: plan.orderType,
        quantity: slice.quantity.toString(),
        price: slice.price?.toString(),
        timeInForce: plan.timeInForce,
      });
      const response = await this.withRetry(
        () =>
          binanceClient.placeOrder({
            symbol: req.symbol,
            side: req.side === 'LONG' ? 'BUY' : 'SELL',
            type: plan.orderType,
            quantity: slice.quantity,
            price: slice.price,
            timeInForce: plan.timeInForce,
          }),
        `entry slice ${i}`
      );

      if (response instanceof Error) {
        logger.error('ExecutionAgent entry slice failed after retries', { slice: i, err: response.message });
        lastError = response;
        continue;
      }

      if (response.status && ['REJECTED', 'EXPIRED', 'CANCELED'].includes(String(response.status).toUpperCase())) {
        logger.error('ExecutionAgent entry slice rejected by exchange', { slice: i, response: response.raw });
        lastError = new Error(`Order ${response.status}: ${JSON.stringify(response.raw ?? {})}`);
        continue;
      }

      if (response.orderId) {
        exchangeOrderIds.push(response.orderId);
      }

      // Orders may be accepted without immediate fills (especially futures LIMIT/MARKET
      // orders, which often return NEW and fill asynchronously). Poll the exchange until
      // the order fills, times out, or moves to a terminal non-fill state.
      if (response.status && String(response.status).toUpperCase() === 'NEW') {
        const pollResult = await this.pollOrderFills(
          req.symbol,
          response.orderId,
          slice.quantity,
          30000,
          1000
        );
        if (pollResult.error) {
          lastError = pollResult.error;
        }
        totalFilledQty = totalFilledQty.plus(pollResult.filledQty);
        totalQuoteQty = totalQuoteQty.plus(pollResult.quoteQty);
        totalFees = totalFees.plus(pollResult.fees);
        if (pollResult.cancelledBecauseUnfilled) {
          logger.warn('ExecutionAgent entry slice cancelled after timeout with no fill', {
            slice: i,
            orderId: response.orderId,
          });
          continue;
        }
      } else {
        // MARKET / IOC / FOK orders report fills synchronously.
        if (response.fills && response.fills.length > 0) {
          for (const fill of response.fills) {
            const qty = fill.qty;
            const p = fill.price;
            totalFilledQty = totalFilledQty.plus(qty);
            totalQuoteQty = totalQuoteQty.plus(qty.times(p));
            if (fill.commission) {
              totalFees = totalFees.plus(fill.commission);
            }
          }
        } else if (response.executedQty) {
          totalFilledQty = totalFilledQty.plus(response.executedQty);
        }
      }
    }

    if (totalFilledQty.eq(0)) {
      const errMsg = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown');
      const errStack = lastError instanceof Error ? lastError.stack : undefined;
      logger.error('ExecutionAgent entry order rejected; no quantity filled', {
        err: errMsg,
        stack: errStack,
      });
      return {
        orderId: randomUUID(),
        status: 'rejected',
        timestamp: new Date(),
        rawResponse: { error: errMsg, stack: errStack },
      };
    }

    const avgFillPrice = totalQuoteQty.gt(0) ? totalQuoteQty.div(totalFilledQty) : req.entry;
    const slippagePct = computeSlippagePct(req.entry, avgFillPrice, req.side);
    const status = totalFilledQty.gte(req.positionSize) ? 'filled' : 'partial';

    return {
      orderId: randomUUID(),
      status,
      fillPrice: avgFillPrice,
      fillQty: totalFilledQty,
      fees: totalFees,
      timestamp: new Date(),
      exchangeOrderId: exchangeOrderIds[0],
      rawResponse: { plan, slippagePct, exchangeOrderIds },
    };
  }

  private async pollOrderFills(
    symbol: string,
    orderId: string,
    targetQty: Decimal,
    timeoutMs: number,
    intervalMs: number
  ): Promise<{
    filledQty: Decimal;
    quoteQty: Decimal;
    fees: Decimal;
    error?: Error;
    cancelledBecauseUnfilled: boolean;
  }> {
    let filledQty = new Decimal(0);
    let quoteQty = new Decimal(0);
    let fees = new Decimal(0);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await this.sleep(intervalMs);
      const result = await this.withRetry(() => binanceClient.getOrder(symbol, orderId), `poll ${orderId}`);

      if (result instanceof Error) {
        logger.warn('ExecutionAgent order poll failed', { orderId, err: result.message });
        continue;
      }

      const data = result as any;
      const status = String(data.status ?? '').toUpperCase();
      const execQty = new Decimal(data.executedQty ?? 0);
      const fills: Array<{ price: string; qty: string; commission?: string; commissionAsset?: string }> =
        data.fills ?? [];

      // Recompute totals from fills to capture average price and fees.
      filledQty = new Decimal(0);
      quoteQty = new Decimal(0);
      fees = new Decimal(0);
      for (const fill of fills) {
        const qty = new Decimal(fill.qty);
        const price = new Decimal(fill.price);
        filledQty = filledQty.plus(qty);
        quoteQty = quoteQty.plus(qty.times(price));
        if (fill.commission) {
          fees = fees.plus(new Decimal(fill.commission));
        }
      }

      // Fallback if executedQty is present but fills are not (some endpoints omit fills on query).
      if (filledQty.eq(0) && execQty.gt(0)) {
        filledQty = execQty;
        quoteQty = execQty.times(new Decimal(data.avgPrice ?? data.price ?? 0));
      }

      if (status === 'FILLED' || filledQty.gte(targetQty)) {
        return { filledQty, quoteQty, fees, cancelledBecauseUnfilled: false };
      }

      if (['REJECTED', 'EXPIRED', 'CANCELED'].includes(status)) {
        return {
          filledQty,
          quoteQty,
          fees,
          error: new Error(`Order ${status}: ${JSON.stringify(data)}`),
          cancelledBecauseUnfilled: false,
        };
      }
    }

    // Timeout: cancel the remaining order so we don't leave orphan working orders.
    try {
      await binanceClient.cancelOrder(symbol, orderId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('ExecutionAgent cancel after poll timeout failed', { orderId, err: msg });
    }

    return {
      filledQty,
      quoteQty,
      fees,
      error: filledQty.eq(0) ? new Error(`Order ${orderId} did not fill within ${timeoutMs}ms`) : undefined,
      cancelledBecauseUnfilled: filledQty.eq(0),
    };
  }

  private async placeStopLoss(req: ExecutionRequest, _fillPrice: Decimal): Promise<OrderResult> {
    const side: 'BUY' | 'SELL' = req.side === 'LONG' ? 'SELL' : 'BUY';

    const response: OrderResponse | Error = await this.withRetry(async () => {
      if (config.useFutures) {
        return binanceClient.placeFuturesConditionalOrder({
          symbol: req.symbol,
          side,
          quantity: req.positionSize,
          stopPrice: req.stopLoss,
          price: req.stopLoss,
          reduceOnly: true,
          algoType: 'STOP',
        });
      }
      return binanceClient.placeOrder({
        symbol: req.symbol,
        side,
        type: 'STOP_LOSS_LIMIT',
        quantity: req.positionSize,
        price: req.stopLoss,
        stopPrice: req.stopLoss,
        timeInForce: 'GTC',
      });
    });

    if (response instanceof Error) {
      logger.error('ExecutionAgent stop-loss order failed', { err: response.message });
      return {
        orderId: randomUUID(),
        status: 'rejected',
        timestamp: new Date(),
        rawResponse: response,
      };
    }

    logger.info('ExecutionAgent stop-loss order submitted', {
      symbol: req.symbol,
      side,
      orderId: response.orderId,
      stopPrice: req.stopLoss.toFixed(2),
    });
    return {
      orderId: randomUUID(),
      status: 'submitted',
      timestamp: new Date(response.transactTime || Date.now()),
      exchangeOrderId: response.orderId,
      rawResponse: response,
    };
  }

  private async placeTakeProfit(req: ExecutionRequest, _fillPrice: Decimal): Promise<OrderResult> {
    const side: 'BUY' | 'SELL' = req.side === 'LONG' ? 'SELL' : 'BUY';

    const response: OrderResponse | Error = await this.withRetry(async () => {
      if (config.useFutures) {
        return binanceClient.placeFuturesConditionalOrder({
          symbol: req.symbol,
          side,
          quantity: req.positionSize,
          stopPrice: req.takeProfit,
          price: req.takeProfit,
          reduceOnly: true,
          algoType: 'TAKE_PROFIT',
        });
      }
      return binanceClient.placeOrder({
        symbol: req.symbol,
        side,
        type: 'TAKE_PROFIT_LIMIT',
        quantity: req.positionSize,
        price: req.takeProfit,
        stopPrice: req.takeProfit,
        timeInForce: 'GTC',
      });
    });

    if (response instanceof Error) {
      logger.error('ExecutionAgent take-profit order failed', { err: response.message });
      return {
        orderId: randomUUID(),
        status: 'rejected',
        timestamp: new Date(),
        rawResponse: response,
      };
    }

    logger.info('ExecutionAgent take-profit order submitted', {
      symbol: req.symbol,
      side,
      orderId: response.orderId,
      takeProfit: req.takeProfit.toFixed(2),
    });
    return {
      orderId: randomUUID(),
      status: 'submitted',
      timestamp: new Date(response.transactTime || Date.now()),
      exchangeOrderId: response.orderId,
      rawResponse: response,
    };
  }

  private async withRetry<T>(fn: () => Promise<T>, label = 'order'): Promise<T | Error> {
    const maxRetries = config.executionMaxRetries ?? 3;
    const baseDelayMs = config.executionRetryDelayMs ?? 500;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const axiosErr = err as any;
        const detail = axiosErr.response?.data
          ? JSON.stringify(axiosErr.response.data)
          : axiosErr.message;
        // eslint-disable-next-line no-console
        console.error('ExecutionAgent raw error', { attempt, label, detail, err, responseData: axiosErr.response?.data });
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          logger.warn(`ExecutionAgent ${label} attempt ${attempt + 1}/${maxRetries + 1} failed; retrying in ${delay}ms`, {
            err: detail,
          });
          await this.sleep(delay);
        }
      }
    }

    return lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async placeWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    const result = await this.withRetry(fn, label);
    if (result instanceof Error) throw result;
    return result;
  }

  private async persistOrders(cycleId: string, req: ExecutionRequest, results: OrderResult[]): Promise<void> {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const orderType = i === 0 ? 'entry' : i === 1 ? 'stop_loss' : 'take_profit';
      const side = orderType === 'entry'
        ? (req.side === 'LONG' ? 'BUY' : 'SELL')
        : (req.side === 'LONG' ? 'SELL' : 'BUY');
      await db.query(
        `INSERT INTO orders (order_id, cycle_id, symbol, side, type, quantity, price, status, exchange_order_id, fill_price, fill_qty, fee, timestamp, raw_response)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          r.orderId,
          cycleId,
          req.symbol,
          side,
          orderType,
          (r.fillQty ?? req.positionSize).toString(),
          r.fillPrice?.toString() ?? null,
          r.status,
          r.exchangeOrderId,
          r.fillPrice?.toString() ?? null,
          r.fillQty?.toString() ?? null,
          r.fees?.toString() ?? null,
          r.timestamp,
          JSON.stringify(r.rawResponse ?? {}),
        ]
      );
    }
  }

  private async persistPosition(req: ExecutionRequest, results: OrderResult[]): Promise<void> {
    const entryResult = results.find((r) => r.status === 'filled' || r.status === 'partial');
    if (!entryResult) return;

    const initialFillQty = entryResult.fillQty ?? req.positionSize;
    await positionLifecycle.create(
      {
        cycleId: req.cycleId,
        symbol: req.symbol,
        side: req.side,
        strategy: req.strategy,
        entryPrice: entryResult.fillPrice ?? req.entry,
        quantity: req.positionSize,
        stopLoss: req.stopLoss,
        takeProfit: req.takeProfit,
      },
      initialFillQty
    );
  }

  private serializeResult(r: OrderResult): Record<string, unknown> {
    return {
      orderId: r.orderId,
      status: r.status,
      fillPrice: r.fillPrice?.toFixed?.(2),
      fillQty: r.fillQty?.toFixed?.(6),
      fees: r.fees?.toFixed?.(4),
      timestamp: r.timestamp.toISOString(),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const executionAgent = new ExecutionAgent();
export default executionAgent;

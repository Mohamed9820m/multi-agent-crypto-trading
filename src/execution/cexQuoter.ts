import Decimal from 'decimal.js';
import { binanceClient } from '../shared/binance';
import { OrderBook } from '../shared/types';
import { VenueQuote } from './types';
import { latencyMonitor } from './latencyMonitor';

/**
 * Build a CeFi (Binance) quote from the order book.
 *
 * Walks the book until the desired notional is filled and returns the
 * average fill price, cost, and estimated latency.
 */
export async function getCexQuote(
  symbol: string,
  side: 'buy' | 'sell',
  notional: Decimal
): Promise<VenueQuote | undefined> {
  try {
    const book = await latencyMonitor.measure('binance', 'getOrderBook', () =>
      binanceClient.getOrderBook(symbol, 100)
    );
    return buildCexQuoteFromBook(symbol, side, notional, book);
  } catch (err) {
    return undefined;
  }
}

export function buildCexQuoteFromBook(
  symbol: string,
  side: 'buy' | 'sell',
  notional: Decimal,
  book: OrderBook
): VenueQuote | undefined {
  const levels = side === 'buy' ? book.asks : book.bids;
  if (levels.length === 0) return undefined;

  let remaining = notional;
  let totalQty = new Decimal(0);
  let totalCost = new Decimal(0);
  const takerFeePct = 0.001;

  for (const level of levels) {
    const levelValue = level.price.times(level.quantity);
    const take = Decimal.min(remaining, levelValue);
    const qty = take.div(level.price);
    totalQty = totalQty.plus(qty);
    totalCost = totalCost.plus(take);
    remaining = remaining.minus(take);
    if (remaining.lte(0)) break;
  }

  if (totalQty.lte(0)) return undefined;

  const avgPrice = totalCost.div(totalQty);
  const slippagePct = avgPrice.minus(levels[0].price).abs().div(levels[0].price).toNumber();
  const costPct = takerFeePct + slippagePct;

  // Amount out depends on what we are buying/selling. For a notional-based
  // quote we return the quantity of the base asset that would be acquired.
  const expectedAmountOut = side === 'buy' ? totalQty : totalCost;

  return {
    venue: 'cex',
    name: 'binance',
    side,
    expectedAmountOut,
    expectedPrice: avgPrice,
    expectedCostPct: costPct,
    expectedLatencyMs: 80,
    confidence: 0.95,
    route: `${symbol} orderbook ${side}`,
  };
}

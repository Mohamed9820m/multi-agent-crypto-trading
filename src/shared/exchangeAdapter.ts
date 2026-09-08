import Decimal from 'decimal.js';
import { Candle, FundingRate, OrderBook, Side, Ticker24h } from './types';

export interface ExchangeSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: Decimal;
  stepSize: Decimal;
  minQty: Decimal;
  minNotional: Decimal;
}

export interface PublicTrade {
  id: number;
  price: Decimal;
  qty: Decimal;
  quoteQty: Decimal;
  time: number;
  isBuyerMaker: boolean;
}

export interface OrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  type:
    | 'LIMIT'
    | 'MARKET'
    | 'STOP_LOSS_LIMIT'
    | 'TAKE_PROFIT_LIMIT'
    | 'STOP'
    | 'TAKE_PROFIT'
    | 'STOP_MARKET'
    | 'TAKE_PROFIT_MARKET'
    | 'LIMIT_MAKER'
    | 'IOC'
    | 'FOK';
  quantity: Decimal;
  price?: Decimal;
  stopPrice?: Decimal;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface OrderFill {
  price: Decimal;
  qty: Decimal;
  commission?: Decimal;
  commissionAsset?: string;
}

export interface OrderResponse {
  orderId: string;
  exchangeOrderId?: string;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  side: 'BUY' | 'SELL';
  type: string;
  symbol: string;
  quantity: Decimal;
  executedQty: Decimal;
  price?: Decimal;
  stopPrice?: Decimal;
  avgFillPrice?: Decimal;
  fills: OrderFill[];
  transactTime?: number;
  raw: unknown;
}

export interface ExchangePosition {
  symbol: string;
  side: Side;
  quantity: Decimal;
  entryPrice?: Decimal;
  unrealizedPnl?: Decimal;
}

export interface RateLimitStatus {
  requestWeightUsed: number;
  orderCountUsed: number;
  connectionCount?: number;
}

/**
 * Abstract exchange adapter used by the rest of the system.
 * Any concrete exchange connector (Binance, Coinbase, etc.) must implement this.
 */
export interface ExchangeAdapter {
  readonly name: string;

  // Market data
  getExchangeInfo(symbol?: string): Promise<ExchangeSymbolInfo>;
  getTicker(symbol: string): Promise<Ticker24h>;
  getOrderBook(symbol: string, limit?: number): Promise<OrderBook>;
  getKlines(symbol: string, interval: string, limit?: number): Promise<Candle[]>;
  getTrades(symbol: string, limit?: number): Promise<PublicTrade[]>;

  // Account
  getAccount(): Promise<{ balances: { asset: string; free: Decimal; locked: Decimal }[] }>;
  getBalance(asset: string): Promise<{ free: Decimal; locked: Decimal }>;

  // Orders
  getOpenOrders(symbol?: string): Promise<unknown[]>;
  getOrder(symbol: string, orderId: string): Promise<unknown>;
  placeOrder(req: OrderRequest): Promise<OrderResponse>;
  cancelOrder(symbol: string, orderId: string): Promise<unknown>;
  replaceOrder(symbol: string, orderId: string, req: OrderRequest): Promise<OrderResponse>;

  // Positions (spot: synthetic from balances + open orders; futures: real positions)
  getPositions(): Promise<ExchangePosition[]>;

  // Derivatives-only data
  getFundingRate(symbol: string): Promise<FundingRate | undefined>;
  getOpenInterest(symbol: string): Promise<Decimal | undefined>;

  // Health / limits
  getRateLimitStatus?(): RateLimitStatus;
}

export function isSpotAdapter(adapter: ExchangeAdapter): boolean {
  // Best-effort classification: if the adapter does not expose futures-only methods reliably,
  // the caller should know from configuration. This helper is intentionally conservative.
  return adapter.name.toLowerCase().includes('spot') || !adapter.name.toLowerCase().includes('future');
}

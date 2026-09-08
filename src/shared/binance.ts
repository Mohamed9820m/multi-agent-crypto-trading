import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import Decimal from 'decimal.js';
import config from './config';
import { Candle, FundingRate, OrderBook, Ticker24h } from './types';
import {
  ExchangeAdapter,
  ExchangePosition,
  ExchangeSymbolInfo,
  OrderRequest,
  OrderResponse,
  PublicTrade,
} from './exchangeAdapter';

const SPOT_BASE = config.useTestnet
  ? 'https://testnet.binance.vision'
  : 'https://api.binance.com';

const FUTURES_BASE = config.useTestnet
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

export const BASE_URL = config.useFutures ? FUTURES_BASE : SPOT_BASE;

interface SymbolFilter {
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: string;
  stepSize: string;
  minQty: string;
  minNotional: string;
}

export class BinanceClient implements ExchangeAdapter {
  readonly name = config.useFutures ? 'binance-futures' : 'binance-spot';
  private client: AxiosInstance;
  private symbolFilters = new Map<string, SymbolFilter>();

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'X-MBX-APIKEY': config.binanceApiKey,
      },
      timeout: 30000,
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        const responseBody = error.response?.data;
        if (responseBody) {
          error.message = `${error.message}: ${JSON.stringify(responseBody)}`;
        }
        return Promise.reject(error);
      }
    );
  }

  private sign(query: string): string {
    return crypto
      .createHmac('sha256', config.binanceApiSecret)
      .update(query)
      .digest('hex');
  }

  private signedQuery(params: Record<string, unknown>): string {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const timestamp = Date.now();
    const payload = query ? `${query}&timestamp=${timestamp}` : `timestamp=${timestamp}`;
    const signature = this.sign(payload);
    return `${payload}&signature=${signature}`;
  }

  private decimalsFromTickSize(tickSize: string): number {
    return new Decimal(tickSize).log(10).negated().toNearest(1).toNumber();
  }

  private roundToTickSize(value: Decimal, tickSize: Decimal): string {
    return value.div(tickSize).toNearest(1, Decimal.ROUND_HALF_UP).times(tickSize).toFixed(tickSize.decimalPlaces());
  }

  async getExchangeInfo(symbol?: string): Promise<ExchangeSymbolInfo> {
    if (symbol && this.symbolFilters.has(symbol)) {
      const f = this.symbolFilters.get(symbol)!;
      return {
        symbol,
        status: 'TRADING',
        baseAsset: symbol.replace(/USDT$|BUSD$|USDC$/, ''),
        quoteAsset: 'USDT',
        pricePrecision: f.pricePrecision,
        quantityPrecision: f.quantityPrecision,
        tickSize: new Decimal(f.tickSize),
        stepSize: new Decimal(f.stepSize),
        minQty: new Decimal(f.minQty),
        minNotional: new Decimal(f.minNotional),
      };
    }

    const params = symbol ? { symbol } : {};
    const exchangeInfoPath = config.useFutures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    const { data } = await this.client.get(exchangeInfoPath, { params });
    const s = data.symbols.find((x: { symbol: string }) => x.symbol === symbol);
    if (!s) throw new Error(`Symbol ${symbol} not found in exchange info`);

    const priceFilter = s.filters.find((f: { filterType: string }) => f.filterType === 'PRICE_FILTER');
    const lotFilter = s.filters.find((f: { filterType: string }) => f.filterType === 'LOT_SIZE');
    const notionalFilter = s.filters.find((f: { filterType: string }) => f.filterType === 'MIN_NOTIONAL');

    const pricePrecision =
      typeof s.pricePrecision === 'number'
        ? s.pricePrecision
        : this.decimalsFromTickSize(priceFilter?.tickSize ?? '0.01');
    const quantityPrecision =
      typeof s.quantityPrecision === 'number'
        ? s.quantityPrecision
        : this.decimalsFromTickSize(lotFilter?.stepSize ?? '0.00001');

    const info: ExchangeSymbolInfo = {
      symbol: s.symbol,
      status: s.status,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      pricePrecision,
      quantityPrecision,
      tickSize: new Decimal(priceFilter?.tickSize ?? '0.01'),
      stepSize: new Decimal(lotFilter?.stepSize ?? '0.00001'),
      minQty: new Decimal(lotFilter?.minQty ?? '0'),
      minNotional: new Decimal(notionalFilter?.minNotional ?? '0'),
    };

    this.symbolFilters.set(s.symbol, {
      pricePrecision: info.pricePrecision,
      quantityPrecision: info.quantityPrecision,
      tickSize: info.tickSize.toString(),
      stepSize: info.stepSize.toString(),
      minQty: info.minQty.toString(),
      minNotional: info.minNotional.toString(),
    });

    return info;
  }

  private async loadSymbolFilters(symbol: string): Promise<SymbolFilter> {
    if (this.symbolFilters.has(symbol)) return this.symbolFilters.get(symbol)!;
    const info = await this.getExchangeInfo(symbol);
    const f: SymbolFilter = {
      pricePrecision: info.pricePrecision,
      quantityPrecision: info.quantityPrecision,
      tickSize: info.tickSize.toString(),
      stepSize: info.stepSize.toString(),
      minQty: info.minQty.toString(),
      minNotional: info.minNotional.toString(),
    };
    this.symbolFilters.set(symbol, f);
    return f;
  }

  async getTicker(symbol: string): Promise<Ticker24h> {
    return this.getTicker24h(symbol);
  }

  async getTicker24h(symbol: string): Promise<Ticker24h> {
    const path = config.useFutures ? '/fapi/v1/ticker/24hr' : '/api/v3/ticker/24hr';
    const { data } = await this.client.get(path, {
      params: { symbol },
    });
    const lastPrice = new Decimal(data.lastPrice ?? 0);
    return {
      priceChange: new Decimal(data.priceChange ?? 0),
      priceChangePercent: new Decimal(data.priceChangePercent ?? 0),
      weightedAvgPrice: new Decimal(data.weightedAvgPrice ?? 0),
      prevClosePrice: data.prevClosePrice ? new Decimal(data.prevClosePrice) : lastPrice,
      lastPrice,
      lastQty: new Decimal(data.lastQty ?? 0),
      bidPrice: data.bidPrice ? new Decimal(data.bidPrice) : lastPrice,
      askPrice: data.askPrice ? new Decimal(data.askPrice) : lastPrice,
      openPrice: new Decimal(data.openPrice ?? 0),
      highPrice: new Decimal(data.highPrice ?? 0),
      lowPrice: new Decimal(data.lowPrice ?? 0),
      volume: new Decimal(data.volume ?? 0),
      quoteVolume: new Decimal(data.quoteVolume ?? 0),
      openTime: data.openTime ?? 0,
      closeTime: data.closeTime ?? 0,
      firstId: data.firstId ?? 0,
      lastId: data.lastId ?? 0,
      count: data.count ?? 0,
    };
  }

  async getOrderBook(symbol: string, limit = 100): Promise<OrderBook> {
    const path = config.useFutures ? '/fapi/v1/depth' : '/api/v3/depth';
    const { data } = await this.client.get(path, {
      params: { symbol, limit },
    });
    return {
      lastUpdateId: data.lastUpdateId,
      bids: data.bids.map((b: string[]) => ({
        price: new Decimal(b[0]),
        quantity: new Decimal(b[1]),
      })),
      asks: data.asks.map((a: string[]) => ({
        price: new Decimal(a[0]),
        quantity: new Decimal(a[1]),
      })),
    };
  }

  async getKlines(
    symbol: string,
    interval: string,
    limit = 500
  ): Promise<Candle[]> {
    const path = config.useFutures ? '/fapi/v1/klines' : '/api/v3/klines';
    const { data } = await this.client.get(path, {
      params: { symbol, interval, limit },
    });
    return data.map((d: unknown) => {
      const row = d as (string | number)[];
      return {
        openTime: Number(row[0]),
        open: new Decimal(row[1]),
        high: new Decimal(row[2]),
        low: new Decimal(row[3]),
        close: new Decimal(row[4]),
        volume: new Decimal(row[5]),
        closeTime: Number(row[6]),
        quoteVolume: new Decimal(row[7]),
        trades: Number(row[8]),
        takerBuyBaseVolume: new Decimal(row[9]),
        takerBuyQuoteVolume: new Decimal(row[10]),
      };
    });
  }

  async getTrades(symbol: string, limit = 100): Promise<PublicTrade[]> {
    const { data } = await this.client.get('/api/v3/trades', {
      params: { symbol, limit },
    });
    return data.map((t: { id: number; price: string; qty: string; quoteQty: string; time: number; isBuyerMaker: boolean }) => ({
      id: t.id,
      price: new Decimal(t.price),
      qty: new Decimal(t.qty),
      quoteQty: new Decimal(t.quoteQty),
      time: t.time,
      isBuyerMaker: t.isBuyerMaker,
    }));
  }

  async getAccount(): Promise<{
    balances: { asset: string; free: Decimal; locked: Decimal }[];
  }> {
    if (config.useFutures) {
      const query = this.signedQuery({});
      const { data } = await this.client.get(`/fapi/v2/account?${query}`);
      return {
        balances: (data.assets ?? []).map((b: { asset: string; availableBalance: string; walletBalance: string }) => ({
          asset: b.asset,
          free: new Decimal(b.availableBalance),
          locked: new Decimal(b.walletBalance).minus(b.availableBalance),
        })),
      };
    }
    const query = this.signedQuery({});
    const { data } = await this.client.get(`/api/v3/account?${query}`);
    return {
      balances: data.balances.map((b: { asset: string; free: string; locked: string }) => ({
        asset: b.asset,
        free: new Decimal(b.free),
        locked: new Decimal(b.locked),
      })),
    };
  }

  async getBalance(asset: string): Promise<{ free: Decimal; locked: Decimal }> {
    const account = await this.getAccount();
    const b = account.balances.find((x) => x.asset === asset);
    return b ?? { free: new Decimal(0), locked: new Decimal(0) };
  }

  async getOpenOrders(symbol?: string): Promise<unknown[]> {
    const query = this.signedQuery(symbol ? { symbol } : {});
    const path = config.useFutures ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
    const { data } = await this.client.get(`${path}?${query}`);
    return data;
  }

  async getAllOrders(symbol: string, limit = 500): Promise<unknown[]> {
    const query = this.signedQuery({ symbol, limit });
    const path = config.useFutures ? '/fapi/v1/allOrders' : '/api/v3/allOrders';
    const { data } = await this.client.get(`${path}?${query}`);
    return data;
  }

  async getMyTrades(symbol: string, limit = 500): Promise<unknown[]> {
    const query = this.signedQuery({ symbol, limit });
    const path = config.useFutures ? '/fapi/v1/userTrades' : '/api/v3/myTrades';
    const { data } = await this.client.get(`${path}?${query}`);
    return data;
  }

  async getOrder(symbol: string, orderId: string): Promise<unknown> {
    const query = this.signedQuery({ symbol, orderId });
    const path = config.useFutures ? '/fapi/v1/order' : '/api/v3/order';
    const { data } = await this.client.get(`${path}?${query}`);
    return data;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResponse> {
    const filters = await this.loadSymbolFilters(req.symbol);
    const tickSize = new Decimal(filters.tickSize);
    const stepSize = new Decimal(filters.stepSize);
    const query = this.signedQuery({
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      quantity: this.roundToTickSize(req.quantity, stepSize),
      price: req.price ? this.roundToTickSize(req.price, tickSize) : undefined,
      stopPrice: req.stopPrice ? this.roundToTickSize(req.stopPrice, tickSize) : undefined,
      timeInForce: req.timeInForce,
      recvWindow: 5000,
    });
    const orderPath = config.useFutures ? '/fapi/v1/order' : '/api/v3/order';
    const { data } = await this.client.post(`${orderPath}?${query}`);

    const fills: OrderResponse['fills'] = (data.fills ?? []).map((f: { price: string; qty: string; commission?: string; commissionAsset?: string }) => ({
      price: new Decimal(f.price),
      qty: new Decimal(f.qty),
      commission: f.commission ? new Decimal(f.commission) : undefined,
      commissionAsset: f.commissionAsset,
    }));

    let avgFillPrice: Decimal | undefined;
    const execQty = new Decimal(data.executedQty ?? 0);
    if (execQty.gt(0)) {
      const totalQuote = fills.reduce((sum, f) => sum.plus(f.price.times(f.qty)), new Decimal(0));
      avgFillPrice = totalQuote.div(execQty);
    }

    return {
      orderId: String(data.orderId),
      exchangeOrderId: String(data.orderId),
      status: data.status,
      side: data.side,
      type: data.type,
      symbol: data.symbol,
      quantity: new Decimal(data.origQty),
      executedQty: execQty,
      price: data.price ? new Decimal(data.price) : undefined,
      stopPrice: data.stopPrice ? new Decimal(data.stopPrice) : undefined,
      avgFillPrice,
      fills,
      transactTime: data.transactTime,
      raw: data,
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<unknown> {
    const query = this.signedQuery({ symbol, orderId });
    const path = config.useFutures ? '/fapi/v1/order' : '/api/v3/order';
    const { data } = await this.client.delete(`${path}?${query}`);
    return data;
  }

  async cancelAllOpenOrders(symbol: string): Promise<unknown> {
    const query = this.signedQuery({ symbol });
    const path = config.useFutures ? '/fapi/v1/allOpenOrders' : '/api/v3/openOrders';
    const { data } = await this.client.delete(`${path}?${query}`);
    return data;
  }

  async replaceOrder(symbol: string, orderId: string, req: OrderRequest): Promise<OrderResponse> {
    try {
      await this.cancelOrder(symbol, orderId);
    } catch (err) {
      // If cancel fails because order already filled/canceled, proceed with new order.
      // eslint-disable-next-line no-console
      console.warn(`replaceOrder cancel step failed for ${orderId}:`, err);
    }
    return this.placeOrder(req);
  }

  /**
   * Place a USD-M futures conditional (algo) TP/SL order.
   *
   * Binance futures testnet/live requires conditional orders such as STOP,
   * STOP_MARKET, TAKE_PROFIT and TAKE_PROFIT_MARKET to be placed via the
   * /fapi/v1/algoOrder endpoint with algoType=CONDITIONAL. This method maps
   * the request to that endpoint and returns a normalised OrderResponse.
   */
  async placeFuturesConditionalOrder(req: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: Decimal;
    stopPrice: Decimal;
    price?: Decimal;
    reduceOnly?: boolean;
    closePosition?: boolean;
    algoType: 'STOP' | 'TAKE_PROFIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  }): Promise<OrderResponse> {
    const filters = await this.loadSymbolFilters(req.symbol);
    const tickSize = new Decimal(filters.tickSize);
    const stepSize = new Decimal(filters.stepSize);
    const params: Record<string, unknown> = {
      symbol: req.symbol,
      side: req.side,
      positionSide: 'BOTH',
      algoType: 'CONDITIONAL',
      type: req.algoType,
      timeInForce: 'GTC',
      reduceOnly: req.reduceOnly ?? true,
      triggerprice: this.roundToTickSize(req.stopPrice, tickSize),
    };

    if (req.price && !req.algoType.includes('MARKET')) {
      params.price = this.roundToTickSize(req.price, tickSize);
    }
    if (req.closePosition) {
      params.closePosition = true;
    } else {
      params.quantity = this.roundToTickSize(req.quantity, stepSize);
    }

    const query = this.signedQuery(params);
    const { data } = await this.client.post(`/fapi/v1/algoOrder?${query}`);

    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`Algo order failed: ${JSON.stringify(data)}`);
    }

    return {
      orderId: String(data.clientAlgoId ?? data.algoId ?? ''),
      exchangeOrderId: String(data.algoId ?? ''),
      status: 'NEW',
      side: req.side,
      type: req.algoType,
      symbol: req.symbol,
      quantity: req.quantity,
      executedQty: new Decimal(0),
      price: req.price,
      stopPrice: req.stopPrice,
      fills: [],
      raw: data,
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    // Spot adapter does not maintain synthetic positions natively.
    // The portfolio manager / position tracker maintains the authoritative position state.
    // This method returns an empty array to satisfy the ExchangeAdapter interface.
    return [];
  }

  async getFundingRate(symbol: string): Promise<FundingRate | undefined> {
    if (!config.useFutures) return undefined;
    const { data } = await this.client.get('/fapi/v1/fundingRate', {
      params: { symbol, limit: 1 },
    });
    if (!data || data.length === 0) return undefined;
    return {
      symbol: data[0].symbol,
      fundingRate: new Decimal(data[0].fundingRate),
      fundingTime: data[0].fundingTime,
    };
  }

  async getOpenInterest(symbol: string): Promise<Decimal | undefined> {
    if (!config.useFutures) return undefined;
    const { data } = await this.client.get('/fapi/v1/openInterest', {
      params: { symbol },
    });
    if (!data || !data.openInterest) return undefined;
    return new Decimal(data.openInterest);
  }
}

export const binanceClient = new BinanceClient();
export default binanceClient;

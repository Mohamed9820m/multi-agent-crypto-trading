import WebSocket from 'ws';
import axios from 'axios';
import crypto from 'crypto';
import Decimal from 'decimal.js';
import config from './config';
import logger from './logger';
import { Candle, OrderBook } from './types';

const WS_SPOT_BASE = config.useTestnet
  ? 'wss://stream.testnet.binance.vision'
  : 'wss://stream.binance.com:9443';

const WS_FUTURES_BASE = config.useTestnet
  ? 'wss://stream.binancefuture.com'
  : 'wss://fstream.binance.com';

const WS_API_BASE = config.useTestnet
  ? 'wss://ws-api.testnet.binance.vision/ws-api/v3'
  : 'wss://ws-api.binance.com/ws-api/v3';

export interface TickerSnapshot {
  symbol: string;
  lastPrice: Decimal;
  bidPrice: Decimal;
  askPrice: Decimal;
  priceChangePercent: Decimal;
  volume: Decimal;
  quoteVolume: Decimal;
  updatedAt: number;
}

export interface KlineSnapshot {
  candle: Candle;
  updatedAt: number;
}

export interface AccountUpdateEvent {
  eventType: 'ACCOUNT_UPDATE' | 'BALANCE_UPDATE' | 'OUTBOUND_ACCOUNT_POSITION';
  balances: { asset: string; free: Decimal; locked: Decimal }[];
  eventTime: number;
}

export interface OrderUpdateEvent {
  eventType: 'ORDER_TRADE_UPDATE' | 'executionReport';
  symbol: string;
  orderId: string;
  side: 'BUY' | 'SELL';
  type: string;
  status: string;
  quantity: Decimal;
  executedQty: Decimal;
  price?: Decimal;
  stopPrice?: Decimal;
  eventTime: number;
}

export type AccountEvent = AccountUpdateEvent | OrderUpdateEvent;

export class BinanceWebSocketManager {
  private marketWs?: WebSocket;
  private accountWs?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private listenKey?: string;
  private listenKeyKeepalive?: NodeJS.Timeout;

  private tickers = new Map<string, TickerSnapshot>();
  private orderBooks = new Map<string, { book: OrderBook; updatedAt: number }>();
  private klines = new Map<string, KlineSnapshot>();

  private accountHandlers: Array<(event: AccountEvent) => void> = [];
  private dataHandlers: Array<(symbol: string, kind: string, data: unknown) => void> = [];

  private reconnectDelayMs = 1000;
  private maxReconnectDelayMs = 30000;
  private isStopped = false;
  private subscribedStreams: string[] = [];

  async startMarketStreams(symbols: string[], streams: ('ticker' | 'depth' | 'kline')[], timeframe = '1h'): Promise<void> {
    this.subscribedStreams = [];
    for (const symbol of symbols) {
      const lower = symbol.toLowerCase();
      if (streams.includes('ticker')) this.subscribedStreams.push(`${lower}@ticker`);
      if (streams.includes('depth')) this.subscribedStreams.push(`${lower}@depth10`);
      if (streams.includes('kline')) this.subscribedStreams.push(`${lower}@kline_${timeframe}`);
    }

    if (this.subscribedStreams.length === 0) return;
    await this.connectMarket();
  }

  async startAccountStream(): Promise<void> {
    if (config.tradingMode === 'paper') {
      logger.info('BinanceWebSocketManager: paper mode — account stream disabled');
      return;
    }
    if (config.useTestnet) {
      logger.warn(
        'BinanceWebSocketManager: testnet user-data stream is unavailable for HMAC API keys; skipping account stream'
      );
      return;
    }
    await this.renewListenKey();
    await this.connectAccount();
  }

  stop(): void {
    this.isStopped = true;
    this.clearTimers();
    this.marketWs?.terminate();
    this.accountWs?.terminate();
    if (this.listenKey) {
      axios
        .delete(`${this.restBase()}/api/v3/userDataStream?listenKey=${this.listenKey}`, {
          headers: { 'X-MBX-APIKEY': config.binanceApiKey },
          timeout: 10000,
        })
        .catch(() => undefined);
    }
  }

  onAccountUpdate(handler: (event: AccountEvent) => void): () => void {
    this.accountHandlers.push(handler);
    return () => {
      this.accountHandlers = this.accountHandlers.filter((h) => h !== handler);
    };
  }

  onData(handler: (symbol: string, kind: string, data: unknown) => void): () => void {
    this.dataHandlers.push(handler);
    return () => {
      this.dataHandlers = this.dataHandlers.filter((h) => h !== handler);
    };
  }

  getTickerSnapshot(symbol: string): TickerSnapshot | undefined {
    return this.tickers.get(symbol.toUpperCase());
  }

  getOrderBookSnapshot(symbol: string): OrderBook | undefined {
    return this.orderBooks.get(symbol.toUpperCase())?.book;
  }

  getKlineSnapshot(symbol: string): KlineSnapshot | undefined {
    return this.klines.get(symbol.toUpperCase());
  }

  private wsBase(): string {
    return config.useFutures ? WS_FUTURES_BASE : WS_SPOT_BASE;
  }

  private restBase(): string {
    return config.useFutures
      ? config.useTestnet
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com'
      : config.useTestnet
        ? 'https://testnet.binance.vision'
        : 'https://api.binance.com';
  }

  private wsApiBase(): string {
    return WS_API_BASE;
  }

  private signQuery(params: Record<string, string | number>): string {
    const sortedKeys = Object.keys(params).sort();
    const payload = sortedKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
      .join('&');
    return crypto.createHmac('sha256', config.binanceApiSecret).update(payload).digest('hex');
  }

  private signedWsApiParams(
    extra: Record<string, string | number> = {}
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {
      apiKey: config.binanceApiKey,
      timestamp: Date.now(),
      recvWindow: 5000,
      ...extra,
    };
    const signature = this.signQuery(params);
    return { ...params, signature };
  }

  private wsApiRequest<T>(method: string, extraParams: Record<string, string | number> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsApiBase());
      const id = `uds-${Date.now()}`;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS API request timeout'));
      }, 10000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            id,
            method,
            params: this.signedWsApiParams(extraParams),
          })
        );
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const resp = JSON.parse(data.toString()) as {
            id?: string;
            status?: number;
            error?: unknown;
            result?: T;
          };
          if (resp.id !== id) return;
          clearTimeout(timer);
          ws.close();
          if (resp.status && resp.status >= 400) {
            reject(new Error(`WS API error ${resp.status}: ${JSON.stringify(resp.error)}`));
          } else {
            resolve(resp.result as T);
          }
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        ws.terminate();
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(timer);
      });
    });
  }

  private async renewListenKey(): Promise<void> {
    try {
      const result = await this.wsApiRequest<{ listenKey: string }>('userDataStream.start');
      this.listenKey = result.listenKey;
      if (this.listenKeyKeepalive) clearInterval(this.listenKeyKeepalive);
      this.listenKeyKeepalive = setInterval(async () => {
        if (!this.listenKey) return;
        try {
          await this.wsApiRequest('userDataStream.ping', { listenKey: this.listenKey });
        } catch (err) {
          logger.error('Listen key keepalive failed', { err: (err as Error).message });
        }
      }, 30 * 60 * 1000); // Binance requires keepalive every 60m; we use 30m.
    } catch (err) {
      logger.error('Failed to create user data stream listen key', { err: (err as Error).message });
      throw err;
    }
  }

  private async connectMarket(): Promise<void> {
    if (this.isStopped || this.subscribedStreams.length === 0) return;
    const url = `${this.wsBase()}/stream?streams=${this.subscribedStreams.join('/')}`;
    logger.info('BinanceWebSocketManager connecting market stream', { url });

    this.marketWs = new WebSocket(url);

    this.marketWs.on('open', () => {
      logger.info('Market WebSocket connected');
      this.reconnectDelayMs = 1000;
      this.startPing();
    });

    this.marketWs.on('message', (data: WebSocket.Data) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handleMarketPayload(payload);
      } catch (err) {
        logger.warn('Failed to parse market WebSocket message', { err: (err as Error).message });
      }
    });

    this.marketWs.on('error', (err) => {
      logger.error('Market WebSocket error', { err: err.message });
    });

    this.marketWs.on('close', () => {
      logger.warn('Market WebSocket closed');
      this.scheduleReconnect();
    });
  }

  private async connectAccount(): Promise<void> {
    if (this.isStopped || !this.listenKey) return;
    const url = `${this.wsBase()}/ws/${this.listenKey}`;
    logger.info('BinanceWebSocketManager connecting account stream');

    this.accountWs = new WebSocket(url);

    this.accountWs.on('open', () => {
      logger.info('Account WebSocket connected');
    });

    this.accountWs.on('message', (data: WebSocket.Data) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handleAccountPayload(payload);
      } catch (err) {
        logger.warn('Failed to parse account WebSocket message', { err: (err as Error).message });
      }
    });

    this.accountWs.on('error', (err) => {
      logger.error('Account WebSocket error', { err: err.message });
    });

    this.accountWs.on('close', () => {
      logger.warn('Account WebSocket closed');
      this.renewListenKey().then(() => this.connectAccount()).catch(() => this.scheduleReconnect());
    });
  }

  private handleMarketPayload(payload: { stream?: string; data?: unknown }): void {
    const stream = payload.stream;
    if (!stream) return;
    const data = payload.data as Record<string, unknown>;
    const symbol = this.extractSymbol(stream);

    if (stream.includes('@ticker')) {
      const lastPrice = new Decimal(String(data.c));
      const snapshot: TickerSnapshot = {
        symbol: symbol.toUpperCase(),
        lastPrice,
        bidPrice: data.b ? new Decimal(String(data.b)) : lastPrice,
        askPrice: data.a ? new Decimal(String(data.a)) : lastPrice,
        priceChangePercent: new Decimal(String(data.P)),
        volume: new Decimal(String(data.v)),
        quoteVolume: new Decimal(String(data.q)),
        updatedAt: Date.now(),
      };
      this.tickers.set(snapshot.symbol, snapshot);
      this.emitData(snapshot.symbol, 'ticker', snapshot);
      return;
    }

    if (stream.includes('@depth10')) {
      const isFuturesDepth = data.e === 'depthUpdate';
      const bids = (isFuturesDepth ? data.b : data.bids) as string[][];
      const asks = (isFuturesDepth ? data.a : data.asks) as string[][];
      const book: OrderBook = {
        lastUpdateId: Number(isFuturesDepth ? data.u : data.lastUpdateId),
        bids: bids.map((b) => ({ price: new Decimal(b[0]), quantity: new Decimal(b[1]) })),
        asks: asks.map((a) => ({ price: new Decimal(a[0]), quantity: new Decimal(a[1]) })),
      };
      this.orderBooks.set(symbol.toUpperCase(), { book, updatedAt: Date.now() });
      this.emitData(symbol.toUpperCase(), 'depth', book);
      return;
    }

    if (stream.includes('@kline_')) {
      const k = data.k as Record<string, unknown>;
      const candle: Candle = {
        openTime: Number(k.t),
        open: new Decimal(String(k.o)),
        high: new Decimal(String(k.h)),
        low: new Decimal(String(k.l)),
        close: new Decimal(String(k.c)),
        volume: new Decimal(String(k.v)),
        closeTime: Number(k.T),
        quoteVolume: new Decimal(String(k.q)),
        trades: Number(k.n),
        takerBuyBaseVolume: new Decimal(String(k.V)),
        takerBuyQuoteVolume: new Decimal(String(k.Q)),
      };
      this.klines.set(symbol.toUpperCase(), { candle, updatedAt: Date.now() });
      this.emitData(symbol.toUpperCase(), 'kline', candle);
    }
  }

  private handleAccountPayload(payload: Record<string, unknown>): void {
    const eventType = String(payload.e ?? payload.eventType ?? 'unknown');
    if (eventType === 'outboundAccountPosition' || eventType === 'OUTBOUND_ACCOUNT_POSITION') {
      const balances = ((payload.B as Array<{ a: string; f: string; l: string }>) ?? []).map((b) => ({
        asset: b.a,
        free: new Decimal(b.f),
        locked: new Decimal(b.l),
      }));
      const event: AccountUpdateEvent = {
        eventType: 'OUTBOUND_ACCOUNT_POSITION',
        balances,
        eventTime: Number(payload.E ?? Date.now()),
      };
      this.accountHandlers.forEach((h) => h(event));
      return;
    }

    if (eventType === 'executionReport' || eventType === 'ORDER_TRADE_UPDATE') {
      const order: OrderUpdateEvent = {
        eventType: eventType === 'ORDER_TRADE_UPDATE' ? 'ORDER_TRADE_UPDATE' : 'executionReport',
        symbol: String(payload.s ?? payload.symbol),
        orderId: String(payload.i ?? payload.orderId),
        side: String(payload.S ?? payload.side) as 'BUY' | 'SELL',
        type: String(payload.o ?? payload.type),
        status: String(payload.X ?? payload.status),
        quantity: new Decimal(String(payload.q ?? payload.quantity ?? 0)),
        executedQty: new Decimal(String(payload.z ?? payload.executedQty ?? 0)),
        price: payload.p ? new Decimal(String(payload.p)) : undefined,
        stopPrice: payload.P ? new Decimal(String(payload.P)) : undefined,
        eventTime: Number(payload.E ?? Date.now()),
      };
      this.accountHandlers.forEach((h) => h(order));
    }
  }

  private extractSymbol(stream: string): string {
    // stream examples: btcusdt@ticker, btcusdt@depth10, btcusdt@kline_1h
    const parts = stream.split('@');
    return parts[0].toUpperCase();
  }

  private emitData(symbol: string, kind: string, data: unknown): void {
    for (const handler of this.dataHandlers) {
      try {
        handler(symbol, kind, data);
      } catch (err) {
        logger.error('WebSocket data handler error', { err: (err as Error).message });
      }
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.marketWs?.readyState === WebSocket.OPEN) {
        this.marketWs.ping();
      }
      if (this.accountWs?.readyState === WebSocket.OPEN) {
        this.accountWs.ping();
      }
    }, 3 * 60 * 1000);
  }

  private scheduleReconnect(): void {
    if (this.isStopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.isStopped) return;
      logger.warn('Reconnecting WebSocket streams', { delay: this.reconnectDelayMs });
      this.connectMarket().catch(() => undefined);
      if (this.listenKey) this.connectAccount().catch(() => undefined);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
    }, this.reconnectDelayMs);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.listenKeyKeepalive) clearInterval(this.listenKeyKeepalive);
    this.reconnectTimer = undefined;
    this.pingTimer = undefined;
    this.listenKeyKeepalive = undefined;
  }
}

export const binanceWebSocketManager = new BinanceWebSocketManager();
export default binanceWebSocketManager;

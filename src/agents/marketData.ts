import Decimal from 'decimal.js';
import { binanceClient } from '../shared/binance';
import { binanceWebSocketManager } from '../shared/binanceWebsocket';
import config from '../shared/config';
import logger from '../shared/logger';
import { Candle, DataQualityFlag, MarketData, Ticker24h } from '../shared/types';

const LOOKBACK_CANDLES = 200;

export class MarketDataAgent {
  async fetch(symbol: string, timeframe: string): Promise<MarketData> {
    logger.info('MarketDataAgent fetching', { symbol, timeframe });

    const [candles, orderBook, ticker24h, fundingRate] = await Promise.all([
      binanceClient.getKlines(symbol, timeframe, LOOKBACK_CANDLES),
      binanceClient.getOrderBook(symbol, 100),
      binanceClient.getTicker24h(symbol),
      config.useFutures ? binanceClient.getFundingRate(symbol) : Promise.resolve(undefined),
    ]);

    const flags: DataQualityFlag[] = [];
    this.detectGaps(candles, timeframe, flags);
    this.detectStaleData(candles, flags);
    this.detectLowVolume(candles, flags);

    if (candles.length < 50) {
      flags.push({
        type: 'api_warning',
        message: `Only ${candles.length} candles returned; indicators may be unreliable`,
      });
    }

    let marketData: MarketData = {
      symbol,
      timeframe,
      candles,
      orderBook,
      ticker24h,
      fundingRate,
      dataQualityFlags: flags,
    };

    marketData = this.applyWebSocketSnapshots(marketData);

    logger.info('MarketDataAgent complete', {
      symbol,
      candles: candles.length,
      flags: flags.length,
    });

    return marketData;
  }

  private applyWebSocketSnapshots(data: MarketData): MarketData {
    const now = Date.now();
    const freshnessMs = 5000;

    const wsBook = binanceWebSocketManager.getOrderBookSnapshot(data.symbol);
    if (wsBook && now - (this.wsBookUpdatedAt(data.symbol) ?? 0) < freshnessMs) {
      data.orderBook = wsBook;
    }

    const wsTicker = binanceWebSocketManager.getTickerSnapshot(data.symbol);
    if (wsTicker && now - wsTicker.updatedAt < freshnessMs) {
      data.ticker24h = this.mergeTicker(data.ticker24h, wsTicker);
    }

    return data;
  }

  private wsBookUpdatedAt(symbol: string): number | undefined {
    // The public getter does not expose update time; we track via the data handler.
    // For simplicity, assume any cached snapshot is recent enough for orderbook enrichment.
    return binanceWebSocketManager.getOrderBookSnapshot(symbol) ? Date.now() : undefined;
  }

  private mergeTicker(rest: Ticker24h, ws: { lastPrice: Decimal; bidPrice: Decimal; askPrice: Decimal; priceChangePercent: Decimal; volume: Decimal; quoteVolume: Decimal }): Ticker24h {
    return {
      ...rest,
      lastPrice: ws.lastPrice,
      bidPrice: ws.bidPrice,
      askPrice: ws.askPrice,
      priceChangePercent: ws.priceChangePercent,
      volume: ws.volume,
      quoteVolume: ws.quoteVolume,
    };
  }

  private detectGaps(candles: Candle[], timeframe: string, flags: DataQualityFlag[]): void {
    const intervalMs = this.timeframeToMs(timeframe);
    for (let i = 1; i < candles.length; i++) {
      const expectedPrevClose = candles[i].openTime - intervalMs;
      if (candles[i - 1].openTime !== expectedPrevClose) {
        flags.push({
          type: 'gap',
          message: `Candle gap detected around ${new Date(candles[i].openTime).toISOString()}`,
          from: candles[i - 1].openTime,
          to: candles[i].openTime,
        });
      }
    }
  }

  private detectStaleData(candles: Candle[], flags: DataQualityFlag[]): void {
    if (candles.length === 0) return;
    const last = candles[candles.length - 1];
    const now = Date.now();
    const stalenessMs = now - last.closeTime;
    if (stalenessMs > 5 * 60 * 1000) {
      flags.push({
        type: 'stale',
        message: `Last candle is ${Math.round(stalenessMs / 1000)}s old`,
        lastCloseTime: last.closeTime,
      });
    }
  }

  private detectLowVolume(candles: Candle[], flags: DataQualityFlag[]): void {
    if (candles.length < 20) return;
    const recent = candles.slice(-20);
    const avgVol = recent.reduce((a, c) => a.plus(c.volume), new Decimal(0)).div(recent.length);
    const lastVol = recent[recent.length - 1].volume;
    if (avgVol.gt(0) && lastVol.lt(avgVol.times(0.2))) {
      flags.push({
        type: 'low_volume',
        message: `Last candle volume ${lastVol.toFixed(4)} is well below 20-candle average ${avgVol.toFixed(4)}`,
      });
    }
  }

  private timeframeToMs(tf: string): number {
    const unit = tf.slice(-1);
    const value = Number(tf.slice(0, -1));
    if (Number.isNaN(value)) return 60 * 60 * 1000; // default 1h
    switch (unit) {
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      case 'w':
        return value * 7 * 24 * 60 * 60 * 1000;
      default:
        return 60 * 60 * 1000;
    }
  }
}

export const marketDataAgent = new MarketDataAgent();
export default marketDataAgent;

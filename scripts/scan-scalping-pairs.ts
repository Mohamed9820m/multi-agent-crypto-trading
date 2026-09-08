import axios from 'axios';
import Decimal from 'decimal.js';
import { binanceClient } from '../src/shared/binance';
import { marketMicrostructureAgent } from '../src/agents/marketMicrostructure';
import { regimeDetectionAgent } from '../src/agents/regimeDetection';
import { technicalAnalysisAgent } from '../src/agents/technicalAnalysis';
import { sentimentAgent } from '../src/agents/sentiment';
import { scalpingStrategy } from '../src/strategies/scalping';
import { StrategyContext } from '../src/strategies/types';
import config from '../src/shared/config';

const BASE_URL = config.useTestnet
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

interface SymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
}

interface ScanResult {
  symbol: string;
  price: number;
  volume24h: number;
  change24hPct: number;
  spreadBps: number;
  liquidityScore: number;
  bidAskImbalance: number;
  depthImbalance: number;
  deltaRatio: number;
  adx: number;
  atrPct: number;
  strategicRegime: string;
  signal: 'long' | 'short' | 'no_trade';
  confidence: number;
  evidence: string[];
  stop?: number;
  target?: number;
}

async function fetchAllSymbols(): Promise<SymbolInfo[]> {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
  return data.symbols
    .filter(
      (s: any) =>
        s.status === 'TRADING' &&
        s.quoteAsset === 'USDT' &&
        s.contractType === 'PERPETUAL'
    )
    .map((s: any) => ({
      symbol: s.symbol,
      status: s.status,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
    }));
}

async function fetch24hTickers(): Promise<Record<string, any>> {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/ticker/24hr`);
  const map: Record<string, any> = {};
  for (const t of data) {
    map[t.symbol] = t;
  }
  return map;
}

async function scanSymbol(symbol: string): Promise<ScanResult | null> {
  try {
    const [marketData, ticker] = await Promise.all([
      fetchMarketData(symbol),
      binanceClient.getTicker24h(symbol),
    ]);

    if (!marketData || marketData.candles.length < 100) {
      return null;
    }

    const technicalAnalysis = await technicalAnalysisAgent.analyze(
      marketData.candles,
      'scalping'
    );
    const microstructure = marketMicrostructureAgent.analyze(
      marketData,
      marketData.candles.slice(-20)
    );
    const regime = regimeDetectionAgent.analyze(marketData.candles);
    const sentiment = await sentimentAgent.assess(symbol);

    const ctx: StrategyContext = {
      symbol,
      timeframe: '1h',
      marketData,
      technicalAnalysis,
      microstructure,
      regime,
      sentiment,
    };

    const signal = scalpingStrategy.computeSignal(ctx);

    const close = marketData.ticker24h.lastPrice.toNumber();
    let stop: number | undefined;
    let target: number | undefined;

    if (signal.signal !== 'no_trade') {
      const entry = marketData.ticker24h.lastPrice;
      const stopLoss = scalpingStrategy.computeStopLoss(
        ctx,
        signal.signal === 'long' ? 'LONG' : 'SHORT',
        entry
      );
      const takeProfit = scalpingStrategy.computeTakeProfit(
        ctx,
        signal.signal === 'long' ? 'LONG' : 'SHORT',
        entry,
        stopLoss
      );
      stop = stopLoss.toNumber();
      target = takeProfit?.toNumber();
    }

    const volume24h = Decimal.isDecimal(ticker.volume)
      ? ticker.volume.toNumber()
      : Number(ticker.volume);

    return {
      symbol,
      price: close,
      volume24h,
      change24hPct: Number(ticker.priceChangePercent),
      spreadBps: microstructure.orderBook.spreadPct * 10000,
      liquidityScore: microstructure.liquidity.liquidityScore,
      bidAskImbalance: microstructure.orderBook.bidAskImbalance,
      depthImbalance: microstructure.orderBook.depthImbalance,
      deltaRatio: microstructure.volumeDelta.buyVolume
        .minus(microstructure.volumeDelta.sellVolume)
        .div(
          microstructure.volumeDelta.buyVolume.plus(microstructure.volumeDelta.sellVolume)
        )
        .toNumber(),
      adx: technicalAnalysis.indicators['ADX(14)']?.value?.toNumber() ?? 0,
      atrPct:
        technicalAnalysis.indicators['ATR(14)']?.value
          ?.div(marketData.ticker24h.lastPrice)
          .toNumber() ?? 0,
      strategicRegime: regime.strategicRegime,
      signal: signal.signal,
      confidence: signal.confidence,
      evidence: signal.triggeringRules,
      stop,
      target,
    };
  } catch (err) {
    console.error(`Scan failed for ${symbol}:`, (err as Error).message);
    return null;
  }
}

async function fetchMarketData(symbol: string) {
  // Fallback if binanceClient doesn't expose getMarketData
  const candles = await binanceClient.getKlines(symbol, '1h', 200);
  const orderBook = await binanceClient.getOrderBook(symbol, 10);
  const ticker = await binanceClient.getTicker24h(symbol);
  const fundingRate = await binanceClient.getFundingRate?.(symbol);
  return {
    symbol,
    timeframe: '1h',
    candles,
    orderBook,
    ticker24h: ticker,
    fundingRate: fundingRate ?? undefined,
    dataQualityFlags: [],
  };
}

async function main() {
  console.log('Fetching all USDT perpetual symbols on Binance futures testnet...');
  const symbols = await fetchAllSymbols();
  console.log(`Found ${symbols.length} trading USDT perpetuals`);

  const tickers = await fetch24hTickers();

  // Sort by 24h volume and take top 30
  const topSymbols = symbols
    .map((s) => {
      const t = tickers[s.symbol];
      const vol = t ? Number(t.volume) * Number(t.lastPrice) : 0;
      return { ...s, volumeUsd: vol };
    })
    .filter((s) => s.volumeUsd > 0)
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, 30)
    .map((s) => s.symbol);

  console.log(`Scanning top ${topSymbols.length} by volume for scalping signals...`);

  const results: ScanResult[] = [];
  for (let i = 0; i < topSymbols.length; i++) {
    const symbol = topSymbols[i];
    process.stdout.write(`[${i + 1}/${topSymbols.length}] ${symbol} ... `);
    const res = await scanSymbol(symbol);
    if (res) {
      results.push(res);
      console.log(res.signal === 'no_trade' ? 'no signal' : `${res.signal} @ ${res.confidence.toFixed(0)}`);
    } else {
      console.log('error');
    }
    // Small polite delay
    await new Promise((r) => setTimeout(r, 150));
  }

  const tradable = results
    .filter((r) => r.signal !== 'no_trade')
    .sort((a, b) => b.confidence - a.confidence);

  console.log('\n=== SCALPING OPPORTUNITIES ===');
  if (tradable.length === 0) {
    console.log('No scalping signals found across top 30 pairs right now.');
  } else {
    console.table(
      tradable.map((r) => ({
        symbol: r.symbol,
        signal: r.signal.toUpperCase(),
        confidence: r.confidence.toFixed(0),
        price: r.price.toFixed(2),
        spreadBps: r.spreadBps.toFixed(1),
        liquidity: r.liquidityScore.toFixed(0),
        imbalance: r.bidAskImbalance.toFixed(2),
        deltaRatio: r.deltaRatio.toFixed(2),
        regime: r.strategicRegime,
        stop: r.stop?.toFixed(2),
        target: r.target?.toFixed(2),
        evidence: r.evidence.join('; '),
      }))
    );
  }

  console.log('\n=== TOP 10 BY VOLUME (for reference) ===');
  console.table(
    results
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 10)
      .map((r) => ({
        symbol: r.symbol,
        price: r.price < 0.01 ? r.price.toFixed(6) : r.price.toFixed(2),
        volume24h: (r.volume24h / 1e6).toFixed(2) + 'M',
        change24hPct: r.change24hPct.toFixed(2) + '%',
        spreadBps: r.spreadBps.toFixed(1),
        liquidity: r.liquidityScore.toFixed(0),
        regime: r.strategicRegime,
        signal: r.signal,
      }))
  );
}

main().catch((err) => {
  console.error('Scanner failed:', err);
  process.exit(1);
});

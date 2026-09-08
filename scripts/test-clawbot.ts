import dotenv from 'dotenv';
dotenv.config();

import { binanceClient } from '../src/shared/binance';
import clawbotAgent from '../src/agents/clawbot';
import logger from '../src/shared/logger';
import regimeDetectionAgent from '../src/agents/regimeDetection';
import marketMicrostructureAgent from '../src/agents/marketMicrostructure';
import technicalAnalysisAgent from '../src/agents/technicalAnalysis';
import portfolioManagerAgent from '../src/agents/portfolioManager';
import { loadAccountState } from '../src/shared/accountState';

async function main() {
  const symbol = process.env.TRADING_SYMBOL ?? 'BTCUSDT';
  const timeframe = process.env.TRADING_TIMEFRAME ?? '1h';

  logger.info('CLAWBOT test: fetching market data', { symbol, timeframe });
  const candles = await binanceClient.getKlines(symbol, timeframe, 200);
  const orderBook = await binanceClient.getOrderBook(symbol, 100);
  const ticker24h = await binanceClient.getTicker24h(symbol);

  const marketData = {
    symbol,
    timeframe,
    candles,
    orderBook,
    ticker24h,
    dataQualityFlags: [],
  };

  const technicalAnalysis = await technicalAnalysisAgent.analyze(candles, 'trendFollowing');
  const regime = regimeDetectionAgent.analyze(candles);
  const microstructure = marketMicrostructureAgent.analyze(marketData, candles.slice(-20));
  const account = await loadAccountState();
  const portfolio = portfolioManagerAgent.analyze(account, {
    symbol,
    side: 'LONG',
    notionalEUR: new (await import('decimal.js')).default(0),
    strategy: 'trendFollowing',
  });

  const result = await clawbotAgent.analyze({
    symbol,
    timeframe,
    regime,
    microstructure,
    technicalAnalysis,
    candidates: [],
    portfolioState: portfolio,
  });

  logger.info('CLAWBOT test result', { result });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  logger.error('CLAWBOT test failed', { err: err.message });
  process.exit(1);
});

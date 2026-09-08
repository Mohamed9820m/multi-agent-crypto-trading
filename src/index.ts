import config from './shared/config';
import db from './shared/db';
import logger from './shared/logger';
import redisBus from './shared/redisBus';
import orchestrator from './agents/orchestrator';
import { binanceWebSocketManager } from './shared/binanceWebsocket';
import { strategyRegistry } from './strategies/playbook';
import { strategyLifecycleManager } from './shared/strategyLifecycle';

async function main(): Promise<void> {
  logger.info('Starting multi-agent crypto trading system', {
    symbol: config.symbol,
    timeframe: config.timeframe,
    mode: config.tradingMode,
    strategy: config.activeStrategy,
  });

  await redisBus.connect();
  logger.info('Connected to Redis');

  // Verify DB connectivity.
  await db.query('SELECT 1');
  logger.info('Connected to PostgreSQL');

  // Initialize strategy lifecycle records for all registered strategies.
  for (const strategy of Object.values(strategyRegistry)) {
    await strategyLifecycleManager.initialize(strategy.name, strategy.version, 'TESTNET');
  }

  // Start WebSocket streams for low-latency market + account synchronization.
  try {
    await binanceWebSocketManager.startMarketStreams(
      [config.symbol],
      ['ticker', 'depth'],
      config.timeframe
    );
    if (config.tradingMode !== 'paper') {
      await binanceWebSocketManager.startAccountStream();
    }
    logger.info('WebSocket streams started');
  } catch (err) {
    logger.error('Failed to start WebSocket streams; falling back to REST polling', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    orchestrator.halt();
    binanceWebSocketManager.stop();
    await redisBus.disconnect();
    await db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  await orchestrator.runLoop();
}

main().catch(async (err) => {
  logger.error('Fatal error in main process', { err });
  await redisBus.disconnect().catch(() => undefined);
  await db.close().catch(() => undefined);
  process.exit(1);
});

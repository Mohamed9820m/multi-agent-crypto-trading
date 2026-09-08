import config from '../src/shared/config';
import db from '../src/shared/db';
import logger from '../src/shared/logger';
import redisBus from '../src/shared/redisBus';
import backtestingAgent from '../src/agents/backtesting';

async function main(): Promise<void> {
  await redisBus.connect();
  await db.query('SELECT 1');

  const strategy = process.argv[2] || config.activeStrategy;
  const symbol = process.argv[3] || config.symbol;
  const timeframe = process.argv[4] || config.timeframe;

  logger.info('Running backtest', { strategy, symbol, timeframe });
  const result = await backtestingAgent.validate(strategy, symbol, timeframe);

  console.log(JSON.stringify(result, null, 2));

  await redisBus.disconnect();
  await db.close();
}

main().catch((err) => {
  logger.error('Backtest failed', { err });
  process.exit(1);
});

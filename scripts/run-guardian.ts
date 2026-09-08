import db from '../src/shared/db';
import logger from '../src/shared/logger';
import redisBus from '../src/shared/redisBus';
import guardianAgent from '../src/agents/guardian';

async function main(): Promise<void> {
  await redisBus.connect();
  await db.query('SELECT 1');
  logger.info('Guardian runner started');

  const gracefulShutdown = async (signal: string) => {
    logger.info(`Guardian received ${signal}, exiting`);
    await redisBus.disconnect();
    await db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  await guardianAgent.runLoop();
}

main().catch(async (err) => {
  logger.error('Guardian fatal error', { err });
  await redisBus.disconnect().catch(() => undefined);
  await db.close().catch(() => undefined);
  process.exit(1);
});

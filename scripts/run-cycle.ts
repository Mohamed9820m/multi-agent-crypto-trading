import db from '../src/shared/db';
import logger from '../src/shared/logger';
import redisBus from '../src/shared/redisBus';
import orchestrator from '../src/agents/orchestrator';

async function main(): Promise<void> {
  await redisBus.connect();
  await db.query('SELECT 1');

  const log = await orchestrator.runOnce();

  console.log(JSON.stringify(log, (_key, value) => {
    if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'Decimal') {
      return value.toString();
    }
    if (value instanceof Date) return value.toISOString();
    return value;
  }, 2));

  await redisBus.disconnect();
  await db.close();
}

main().catch((err) => {
  logger.error('Run-cycle failed', { err });
  process.exit(1);
});

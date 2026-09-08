import db from '../src/shared/db';
import logger from '../src/shared/logger';
import redisBus from '../src/shared/redisBus';
import reportingAgent from '../src/agents/reporting';

async function main(): Promise<void> {
  await redisBus.connect();
  await db.query('SELECT 1');

  const report = await reportingAgent.generateDailyReport();
  console.log(report);

  await redisBus.disconnect();
  await db.close();
}

main().catch((err) => {
  logger.error('Reporting failed', { err });
  process.exit(1);
});

import db from './db';
import logger from './logger';
import { FeatureVector } from './featureEngineering';

export class FeatureStore {
  async persist(cycleId: string | undefined, symbol: string, features: FeatureVector): Promise<void> {
    await db.query(
      `INSERT INTO features (cycle_id, symbol, features) VALUES ($1, $2, $3)`,
      [cycleId ?? null, symbol, JSON.stringify(features)]
    );
    logger.debug('Feature vector persisted', { cycleId, symbol });
  }

  async loadRecent(symbol: string, limit = 1000): Promise<FeatureVector[]> {
    const rows = await db.query<{ features: unknown }>(
      `SELECT features FROM features WHERE symbol = $1 ORDER BY created_at DESC LIMIT $2`,
      [symbol, limit]
    );
    return rows.map((r) => r.features as FeatureVector).reverse();
  }

  async loadLabeled(symbol: string, horizonCandles = 6): Promise<{ features: number[]; label: number }[]> {
    // Naive labeling: look ahead from each feature row and return +1/-1/0 based on future return.
    // Production would use curated labels from actual trade outcomes.
    const rows = await db.query<{ features: unknown; created_at: Date }>(
      `SELECT features, created_at FROM features WHERE symbol = $1 ORDER BY created_at ASC`,
      [symbol]
    );

    const labeled: { features: number[]; label: number }[] = [];
    for (let i = 0; i < rows.length - horizonCandles; i++) {
      const fv = rows[i].features as FeatureVector;
      const future = rows[i + horizonCandles].features as FeatureVector;
      const ret = future.returns;
      const label = ret > 0.001 ? 1 : ret < -0.001 ? -1 : 0;
      labeled.push({ features: Object.values(fv).filter((v) => typeof v === 'number') as number[], label });
    }
    return labeled;
  }
}

export const featureStore = new FeatureStore();
export default featureStore;

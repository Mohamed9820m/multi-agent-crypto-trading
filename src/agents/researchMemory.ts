import db from '../shared/db';
import logger from '../shared/logger';

export interface ResearchMemoryItem {
  itemType: string;
  source: string;
  title: string;
  content?: string;
  symbol?: string;
  strategy?: string;
  regime?: string;
  confidence?: number;
  context?: Record<string, unknown>;
  validationStatus?: 'unvalidated' | 'validated' | 'rejected' | 'deprecated';
}

export class ResearchMemoryAgent {
  async record(item: ResearchMemoryItem): Promise<void> {
    logger.info('ResearchMemoryAgent recording', { type: item.itemType, title: item.title });
    await db.query(
      `INSERT INTO research_memory (item_type, source, title, content, symbol, strategy, regime, confidence, context, validation_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        item.itemType,
        item.source,
        item.title,
        item.content ?? null,
        item.symbol ?? null,
        item.strategy ?? null,
        item.regime ?? null,
        item.confidence ?? 0.5,
        JSON.stringify(item.context ?? {}),
        item.validationStatus ?? 'unvalidated',
      ]
    );
  }

  async search(opts: {
    itemType?: string;
    strategy?: string;
    symbol?: string;
    regime?: string;
    validationStatus?: string;
    limit?: number;
  }): Promise<ResearchMemoryItem[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.itemType) {
      conditions.push(`item_type = $${params.length + 1}`);
      params.push(opts.itemType);
    }
    if (opts.strategy) {
      conditions.push(`strategy = $${params.length + 1}`);
      params.push(opts.strategy);
    }
    if (opts.symbol) {
      conditions.push(`symbol = $${params.length + 1}`);
      params.push(opts.symbol);
    }
    if (opts.regime) {
      conditions.push(`regime = $${params.length + 1}`);
      params.push(opts.regime);
    }
    if (opts.validationStatus) {
      conditions.push(`validation_status = $${params.length + 1}`);
      params.push(opts.validationStatus);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 50;

    const rows = await db.query<{
      item_type: string;
      source: string;
      title: string;
      content: string | null;
      symbol: string | null;
      strategy: string | null;
      regime: string | null;
      confidence: string;
      context: string;
      validation_status: string;
    }>(
      `SELECT item_type, source, title, content, symbol, strategy, regime, confidence::text, context::text, validation_status
       FROM research_memory
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    return rows.map((r) => ({
      itemType: r.item_type,
      source: r.source,
      title: r.title,
      content: r.content ?? undefined,
      symbol: r.symbol ?? undefined,
      strategy: r.strategy ?? undefined,
      regime: r.regime ?? undefined,
      confidence: Number(r.confidence),
      context: JSON.parse(r.context),
      validationStatus: r.validation_status as ResearchMemoryItem['validationStatus'],
    }));
  }

  async recordLesson(
    symbol: string,
    strategy: string,
    regime: string,
    lesson: string,
    confidence = 0.6
  ): Promise<void> {
    await this.record({
      itemType: 'lesson',
      source: 'postTradeForensics',
      title: `Lesson: ${strategy} in ${regime}`,
      content: lesson,
      symbol,
      strategy,
      regime,
      confidence,
      context: { timestamp: Date.now() },
    });
  }

  async recordCandidateEvaluation(
    symbol: string,
    strategy: string,
    regime: string,
    score: number,
    expectedValuePct: number,
    decision: string
  ): Promise<void> {
    await this.record({
      itemType: 'candidate',
      source: 'orchestrator',
      title: `Candidate evaluation: ${strategy}`,
      symbol,
      strategy,
      regime,
      confidence: score,
      context: { expectedValuePct, decision },
    });
  }
}

export const researchMemoryAgent = new ResearchMemoryAgent();
export default researchMemoryAgent;

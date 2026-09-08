import Decimal from 'decimal.js';
import config from '../shared/config';
import db from '../shared/db';
import logger from '../shared/logger';
import {
  averageLoss,
  averageWin,
  expectancy,
  maxDrawdown,
  sharpeRatio,
  sortinoRatio,
  winRatePct,
} from '../shared/indicators';

export interface DailyReportExtras {
  regimeDistribution: Record<string, number>;
  strategyByRegime: Record<string, { trades: number; avgPnl: number }>;
  avgSlippagePct: number | null;
  dataErrors: string[];
  modelErrors: string[];
  topOpportunities: string[];
}

export class ReportingAgent {
  async generateDailyReport(date = new Date()): Promise<string> {
    logger.info('ReportingAgent generating daily report', { date: date.toISOString() });

    const start = new Date(date);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const startBalance = await this.getBalanceAt(start);
    const endBalance = await this.getBalanceAt(end);
    const dailyPnl = endBalance.minus(startBalance);
    const dailyPnlPct = startBalance.gt(0) ? dailyPnl.div(startBalance).times(100) : new Decimal(0);

    const trades = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM orders WHERE timestamp >= $1 AND timestamp < $2`,
      [start, end]
    );
    const tradeCount = Number(trades[0]?.count ?? 0);

    const openPositions = await db.query<{
      symbol: string;
      side: string;
      entry_price: string;
      quantity: string;
      unrealized_pnl: string;
    }>(
      `SELECT symbol, side, entry_price::text, quantity::text, unrealized_pnl::text
       FROM positions WHERE status = 'open'`
    );

    const closedPnL = await db.query<{ realized_pnl: string; strategy?: string }>(
      `SELECT realized_pnl::text, strategy FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 100`
    );
    const pnls = closedPnL.map((r) => new Decimal(r.realized_pnl));
    const wr = winRatePct(pnls);
    const aw = averageWin(pnls);
    const al = averageLoss(pnls);
    const exp = aw && al ? expectancy(wr, aw, al) : null;

    const equityCurve = await db.query<{ equity_eur: string }>(
      `SELECT equity_eur::text FROM account_snapshots ORDER BY timestamp ASC`
    );
    const curve = equityCurve.map((r) => new Decimal(r.equity_eur));
    const dd = maxDrawdown(curve);

    const returns: Decimal[] = [];
    for (let i = 1; i < curve.length; i++) {
      returns.push(curve[i].minus(curve[i - 1]).div(curve[i - 1]));
    }
    const sharpe = sharpeRatio(returns);
    const sortino = sortinoRatio(returns);

    const guardian = await db.query<{ trigger_type: string; message: string }>(
      `SELECT trigger_type, message FROM guardian_triggers WHERE created_at >= $1 AND created_at < $2`,
      [start, end]
    );

    const vetoes = await db.query<{ veto_reason: string }>(
      `SELECT DISTINCT orchestrator_output->'riskDecision'->>'veto_reason' as veto_reason
       FROM cycle_logs
       WHERE started_at >= $1 AND started_at < $2
         AND orchestrator_output->'riskDecision'->>'decision' = 'veto'
         AND orchestrator_output->'riskDecision'->>'veto_reason' IS NOT NULL`,
      [start, end]
    );

    const extras = await this.gatherExtras(start, end);
    const marketIntel = await this.getLatestMarketIntelligence(start, end);
    const lifecycleStatus = await this.getLifecycleStatus();

    const report = `# Daily Trading Report — ${start.toISOString().split('T')[0]}

## Account Summary
- Starting balance: ${startBalance.toFixed(2)} EUR
- Ending balance: ${endBalance.toFixed(2)} EUR
- Daily P&L: ${dailyPnl.toFixed(2)} EUR (${dailyPnlPct.toFixed(2)}%)
- Current open positions: ${openPositions.length === 0 ? 'None' : openPositions.map((p) => `${p.side} ${p.quantity} ${p.symbol} @ ${p.entry_price}`).join(', ')}

## BMAD Market Snapshot & Intelligence
${marketIntel
  ? `- Symbol: ${marketIntel.snapshot.symbol}
- Last price: ${this.safeDecimal(marketIntel.snapshot.lastPrice).toFixed(2)}
- Spread: ${(marketIntel.snapshot.spreadPct * 10000).toFixed(2)} bps
- 24h change: ${(marketIntel.snapshot.change24hPct * 100).toFixed(2)}%
- Liquidity score: ${marketIntel.snapshot.liquidityScore}/100
- Dominant regime: ${marketIntel.snapshot.dominantRegime} (confidence ${(marketIntel.snapshot.regimeConfidence * 100).toFixed(0)}%)
- Verdict: ${marketIntel.bias} / ${marketIntel.tradeStance}
- Recommended direction: ${marketIntel.recommendedDirection} (confidence ${(marketIntel.confidence * 100).toFixed(0)}%)
- Key risks: ${marketIntel.keyRisks.length ? marketIntel.keyRisks.join('; ') : 'none'}
- Invalidation: ${marketIntel.invalidationConditions.length ? marketIntel.invalidationConditions.join('; ') : 'none'}`
  : '- No market intelligence recorded today'}

## Activity
- Trades executed: ${tradeCount}
- Win rate (rolling 100 trades): ${wr.toFixed(1)}%${pnls.length < 30 ? ' — sample size too small to be statistically significant' : ''}
- Best trade / worst trade: ${aw ? `${aw.toFixed(2)}` : 'n/a'} / ${al ? `-${al.toFixed(2)}` : 'n/a'} EUR
- Strategy active: ${config.activeStrategy}

## Risk Metrics
- Current drawdown from peak: ${dd?.toFixed(2) ?? 'n/a'}%
- Risk exposure (% of equity currently at risk): ${endBalance.gt(0) ? (await this.exposureAtRisk()).div(endBalance).times(100).toFixed(2) : 'n/a'}%
- Circuit breaker status: ${guardian.length > 0 ? `TRIGGERED — ${guardian[0].trigger_type}` : 'ok'}

## Risk Manager Decision Log
- Vetoes today: ${vetoes.length}
${vetoes.slice(0, 5).map((v) => `  - ${v.veto_reason}`).join('\n')}

## Strategy Lifecycle Status
${lifecycleStatus.length > 0
  ? lifecycleStatus.map((s) => `- ${s.strategyName}@${s.version}: ${s.state} (${s.capitalAllocationPct}% allocation)`).join('\n')
  : '- No lifecycle records'}

## Performance Metrics
- Sharpe ratio: ${sharpe?.toFixed(2) ?? 'n/a'}
- Sortino ratio: ${sortino?.toFixed(2) ?? 'n/a'}
- Expectancy: ${exp?.toFixed(2) ?? 'n/a'} EUR per trade
- Average slippage: ${extras.avgSlippagePct !== null ? `${(extras.avgSlippagePct * 10000).toFixed(2)} bps` : 'n/a'}

## Regime Distribution
${Object.entries(extras.regimeDistribution)
  .map(([regime, count]) => `- ${regime}: ${count} cycles`)
  .join('\n') || '- No regime data today'}

## Strategy Performance by Regime
${Object.entries(extras.strategyByRegime)
  .map(([key, val]) => `- ${key}: ${val.trades} trades, avg PnL ${val.avgPnl.toFixed(2)} EUR`)
  .join('\n') || '- Insufficient closed-trade data'}

## Notes & Anomalies
${guardian.map((g) => `- Guardian trigger: ${g.trigger_type} — ${g.message}`).join('\n') || '- No Guardian triggers today'}
${vetoes.length > 0 ? vetoes.map((v) => `- Risk Manager veto: ${v.veto_reason}`).join('\n') : '- No Risk Manager vetoes today'}
${extras.dataErrors.length > 0 ? extras.dataErrors.map((e) => `- Data error: ${e}`).join('\n') : '- No data errors today'}
${extras.modelErrors.length > 0 ? extras.modelErrors.map((e) => `- Model error: ${e}`).join('\n') : '- No model errors today'}

## Top Current Opportunities
${extras.topOpportunities.length > 0 ? extras.topOpportunities.map((o) => `- ${o}`).join('\n') : '- No strong opportunities identified today'}

---

# Daily AI Board Meeting

Participants: CEO, CRO, Quant Researcher, Market Microstructure Specialist, Strategy Managers, Execution Manager, Red Team, External Research AI

## 1. What worked?
${pnls.length > 0 && dailyPnl.gte(0) ? '- The strategy/process produced positive P&L today.' : '- No clear positive edge demonstrated today.'}

## 2. What failed?
${pnls.length > 0 && dailyPnl.lt(0) ? '- Daily P&L was negative; review losing trades in post-trade forensics.' : '- No major P&L failures today.'}
${extras.modelErrors.length > 0 ? '- Model errors were logged and should be investigated.' : ''}

## 3. Which assumptions were wrong?
${vetoes.length > 0 ? '- Risk manager disagreed with candidate assumptions in several cycles.' : '- No major assumption conflicts today.'}

## 4. Which strategies worked only because of one lucky market?
- Requires larger sample; current ${pnls.length} closed trades is ${pnls.length < 30 ? 'too small' : 'approaching adequacy'} for statistical inference.

## 5. Which strategies are robust?
${exp && exp.gte(0) ? '- Positive expectancy observed; continue monitoring out-of-sample.' : '- Expectancy non-positive; do not scale.'}

## 6. Did execution reduce theoretical edge?
${extras.avgSlippagePct !== null && extras.avgSlippagePct > 0.0005 ? '- Slippage exceeded 5 bps; execution may be eroding edge.' : '- Slippage within acceptable range.'}

## 7. Did transaction costs invalidate anything?
${exp && exp.lte(0) && tradeCount > 0 ? '- Costs may be turning gross edge negative.' : '- No evidence that costs invalidated strategies today.'}

## 8. Are any strategies overfitting?
- Review parameter stability tests (not yet automated).

## 9. Did the market regime change?
${Object.keys(extras.regimeDistribution).length > 1 ? '- Multiple regimes observed today; regime-aware allocation remains important.' : '- Regime was stable today.'}

## 10. What should be tested tomorrow?
- Continue paper/testnet validation of top-scoring strategies.
- Investigate any model/data errors.
- Re-evaluate strategies with negative expectancy or high slippage.
`;

    logger.info('ReportingAgent report generated');
    return report;
  }

  private async gatherExtras(start: Date, end: Date): Promise<DailyReportExtras> {
    const cycles = await db.query<{ output: string }>(
      `SELECT orchestrator_output::text as output
       FROM cycle_logs
       WHERE started_at >= $1 AND started_at < $2`,
      [start, end]
    );

    const regimeDistribution: Record<string, number> = {};
    const strategyByRegime: Record<string, { trades: number; totalPnl: number }> = {};
    const topOpportunities: string[] = [];
    const dataErrors: string[] = [];
    const modelErrors: string[] = [];

    for (const row of cycles) {
      try {
        const output = JSON.parse(row.output);
        const regime = output.specialistAnalysis?.regime?.dominantRegime;
        if (regime) {
          regimeDistribution[regime] = (regimeDistribution[regime] ?? 0) + 1;
        }

        const selected = output.selectedCandidate;
        if (selected && selected.score > 0.5 && selected.expectedValue?.expectedValuePct > 0) {
          topOpportunities.push(
            `${selected.strategy} ${selected.direction} ${selected.symbol} score=${selected.score.toFixed(3)} EV=${(selected.expectedValue.expectedValuePct * 100).toFixed(3)}%`
          );
        }

        if (output.errors && Array.isArray(output.errors)) {
          for (const err of output.errors) {
            if (String(err).toLowerCase().includes('data')) dataErrors.push(String(err));
            else modelErrors.push(String(err));
          }
        }

        const strategy = output.signal?.strategyUsed ?? output.selectedCandidate?.strategy;
        if (strategy && regime) {
          const key = `${strategy} in ${regime}`;
          if (!strategyByRegime[key]) strategyByRegime[key] = { trades: 0, totalPnl: 0 };
          // Approximate: count cycles where a signal was generated
          if (output.signal?.signal && output.signal.signal !== 'no_trade') {
            strategyByRegime[key].trades += 1;
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    // Limit top opportunities
    topOpportunities.splice(5);

    // Slippage from filled entry orders
    const slippageRows = await db.query<{ raw_response: string }>(
      `SELECT raw_response::text as raw_response
       FROM orders
       WHERE type = 'entry' AND timestamp >= $1 AND timestamp < $2 AND raw_response IS NOT NULL`,
      [start, end]
    );
    let totalSlippage = 0;
    let slippageCount = 0;
    for (const row of slippageRows) {
      try {
        const raw = JSON.parse(row.raw_response);
        if (typeof raw.slippagePct === 'number') {
          totalSlippage += raw.slippagePct;
          slippageCount++;
        }
      } catch {
        // ignore
      }
    }

    // Convert strategyByRegime totals to averages
    const strategyByRegimeAvg: Record<string, { trades: number; avgPnl: number }> = {};
    for (const [key, val] of Object.entries(strategyByRegime)) {
      strategyByRegimeAvg[key] = { trades: val.trades, avgPnl: val.trades > 0 ? val.totalPnl / val.trades : 0 };
    }

    return {
      regimeDistribution,
      strategyByRegime: strategyByRegimeAvg,
      avgSlippagePct: slippageCount > 0 ? totalSlippage / slippageCount : null,
      dataErrors,
      modelErrors,
      topOpportunities,
    };
  }

  private async getBalanceAt(date: Date): Promise<Decimal> {
    const rows = await db.query<{ equity_eur: string }>(
      `SELECT equity_eur::text FROM account_snapshots WHERE timestamp <= $1 ORDER BY timestamp DESC LIMIT 1`,
      [date]
    );
    if (rows.length > 0) return new Decimal(rows[0].equity_eur);
    return new Decimal(config.startingCapitalEUR);
  }

  private async getLatestMarketIntelligence(
    start: Date,
    end: Date
  ): Promise<import('../shared/types').MarketIntelligence | null> {
    const rows = await db.query<{ output: string }>(
      `SELECT orchestrator_output::text as output
       FROM cycle_logs
       WHERE started_at >= $1 AND started_at < $2
         AND orchestrator_output->'marketIntelligence' IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      [start, end]
    );
    if (rows.length === 0) return null;
    try {
      const output = JSON.parse(rows[0].output);
      return output.marketIntelligence as import('../shared/types').MarketIntelligence;
    } catch {
      return null;
    }
  }

  private async getLifecycleStatus(): Promise<
    { strategyName: string; version: string; state: string; capitalAllocationPct: number }[]
  > {
    const rows = await db.query<{
      strategy_name: string;
      version: string;
      state: string;
      capital_allocation_pct: number;
    }>(
      `SELECT strategy_name, version, state, capital_allocation_pct
       FROM strategy_lifecycle
       ORDER BY updated_at DESC
       LIMIT 20`
    );
    return rows.map((r) => ({
      strategyName: r.strategy_name,
      version: r.version,
      state: r.state,
      capitalAllocationPct: r.capital_allocation_pct,
    }));
  }

  private async exposureAtRisk(): Promise<Decimal> {
    const rows = await db.query<{ at_risk: string }>(
      `SELECT COALESCE(SUM(quantity * ABS(entry_price - stop_loss)), 0)::text as at_risk
       FROM positions WHERE status = 'open' AND stop_loss IS NOT NULL`
    );
    return new Decimal(rows[0]?.at_risk ?? 0);
  }

  private safeDecimal(value: unknown): Decimal {
    if (Decimal.isDecimal(value)) return value as Decimal;
    if (typeof value === 'string' || typeof value === 'number') return new Decimal(value);
    return new Decimal(0);
  }
}

export const reportingAgent = new ReportingAgent();
export default reportingAgent;

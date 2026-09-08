import { RedTeamChallenge, StrategyCandidate, TradeProposal } from '../shared/types';

export class RedTeamAgent {
  challenge(candidate: StrategyCandidate, marketData?: { spreadPct: number; dataQualityFlags: { type: string }[] }): RedTeamChallenge {
    const attacks: RedTeamChallenge['attacks'] = [];

    // 1. Data quality attack
    if (marketData && marketData.dataQualityFlags.length > 0) {
      attacks.push({
        area: 'data_quality',
        issue: `Market data contains ${marketData.dataQualityFlags.length} quality flag(s).`,
        severity: 'medium',
        mitigatingEvidence: 'Orchestrator already halts on critical flags.',
      });
    }

    // 2. Regime mismatch attack
    if (candidate.regimeFit < 0.4) {
      attacks.push({
        area: 'regime_mismatch',
        issue: `Strategy ${candidate.strategy} has low fit (${candidate.regimeFit.toFixed(2)}) for current regime.`,
        severity: 'high',
      });
    }

    // 3. Cost attack
    if (candidate.costPenalty > 0.05) {
      attacks.push({
        area: 'execution_costs',
        issue: `High cost penalty (${candidate.costPenalty.toFixed(3)}) suggests spread/fees/slippage may consume edge.`,
        severity: 'medium',
      });
    }

    // 4. Liquidity attack
    if (candidate.liquidityQuality < 0.4) {
      attacks.push({
        area: 'liquidity',
        issue: 'Low liquidity quality increases slippage and market-impact risk.',
        severity: 'high',
      });
    }

    // 5. Overconfidence attack
    if (candidate.statisticalConfidence > 0.85 && candidate.robustness < 0.5) {
      attacks.push({
        area: 'model_overconfidence',
        issue: 'High statistical confidence with low robustness may indicate overfitting.',
        severity: 'medium',
      });
    }

    // 6. EV attack
    if (candidate.expectedValue.expectedValuePct <= 0) {
      attacks.push({
        area: 'expected_value',
        issue: 'Expected value is non-positive after costs.',
        severity: 'critical',
      });
    }

    // 7. Strategy-specific failure conditions
    if (candidate.invalidationConditions.length === 0) {
      attacks.push({
        area: 'risk_planning',
        issue: 'No explicit invalidation conditions were provided by the strategy.',
        severity: 'medium',
      });
    }

    const critical = attacks.filter((a) => a.severity === 'critical').length;
    const high = attacks.filter((a) => a.severity === 'high').length;
    const medium = attacks.filter((a) => a.severity === 'medium').length;

    let conclusion: RedTeamChallenge['conclusion'] = 'valid';
    if (critical > 0) conclusion = 'invalid';
    else if (high > 1) conclusion = 'weak';
    else if (high === 1 || medium > 2) conclusion = 'requires_more_data';

    const confidence = Math.min(1, (critical * 0.4 + high * 0.2 + medium * 0.1) / Math.max(1, attacks.length));

    let recommendation: RedTeamChallenge['recommendation'] = 'proceed';
    if (conclusion === 'invalid') recommendation = 'reject';
    else if (conclusion === 'weak') recommendation = 'reject';
    else if (conclusion === 'requires_more_data') recommendation = 'caution';

    return {
      conclusion,
      confidence,
      attacks,
      invalidationTriggers: candidate.invalidationConditions,
      recommendation,
    };
  }

  challengeTradeProposal(proposal: TradeProposal): RedTeamChallenge {
    return this.challenge(
      {
        strategy: proposal.strategy,
        version: '1.0.0',
        symbol: proposal.symbol,
        direction: proposal.direction,
        entry: proposal.entry,
        stop: proposal.stop,
        takeProfit: proposal.takeProfit,
        regimeFit: 0.5,
        marketStructureQuality: 0.5,
        liquidityQuality: 0.5,
        orderFlowConfirmation: 0.5,
        statisticalConfidence: proposal.confidence / 100,
        newsContext: 0.5,
        executionQuality: Math.max(0, 1 - proposal.costs.expectedTotalCostPct * 100),
        portfolioFit: 0.5,
        robustness: 0.5,
        historicalEdge: 0.5,
        overfitPenalty: 0,
        costPenalty: Math.min(0.3, proposal.costs.expectedTotalCostPct * 10),
        correlationPenalty: 0,
        drawdownPenalty: 0,
        dataQualityPenalty: 0,
        eventRiskPenalty: 0,
        score: 0,
        expectedValue: proposal.expectedValue,
        evidence: proposal.evidence,
        counterArguments: proposal.counterArguments,
        invalidationConditions: proposal.invalidationConditions,
        timeHorizon: proposal.timeframe,
      },
      { spreadPct: proposal.costs.estimatedSpreadPct, dataQualityFlags: [] }
    );
  }
}

export const redTeamAgent = new RedTeamAgent();
export default redTeamAgent;

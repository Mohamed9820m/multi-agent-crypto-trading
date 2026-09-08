import logger from './logger';

export interface EvidencePiece {
  source: string;
  /** Likelihood of observing this evidence if the hypothesis (trade edge) is true. */
  likelihoodTrue: number;
  /** Likelihood of observing this evidence if the hypothesis is false. */
  likelihoodFalse: number;
  weight?: number;
}

/**
 * Update a prior probability with a single evidence piece using Bayes' rule.
 */
export function bayesianUpdate(prior: number, evidence: EvidencePiece): number {
  const lt = clamp(evidence.likelihoodTrue);
  const lf = clamp(evidence.likelihoodFalse);
  const p = clamp(prior);
  const posterior = (p * lt) / (p * lt + (1 - p) * lf);
  return clamp(posterior);
}

/**
 * Combine multiple independent evidence pieces sequentially.
 */
export function combineEvidence(prior: number, evidence: EvidencePiece[]): number {
  return evidence.reduce((current, e) => bayesianUpdate(current, e), clamp(prior));
}

/**
 * Convert a confidence score (0-100) into a calibrated likelihood pair.
 * High confidence => high likelihoodTrue, low likelihoodFalse.
 */
export function confidenceToEvidence(source: string, confidence: number, direction: 'support' | 'against' = 'support'): EvidencePiece {
  const c = clamp(confidence / 100);
  if (direction === 'support') {
    return {
      source,
      likelihoodTrue: 0.5 + 0.5 * c,
      likelihoodFalse: 0.5 - 0.4 * c,
    };
  }
  return {
    source,
    likelihoodTrue: 0.5 - 0.4 * c,
    likelihoodFalse: 0.5 + 0.5 * c,
  };
}

/**
 * Build evidence list for a strategy candidate from available analyses.
 */
export function buildCandidateEvidence(input: {
  signalConfidence: number;
  regimeFit: number;
  marketStructureQuality: number;
  liquidityQuality: number;
  orderFlowConfirmation: number;
  microstructureBias: 'bullish' | 'bearish' | 'neutral';
  sentimentScore: number;
  dataQuality: 'high' | 'medium' | 'low';
  direction: 'long' | 'short';
}): EvidencePiece[] {
  const evidence: EvidencePiece[] = [];

  evidence.push(confidenceToEvidence('signal_confidence', input.signalConfidence, 'support'));
  evidence.push(confidenceToEvidence('regime_fit', input.regimeFit * 100, 'support'));
  evidence.push(confidenceToEvidence('market_structure', input.marketStructureQuality * 100, 'support'));
  evidence.push(confidenceToEvidence('liquidity', input.liquidityQuality * 100, 'support'));
  evidence.push(confidenceToEvidence('order_flow', input.orderFlowConfirmation * 100, 'support'));

  // Sentiment direction alignment.
  const sentimentAligned =
    (input.direction === 'long' && input.sentimentScore > 10) ||
    (input.direction === 'short' && input.sentimentScore < -10);
  const sentimentConfidence = Math.min(Math.abs(input.sentimentScore), 100);
  evidence.push(
    confidenceToEvidence(
      'sentiment',
      sentimentConfidence,
      sentimentAligned ? 'support' : 'against'
    )
  );

  // Microstructure alignment.
  const microAligned =
    (input.direction === 'long' && input.microstructureBias === 'bullish') ||
    (input.direction === 'short' && input.microstructureBias === 'bearish');
  evidence.push(confidenceToEvidence('microstructure', 60, microAligned ? 'support' : 'against'));

  // Data quality penalty as evidence against.
  if (input.dataQuality === 'medium') {
    evidence.push({ source: 'data_quality', likelihoodTrue: 0.7, likelihoodFalse: 0.4 });
  } else if (input.dataQuality === 'low') {
    evidence.push({ source: 'data_quality', likelihoodTrue: 0.5, likelihoodFalse: 0.7 });
  }

  return evidence;
}

export function bayesianConfidence(input: Parameters<typeof buildCandidateEvidence>[0]): number {
  const evidence = buildCandidateEvidence(input);
  const posterior = combineEvidence(0.5, evidence);
  logger.debug('Bayesian confidence computed', {
    sources: evidence.map((e) => e.source),
    posterior: Number(posterior.toFixed(4)),
  });
  return posterior;
}

function clamp(v: number): number {
  return Math.max(0.0001, Math.min(0.9999, v));
}

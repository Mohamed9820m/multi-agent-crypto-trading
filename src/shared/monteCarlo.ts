

export interface MonteCarloResult {
  pDrawdownGreaterThanX: Record<number, number>;
  pLosingStreakGreaterThanN: Record<number, number>;
  pAccountLossGreaterThanX: Record<number, number>;
  maxDrawdownPct: number;
  medianDrawdownPct: number;
  worstLosingStreak: number;
}

export function monteCarloRiskAnalysis(
  tradeReturns: number[],
  iterations = 1000,
  tradesPerIteration = 100,
  startingCapital = 10000
): MonteCarloResult | null {
  if (tradeReturns.length < 10) return null;

  const maxDrawdowns: number[] = [];
  const losingStreaks: number[] = [];
  const finalCapitals: number[] = [];

  for (let i = 0; i < iterations; i++) {
    let capital = startingCapital;
    let peak = capital;
    let currentStreak = 0;
    let maxStreak = 0;
    let maxDd = 0;

    for (let t = 0; t < tradesPerIteration; t++) {
      const ret = tradeReturns[Math.floor(Math.random() * tradeReturns.length)];
      capital *= 1 + ret;
      if (capital > peak) peak = capital;
      const dd = (peak - capital) / peak;
      if (dd > maxDd) maxDd = dd;

      if (ret < 0) {
        currentStreak++;
        if (currentStreak > maxStreak) maxStreak = currentStreak;
      } else {
        currentStreak = 0;
      }
    }

    maxDrawdowns.push(maxDd);
    losingStreaks.push(maxStreak);
    finalCapitals.push(capital);
  }

  maxDrawdowns.sort((a, b) => a - b);
  losingStreaks.sort((a, b) => a - b);

  const percentile = (arr: number[], p: number) => arr[Math.floor(arr.length * p)];

  return {
    pDrawdownGreaterThanX: {
      5: maxDrawdowns.filter((d) => d > 0.05).length / iterations,
      10: maxDrawdowns.filter((d) => d > 0.10).length / iterations,
      20: maxDrawdowns.filter((d) => d > 0.20).length / iterations,
    },
    pLosingStreakGreaterThanN: {
      3: losingStreaks.filter((s) => s > 3).length / iterations,
      5: losingStreaks.filter((s) => s > 5).length / iterations,
      10: losingStreaks.filter((s) => s > 10).length / iterations,
    },
    pAccountLossGreaterThanX: {
      10: finalCapitals.filter((c) => c < startingCapital * 0.9).length / iterations,
      25: finalCapitals.filter((c) => c < startingCapital * 0.75).length / iterations,
      50: finalCapitals.filter((c) => c < startingCapital * 0.5).length / iterations,
    },
    maxDrawdownPct: maxDrawdowns[maxDrawdowns.length - 1] * 100,
    medianDrawdownPct: percentile(maxDrawdowns, 0.5) * 100,
    worstLosingStreak: losingStreaks[losingStreaks.length - 1],
  };
}

export function parameterPerturbationRobustness(
  baseParams: Record<string, number>,
  evaluate: (params: Record<string, number>) => number,
  perturbationPct = 0.1
): { robust: boolean; scores: number[]; cv: number } {
  const scores: number[] = [];
  scores.push(evaluate(baseParams));

  for (const key of Object.keys(baseParams)) {
    for (const sign of [-1, 1]) {
      const perturbed = { ...baseParams, [key]: baseParams[key] * (1 + sign * perturbationPct) };
      scores.push(evaluate(perturbed));
    }
  }

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / scores.length;
  const std = Math.sqrt(variance);
  const cv = mean !== 0 ? std / Math.abs(mean) : Infinity;

  return {
    robust: cv < 0.3 && scores.every((s) => s > 0),
    scores,
    cv,
  };
}

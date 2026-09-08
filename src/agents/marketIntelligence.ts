import axios from 'axios';
import Decimal from 'decimal.js';
import config from '../shared/config';
import logger from '../shared/logger';
import {
  Bias,
  Candle,
  MarketData,
  MarketIntelligence,
  MarketSnapshot,
  MicrostructureAnalysis,
  RegimeProbabilities,
  TechnicalAnalysis,
  TradeDirection,
} from '../shared/types';

export interface MarketIntelligenceRequest {
  symbol: string;
  timeframe: string;
  marketData: MarketData;
  regime: RegimeProbabilities;
  microstructure: MicrostructureAnalysis;
  technicalAnalysis: TechnicalAnalysis;
}

/**
 * Market Intelligence agent.
 *
 * Builds a structured MarketSnapshot from live data and optionally calls an
 * external LLM to produce a directional verdict. Falls back to a rules-based
 * local synthesis when no LLM is configured or the call fails.
 */
export class MarketIntelligenceAgent {
  async analyze(req: MarketIntelligenceRequest): Promise<MarketIntelligence> {
    const snapshot = this.buildSnapshot(req);

    let intelligence: MarketIntelligence;

    if (config.openaiApiKey) {
      try {
        intelligence = await this.callLLM(snapshot, req);
      } catch (err) {
        logger.error('MarketIntelligence LLM call failed; falling back to local synthesis', {
          err: (err as Error).message,
        });
        intelligence = this.localSynthesis(snapshot, req);
      }
    } else {
      intelligence = this.localSynthesis(snapshot, req);
    }

    logger.info('MarketIntelligence verdict', {
      bias: intelligence.bias,
      stance: intelligence.tradeStance,
      direction: intelligence.recommendedDirection,
      confidence: intelligence.confidence,
      source: intelligence.source,
    });

    return intelligence;
  }

  private buildSnapshot(req: MarketIntelligenceRequest): MarketSnapshot {
    const { marketData, regime, microstructure, technicalAnalysis } = req;
    const candles = marketData.candles;
    const closes = candles.map((c) => c.close);

    const sma20 = this.sma(closes, 20);
    const ema9 = this.ema(closes, 9);
    const ema21 = this.ema(closes, 21);
    const atr14 = this.atr(candles, 14);

    const bestBid = microstructure.orderBook.bestBid;
    const bestAsk = microstructure.orderBook.bestAsk;
    const weightedMid = microstructure.orderBook.weightedMidPrice;

    const dataQuality: MarketSnapshot['dataQuality'] = marketData.dataQualityFlags.some(
      (f) => f.type === 'gap' || f.type === 'stale'
    )
      ? 'low'
      : marketData.dataQualityFlags.length > 0
        ? 'medium'
        : 'high';

    const lastPrice = marketData.ticker24h.lastPrice;
    const atrPct = lastPrice.gt(0) && atr14 ? atr14.div(lastPrice).toNumber() : 0;

    return {
      symbol: marketData.symbol,
      timestamp: Date.now(),
      lastPrice,
      bestBid,
      bestAsk,
      spreadPct: microstructure.orderBook.spreadPct,
      weightedMid,
      change24hPct: marketData.ticker24h.priceChangePercent.toNumber(),
      volume24h: marketData.ticker24h.volume,
      quoteVolume24h: marketData.ticker24h.quoteVolume,
      fundingRate: marketData.fundingRate ? marketData.fundingRate.fundingRate.toNumber() : null,
      atr14,
      atrPct,
      sma20,
      ema9,
      ema21,
      adx14: technicalAnalysis.indicators['ADX(14)']?.value ?? null,
      liquidityScore: microstructure.liquidity.liquidityScore,
      bidAskImbalance: microstructure.orderBook.bidAskImbalance,
      depthImbalance: microstructure.orderBook.depthImbalance,
      dominantRegime: regime.dominantRegime,
      regimeConfidence: regime.confidence,
      dataQuality,
    };
  }

  private async callLLM(
    snapshot: MarketSnapshot,
    req: MarketIntelligenceRequest
  ): Promise<MarketIntelligence> {
    logger.info('MarketIntelligence calling external LLM', {
      baseUrl: config.openaiBaseUrl,
      symbol: req.symbol,
    });

    const prompt = this.buildPrompt(snapshot, req);

    const { data } = await axios.post(
      `${config.openaiBaseUrl}/chat/completions`,
      {
        model: config.openaiModel,
        messages: [
          {
            role: 'system',
            content:
              'You are a senior crypto market intelligence analyst. You only emit JSON. Be concise, adversarial, and quantitative. If the setup is unclear, recommend no_trade.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: config.openaiBaseUrl.includes('opencode.ai') ? 1 : 0.2,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openaiApiKey}`,
          'User-Agent': 'opencode-trading-bot/1.0',
          'x-opencode-session': 'opencode-trading-bot-session',
        },
        timeout: 60000,
      }
    );

    const content = data.choices?.[0]?.message?.content ?? '{}';
    const raw = this.extractJson(content) as Partial<MarketIntelligenceOutput>;
    return this.validateResponse(snapshot, raw, 'llm');
  }

  private buildPrompt(snapshot: MarketSnapshot, req: MarketIntelligenceRequest): string {
    return `Analyze the following market snapshot and return ONLY a JSON object matching this schema:
{
  "summary": "string",
  "bias": "bullish|bearish|neutral",
  "confidence": 0.0,
  "tradeStance": "aggressive|neutral|defensive|no_trade",
  "recommendedDirection": "long|short|no_trade",
  "keyRisks": ["string"],
  "invalidationConditions": ["string"]
}

Symbol: ${snapshot.symbol}
Timeframe: ${req.timeframe}
Last price: ${snapshot.lastPrice.toFixed(2)}
Spread: ${(snapshot.spreadPct * 10000).toFixed(2)} bps
24h change: ${(snapshot.change24hPct * 100).toFixed(2)}%
Dominant regime: ${snapshot.dominantRegime} (confidence ${snapshot.regimeConfidence.toFixed(2)})
Liquidity score: ${snapshot.liquidityScore}/100
Bid/ask imbalance: ${snapshot.bidAskImbalance.toFixed(3)}
Depth imbalance: ${snapshot.depthImbalance.toFixed(3)}
ATR%: ${(snapshot.atrPct * 100).toFixed(3)}%
Technical bias: ${req.technicalAnalysis.technicalBias}
Data quality: ${snapshot.dataQuality}

Be adversarial. Return only valid JSON.`;
  }

  private localSynthesis(
    snapshot: MarketSnapshot,
    req: MarketIntelligenceRequest
  ): MarketIntelligence {
    let bias: Bias = req.technicalAnalysis.technicalBias;
    let confidence = 0.5;
    const keyRisks: string[] = [];

    if (snapshot.dataQuality === 'low') {
      bias = 'neutral';
      confidence = 0.2;
      keyRisks.push('Low data quality');
    }

    if (snapshot.liquidityScore < 50) {
      confidence *= 0.8;
      keyRisks.push('Poor liquidity');
    }

    if (snapshot.spreadPct > 0.001) {
      confidence *= 0.85;
      keyRisks.push('Wide spread erodes edge');
    }

    if (snapshot.regimeConfidence < 0.5) {
      confidence *= 0.85;
      keyRisks.push('Uncertain regime');
    }

    // Confirm/deny with microstructure
    if (snapshot.bidAskImbalance > 0.25 && bias === 'bullish') confidence = Math.min(0.9, confidence + 0.1);
    if (snapshot.bidAskImbalance < -0.25 && bias === 'bearish') confidence = Math.min(0.9, confidence + 0.1);
    if (Math.sign(snapshot.bidAskImbalance) !== (bias === 'bullish' ? 1 : -1)) {
      confidence *= 0.9;
    }

    let recommendedDirection: TradeDirection = 'no_trade';
    if (confidence >= 0.55) {
      recommendedDirection = bias === 'bullish' ? 'long' : bias === 'bearish' ? 'short' : 'no_trade';
    }

    const tradeStance: MarketIntelligence['tradeStance'] =
      confidence >= 0.75 && snapshot.liquidityScore >= 70 ? 'aggressive' : confidence >= 0.55 ? 'neutral' : 'no_trade';

    return {
      snapshot,
      summary: `Local synthesis: ${snapshot.dominantRegime} regime, technical bias ${bias}, liquidity ${snapshot.liquidityScore}/100.`,
      bias,
      confidence: Number(confidence.toFixed(3)),
      tradeStance,
      recommendedDirection,
      keyRisks,
      invalidationConditions: [
        'Regime flips against bias.',
        'Liquidity score drops below 50.',
        'Spread widens beyond 10 bps.',
      ],
      source: 'local',
    };
  }

  private validateResponse(
    snapshot: MarketSnapshot,
    raw: Partial<MarketIntelligenceOutput>,
    source: 'llm' | 'local'
  ): MarketIntelligence {
    const bias = this.validBias(raw.bias) ?? 'neutral';
    const recommendedDirection = this.validDirection(raw.recommendedDirection) ?? 'no_trade';
    const tradeStance = this.validStance(raw.tradeStance) ??
      (recommendedDirection === 'no_trade' ? 'no_trade' : 'neutral');

    return {
      snapshot,
      summary: raw.summary ?? 'No summary provided',
      bias,
      confidence: clamp(raw.confidence ?? 0),
      tradeStance,
      recommendedDirection,
      keyRisks: Array.isArray(raw.keyRisks) ? raw.keyRisks : [],
      invalidationConditions: Array.isArray(raw.invalidationConditions) ? raw.invalidationConditions : [],
      source,
    };
  }

  private extractJson(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          // fall through
        }
      }
      logger.warn('MarketIntelligence could not parse JSON from model response', {
        content: content.slice(0, 500),
      });
      return {};
    }
  }

  private validBias(v?: string): Bias | null {
    if (v === 'bullish' || v === 'bearish' || v === 'neutral') return v;
    return null;
  }

  private validDirection(v?: string): TradeDirection | null {
    if (v === 'long' || v === 'short' || v === 'no_trade') return v;
    return null;
  }

  private validStance(v?: string): MarketIntelligence['tradeStance'] | null {
    if (v === 'aggressive' || v === 'neutral' || v === 'defensive' || v === 'no_trade') return v;
    return null;
  }

  private sma(values: Decimal[], n: number): Decimal | null {
    if (values.length < n) return null;
    const sum = values.slice(-n).reduce((a, b) => a.plus(b), new Decimal(0));
    return sum.div(n);
  }

  private ema(values: Decimal[], n: number): Decimal | null {
    if (values.length < n) return null;
    const k = new Decimal(2).div(n + 1);
    let e = values[0];
    for (let i = 1; i < values.length; i++) {
      e = values[i].times(k).plus(e.times(new Decimal(1).minus(k)));
    }
    return e;
  }

  private atr(candles: Candle[], n: number): Decimal | null {
    if (candles.length < n + 1) return null;
    const trs: Decimal[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const cur = candles[i];
      trs.push(
        Decimal.max(
          cur.high.minus(cur.low),
          cur.high.minus(prev.close).abs(),
          cur.low.minus(prev.close).abs()
        )
      );
    }
    return this.ema(trs, n);
  }
}

interface MarketIntelligenceOutput {
  summary: string;
  bias: Bias;
  confidence: number;
  tradeStance: MarketIntelligence['tradeStance'];
  recommendedDirection: TradeDirection;
  keyRisks: string[];
  invalidationConditions: string[];
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export const marketIntelligenceAgent = new MarketIntelligenceAgent();
export default marketIntelligenceAgent;

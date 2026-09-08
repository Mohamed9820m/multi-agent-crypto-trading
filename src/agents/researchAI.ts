import axios from 'axios';
import config from '../shared/config';
import logger from '../shared/logger';
import {
  MicrostructureAnalysis,
  PortfolioState,
  RegimeProbabilities,
  StrategyCandidate,
  TechnicalAnalysis,
  TradeDirection,
} from '../shared/types';
import clawbotAgent from './clawbot';

export interface ResearchAIRequest {
  symbol: string;
  timeframe: string;
  regime: RegimeProbabilities;
  microstructure: MicrostructureAnalysis;
  technicalAnalysis: TechnicalAnalysis;
  candidates: StrategyCandidate[];
  portfolioState: PortfolioState;
  recentTrades?: unknown[];
}

export interface ResearchAIResponse {
  thesis: string;
  strategy: string;
  direction: TradeDirection | 'no_trade';
  confidence: number;
  expectedEdge: number;
  riskFactors: string[];
  invalidationConditions: string[];
  recommendedAction: 'STRONG_BUY' | 'BUY' | 'SMALL_BUY' | 'WAIT' | 'NO_TRADE' | 'SMALL_SELL' | 'SELL' | 'STRONG_SELL' | 'REDUCE' | 'EXIT' | 'HEDGE';
}

/**
 * Research AI / CLAWBOT agent.
 *
 * Sends a structured research request to an external AI endpoint if configured,
 * otherwise synthesizes a conservative local recommendation from existing analyses.
 *
 * This agent NEVER executes trades directly. It returns intelligence only.
 */
export class ResearchAIAgent {
  async analyze(req: ResearchAIRequest): Promise<ResearchAIResponse> {
    // External CLAWBOT service (user-provided URL) takes precedence.
    if (config.clawbotUrl) {
      return this.callClawbot(req);
    }

    // Built-in CLAWBOT agent: web, forums, cross-pairs, news + LLM synthesis.
    if (config.clawbotMode === 'internal') {
      const clawbot = await clawbotAgent.analyze(req);
      return this.mapClawbotToResearchAI(clawbot);
    }

    if (config.openaiApiKey) {
      return this.callOpenAI(req);
    }
    return this.localSynthesis(req);
  }

  private async callClawbot(req: ResearchAIRequest): Promise<ResearchAIResponse> {
    logger.info('ResearchAI calling CLAWBOT', { url: config.clawbotUrl, symbol: req.symbol });
    const { data } = await axios.post<ResearchAIResponse>(config.clawbotUrl, req, {
      headers: {
        'Content-Type': 'application/json',
        ...(config.clawbotApiKey ? { Authorization: `Bearer ${config.clawbotApiKey}` } : {}),
      },
      timeout: 30000,
    });
    return this.validateResponse(data);
  }

  private async callOpenAI(req: ResearchAIRequest): Promise<ResearchAIResponse> {
    logger.info('ResearchAI calling external LLM', { baseUrl: config.openaiBaseUrl, symbol: req.symbol });
    const selected = req.candidates
      .filter((c) => c.direction !== 'no_trade')
      .sort((a, b) => b.score - a.score)[0];

    const prompt = this.buildPrompt(req, selected);

    try {
      const { data } = await axios.post(
        `${config.openaiBaseUrl}/chat/completions`,
        {
          model: config.openaiModel,
          messages: [
            {
              role: 'system',
              content:
                'You are a skeptical quantitative research analyst for a crypto trading firm. You only emit JSON. You never fabricate prices or data. If uncertain, recommend NO_TRADE.',
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
          timeout: 120000,
        }
      );

      const content = data.choices?.[0]?.message?.content ?? '{}';
      const raw = this.extractJson(content);
      return this.validateResponse(raw);
    } catch (err) {
      logger.error('ResearchAI external LLM call failed; falling back to local synthesis', {
        err: (err as Error).message,
      });
      return this.localSynthesis(req);
    }
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
      logger.warn('ResearchAI could not parse JSON from model response', { content: content.slice(0, 500) });
      return {};
    }
  }

  private localSynthesis(req: ResearchAIRequest): ResearchAIResponse {
    const selected = req.candidates
      .filter((c) => c.direction !== 'no_trade')
      .sort((a, b) => b.score - a.score)[0];

    if (!selected) {
      return {
        thesis: 'No strategy candidate passed internal gates.',
        strategy: 'none',
        direction: 'no_trade',
        confidence: 0,
        expectedEdge: 0,
        riskFactors: ['No candidate'],
        invalidationConditions: [],
        recommendedAction: 'NO_TRADE',
      };
    }

    const riskFactors: string[] = [];
    if (req.microstructure.liquidity.gapRisk === 'high') riskFactors.push('Low liquidity / gap risk');
    if (req.regime.confidence < 0.5) riskFactors.push('Uncertain regime');
    if (req.portfolioState.exposure.perSymbolExposure[req.symbol]?.gt(req.portfolioState.account.equityEUR.times(0.5))) {
      riskFactors.push('High existing symbol exposure');
    }

    return {
      thesis: `Internal ${selected.strategy} candidate with score ${selected.score.toFixed(3)} and EV ${selected.expectedValue.expectedValuePct.toFixed(4)}%`,
      strategy: selected.strategy,
      direction: selected.direction,
      confidence: selected.statisticalConfidence,
      expectedEdge: selected.expectedValue.expectedValuePct,
      riskFactors,
      invalidationConditions: selected.invalidationConditions,
      recommendedAction: this.mapDirectionToAction(selected.direction, selected.statisticalConfidence),
    };
  }

  private buildPrompt(req: ResearchAIRequest, selected?: StrategyCandidate): string {
    return `Analyze the following crypto trading situation and return ONLY a JSON object matching this schema:
{
  "thesis": "string",
  "strategy": "string",
  "direction": "long|short|no_trade",
  "confidence": 0.0,
  "expectedEdge": 0.0,
  "riskFactors": ["string"],
  "invalidationConditions": ["string"],
  "recommendedAction": "STRONG_BUY|BUY|SMALL_BUY|WAIT|NO_TRADE|SMALL_SELL|SELL|STRONG_SELL|REDUCE|EXIT|HEDGE"
}

Symbol: ${req.symbol}
Timeframe: ${req.timeframe}
Dominant regime: ${req.regime.dominantRegime} (confidence ${req.regime.confidence.toFixed(2)})
Microstructure bias: ${req.microstructure.bias} (confidence ${req.microstructure.confidence})
Liquidity score: ${req.microstructure.liquidity.liquidityScore}
Spread: ${(req.microstructure.orderBook.spreadPct * 100).toFixed(4)}%
Technical bias: ${req.technicalAnalysis.technicalBias}
Portfolio gross exposure EUR: ${req.portfolioState.exposure.grossExposureEUR.toFixed(2)}
Best internal candidate: ${selected ? `${selected.strategy} ${selected.direction} score=${selected.score.toFixed(3)} EV=${selected.expectedValue.expectedValuePct.toFixed(4)}%` : 'none'}

Be adversarial. Challenge the thesis. If data is insufficient, recommend NO_TRADE.`;
  }

  private mapClawbotToResearchAI(clawbot: import('./clawbot').ClawbotResponse): ResearchAIResponse {
    return {
      thesis: clawbot.thesis,
      strategy: clawbot.strategy,
      direction: clawbot.direction,
      confidence: clawbot.confidence,
      expectedEdge: clawbot.expectedEdge,
      riskFactors: clawbot.riskFactors,
      invalidationConditions: clawbot.invalidationConditions,
      recommendedAction: clawbot.recommendedAction,
    };
  }

  private mapDirectionToAction(
    direction: TradeDirection,
    confidence: number
  ): ResearchAIResponse['recommendedAction'] {
    if (direction === 'no_trade') return 'NO_TRADE';
    if (direction === 'long') {
      if (confidence > 0.8) return 'STRONG_BUY';
      if (confidence > 0.6) return 'BUY';
      return 'SMALL_BUY';
    }
    if (confidence > 0.8) return 'STRONG_SELL';
    if (confidence > 0.6) return 'SELL';
    return 'SMALL_SELL';
  }

  private validateResponse(data: unknown): ResearchAIResponse {
    const raw = data as Partial<ResearchAIResponse>;
    return {
      thesis: raw.thesis ?? 'No thesis provided',
      strategy: raw.strategy ?? 'unknown',
      direction: (raw.direction as TradeDirection) ?? 'no_trade',
      confidence: clamp(raw.confidence ?? 0),
      expectedEdge: raw.expectedEdge ?? 0,
      riskFactors: Array.isArray(raw.riskFactors) ? raw.riskFactors : [],
      invalidationConditions: Array.isArray(raw.invalidationConditions) ? raw.invalidationConditions : [],
      recommendedAction: (raw.recommendedAction as ResearchAIResponse['recommendedAction']) ?? 'NO_TRADE',
    };
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export const researchAIAgent = new ResearchAIAgent();
export default researchAIAgent;

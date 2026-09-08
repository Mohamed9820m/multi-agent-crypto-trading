import logger from '../shared/logger';
import { SentimentOutput } from '../shared/types';

export interface SentimentSources {
  newsEndpoints?: string[];
  socialKeywords?: string[];
  onChainProviders?: string[];
}

export class SentimentAgent {
  async assess(
    symbol: string,
    _lookbackHours = 24,
    timeoutMs = 5000
  ): Promise<SentimentOutput> {
    logger.info('SentimentAgent assessing', { symbol });

    // In production this would call news/social/on-chain APIs asynchronously.
    // For this implementation we run a stub that completes quickly and returns neutral.
    const start = Date.now();

    const output: SentimentOutput = await Promise.race([
      this.fetchSentiment(symbol),
      new Promise<SentimentOutput>((_, reject) =>
        setTimeout(() => reject(new Error('Sentiment fetch timed out')), timeoutMs)
      ),
    ]).catch((err) => {
      logger.warn('SentimentAgent timed out or failed — returning neutral', { symbol, err: err.message });
      return {
        sentimentScore: 0,
        keyEvents: [],
        sources: [],
        timeout: true,
      };
    });

    const elapsed = Date.now() - start;
    logger.info('SentimentAgent complete', { symbol, elapsed, score: output.sentimentScore });
    return output;
  }

  private async fetchSentiment(symbol: string): Promise<SentimentOutput> {
    // Placeholder for real API integration.
    // Returning neutral ensures the system does not fabricate signals.
    return {
      sentimentScore: 0,
      keyEvents: [`No configured news/social feeds for ${symbol}`],
      sources: ['stub'],
    };
  }
}

export const sentimentAgent = new SentimentAgent();
export default sentimentAgent;

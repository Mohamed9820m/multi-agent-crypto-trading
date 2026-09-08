import axios from 'axios';
import Decimal from 'decimal.js';
import config from '../shared/config';
import logger from '../shared/logger';
import { binanceClient } from '../shared/binance';
import { pairDiscoveryCache } from '../shared/pairDiscoveryCache';
import { pairSignalDirection } from '../shared/pairDiscovery';
import { getTokenMapping } from './clawbot/sources/tokenMapping';
import { enrichOnChain, OnChainEnrichment } from './clawbot/sources/onchain';
import { fetchCoinGlassMetrics, CoinGlassMetrics } from './clawbot/sources/coinglass';
import { fetchArkhamEntity, ArkhamEntityInfo } from './clawbot/sources/arkham';
import { fetchBubbleMaps, BubbleMapsClustering } from './clawbot/sources/bubblemaps';
import {
  MarketData,
  MicrostructureAnalysis,
  PortfolioState,
  RegimeProbabilities,
  StrategyCandidate,
  TechnicalAnalysis,
  TradeDirection,
} from '../shared/types';

export interface ClawbotRequest {
  symbol: string;
  timeframe: string;
  regime: RegimeProbabilities;
  microstructure: MicrostructureAnalysis;
  technicalAnalysis: TechnicalAnalysis;
  candidates: StrategyCandidate[];
  portfolioState: PortfolioState;
}

export interface ClawbotResponse {
  thesis: string;
  strategy: string;
  direction: TradeDirection | 'no_trade';
  confidence: number;
  expectedEdge: number;
  riskFactors: string[];
  invalidationConditions: string[];
  recommendedAction:
    | 'STRONG_BUY'
    | 'BUY'
    | 'SMALL_BUY'
    | 'WAIT'
    | 'NO_TRADE'
    | 'SMALL_SELL'
    | 'SELL'
    | 'STRONG_SELL'
    | 'REDUCE'
    | 'EXIT'
    | 'HEDGE';
  sources: string[];
}

interface EnrichedMarketData {
  symbol: string;
  binance24h: MarketData['ticker24h'];
  coinGecko?: CoinGeckoMarketData;
  fearGreed?: FearGreedData;
  redditPosts: RedditPost[];
  newsHeadlines: string[];
  trendingCoins: string[];
  topPairs: TopPair[];
  onchain?: OnChainEnrichment;
  coinglass?: CoinGlassMetrics;
  arkham?: ArkhamEntityInfo;
  bubblemaps?: BubbleMapsClustering;
}

interface CoinGeckoMarketData {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number;
  market_cap: number;
  total_volume: number;
  market_cap_rank: number;
  sentiment_votes_up_percentage?: number;
  sentiment_votes_down_percentage?: number;
}

interface FearGreedData {
  value: number;
  value_classification: string;
  timestamp: string;
}

interface RedditPost {
  title: string;
  subreddit: string;
  url: string;
  score: number;
  createdUtc: number;
}

interface TopPair {
  hedgeSymbol: string;
  correlation: number;
  zScore: number;
  halfLife: number;
  signal: 'long' | 'short' | 'no_trade';
}

const COINGECKO_ID_MAP: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  SOL: 'solana',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  AVAX: 'avalanche-2',
};

/**
 * CLAWBOT — Comprehensive Liquidity & Advanced Web-Based Opinion Trader.
 *
 * Acts as an expert external analyst: gathers market data, social/forum
 * sentiment, macro indicators, cross-pair signals, and news, then synthesises
 * everything through an LLM into a trading recommendation.
 *
 * This agent NEVER executes orders directly.
 */
export class ClawbotAgent {
  async analyze(req: ClawbotRequest): Promise<ClawbotResponse> {
    logger.info('CLAWBOT analyzing', { symbol: req.symbol, timeframe: req.timeframe });

    const enriched = await this.gatherData(req);
    const prompt = this.buildPrompt(req, enriched);

    try {
      const response = await this.callLLM(prompt);
      logger.info('CLAWBOT recommendation', {
        symbol: req.symbol,
        direction: response.direction,
        confidence: response.confidence,
        sources: response.sources,
      });
      return response;
    } catch (err) {
      logger.error('CLAWBOT LLM synthesis failed; falling back to conservative no-trade', {
        err: (err as Error).message,
      });
      return this.conservativeNoTrade(req, enriched, String(err));
    }
  }

  private async gatherData(req: ClawbotRequest): Promise<EnrichedMarketData> {
    const baseAsset = req.symbol.replace(/USDT|BUSD|USDC$/, '').toUpperCase();
    const coinGeckoId = COINGECKO_ID_MAP[baseAsset];
    const tokenMapping = getTokenMapping(req.symbol);

    const [
      binance24h,
      coinGecko,
      fearGreed,
      redditPosts,
      newsHeadlines,
      trendingCoins,
      topPairs,
      onchain,
      coinglass,
    ] = await Promise.all([
      this.fetchBinance24h(req.symbol),
      coinGeckoId ? this.fetchCoinGecko(coinGeckoId) : Promise.resolve(undefined),
      this.fetchFearGreed(),
      this.fetchReddit(baseAsset),
      this.fetchCryptoNews(baseAsset),
      this.fetchTrendingCoins(),
      this.fetchTopPairs(req.symbol),
      tokenMapping ? enrichOnChain(req.symbol, tokenMapping).catch(() => undefined) : Promise.resolve(undefined),
      fetchCoinGlassMetrics(req.symbol).catch(() => undefined),
    ]);

    const [arkham, bubblemaps] = await Promise.all([
      onchain?.contractAddress ? fetchArkhamEntity(onchain.contractAddress).catch(() => undefined) : Promise.resolve(undefined),
      onchain?.contractAddress ? fetchBubbleMaps(onchain.contractAddress).catch(() => undefined) : Promise.resolve(undefined),
    ]);

    return {
      symbol: req.symbol,
      binance24h,
      coinGecko,
      fearGreed,
      redditPosts,
      newsHeadlines,
      trendingCoins,
      topPairs,
      onchain,
      coinglass,
      arkham,
      bubblemaps,
    };
  }

  private async fetchBinance24h(symbol: string): Promise<MarketData['ticker24h']> {
    try {
      return await binanceClient.getTicker24h(symbol);
    } catch (err) {
      logger.warn('CLAWBOT failed to fetch Binance 24h ticker', { err: (err as Error).message });
      return {
        priceChange: new Decimal(0),
        priceChangePercent: new Decimal(0),
        weightedAvgPrice: new Decimal(0),
        prevClosePrice: new Decimal(0),
        lastPrice: new Decimal(0),
        lastQty: new Decimal(0),
        bidPrice: new Decimal(0),
        askPrice: new Decimal(0),
        openPrice: new Decimal(0),
        highPrice: new Decimal(0),
        lowPrice: new Decimal(0),
        volume: new Decimal(0),
        quoteVolume: new Decimal(0),
        openTime: 0,
        closeTime: 0,
        firstId: 0,
        lastId: 0,
        count: 0,
      };
    }
  }

  private async fetchCoinGecko(id: string): Promise<CoinGeckoMarketData | undefined> {
    try {
      const { data } = await axios.get<CoinGeckoMarketData[]>(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h`,
        { timeout: 10000 }
      );
      return data[0];
    } catch (err) {
      logger.warn('CLAWBOT CoinGecko fetch failed', { err: (err as Error).message });
      return undefined;
    }
  }

  private async fetchFearGreed(): Promise<FearGreedData | undefined> {
    try {
      interface FngResponse {
        data: { value: string; value_classification: string; timestamp: string }[];
      }
      const { data } = await axios.get<FngResponse>('https://api.alternative.me/fng/?limit=1', {
        timeout: 10000,
      });
      const item = data.data[0];
      if (!item) return undefined;
      return {
        value: Number(item.value),
        value_classification: item.value_classification,
        timestamp: item.timestamp,
      };
    } catch (err) {
      logger.warn('CLAWBOT fear & greed fetch failed', { err: (err as Error).message });
      return undefined;
    }
  }

  private async fetchReddit(asset: string): Promise<RedditPost[]> {
    try {
      const { data } = await axios.get(
        `https://www.reddit.com/r/CryptoCurrency/search.json?q=${encodeURIComponent(
          asset
        )}&restrict_sr=1&sort=new&limit=5`,
        {
          timeout: 10000,
          headers: {
            'User-Agent': 'clawbot-research/1.0 (by /u/clawbot_research)',
          },
        }
      );

      const posts: RedditPost[] = [];
      for (const child of data?.data?.children ?? []) {
        const p = child.data;
        if (p && p.title) {
          posts.push({
            title: p.title,
            subreddit: p.subreddit,
            url: `https://www.reddit.com${p.permalink}`,
            score: p.score ?? 0,
            createdUtc: p.created_utc ?? 0,
          });
        }
      }
      return posts;
    } catch (err) {
      logger.warn('CLAWBOT Reddit fetch failed', { err: (err as Error).message });
      return [];
    }
  }

  private async fetchCryptoNews(asset: string): Promise<string[]> {
    try {
      const { data } = await axios.get<string>('https://cointelegraph.com/rss', {
        timeout: 10000,
        responseType: 'text',
      });
      const headlines: string[] = [];
      const regex = /<title>([^<]+)<\/title>/g;
      let match: RegExpExecArray | null;
      const term = asset.toLowerCase();
      while ((match = regex.exec(data)) !== null) {
        const title = match[1].trim();
        if (title.toLowerCase().includes(term) || title.toLowerCase().includes('bitcoin') || title.toLowerCase().includes('crypto')) {
          headlines.push(title);
        }
        if (headlines.length >= 5) break;
      }
      return headlines;
    } catch (err) {
      logger.warn('CLAWBOT news fetch failed', { err: (err as Error).message });
      return [];
    }
  }

  private async fetchTrendingCoins(): Promise<string[]> {
    try {
      interface TrendingResponse {
        coins: { item: { name: string; symbol: string } }[];
      }
      const { data } = await axios.get<TrendingResponse>(
        'https://api.coingecko.com/api/v3/search/trending',
        { timeout: 10000 }
      );
      return (data.coins ?? []).slice(0, 5).map((c) => `${c.item.name} (${c.item.symbol})`);
    } catch (err) {
      logger.warn('CLAWBOT trending coins fetch failed', { err: (err as Error).message });
      return [];
    }
  }

  private async fetchTopPairs(symbol: string): Promise<TopPair[]> {
    try {
      await pairDiscoveryCache.refresh(symbol);
      return pairDiscoveryCache
        .getPairs(symbol)
        .slice(0, 3)
        .map((p) => ({
          hedgeSymbol: p.hedgeSymbol,
          correlation: p.correlation,
          zScore: p.zScore,
          halfLife: p.halfLife,
          signal: pairSignalDirection(p),
        }));
    } catch (err) {
      logger.warn('CLAWBOT pair discovery failed', { err: (err as Error).message });
      return [];
    }
  }

  private buildPrompt(req: ClawbotRequest, enriched: EnrichedMarketData): string {
    const selected = req.candidates
      .filter((c) => c.direction !== 'no_trade')
      .sort((a, b) => b.score - a.score)[0];

    const t24 = enriched.binance24h;

    return `You are CLAWBOT, a senior crypto quant research analyst with access to CEX market data, on-chain intelligence, derivatives metrics, social forums, cross-pair signals, news, and smart-money forensics. Be adversarial and quantitative. Return ONLY valid JSON matching this schema:

{
  "thesis": "string",
  "strategy": "string",
  "direction": "long|short|no_trade",
  "confidence": 0.0,
  "expectedEdge": 0.0,
  "riskFactors": ["string"],
  "invalidationConditions": ["string"],
  "recommendedAction": "STRONG_BUY|BUY|SMALL_BUY|WAIT|NO_TRADE|SMALL_SELL|SELL|STRONG_SELL|REDUCE|EXIT|HEDGE",
  "sources": ["string"]
}

[SYSTEM INSTRUCTION: If DERIVATIVES, COINGLASS, or SMART_MONEY data is returned as "NOT_CONFIGURED", ignore those parameters. Do not penalize the confidence score for missing data. Base your quantitative verdict strictly on the available microstructure, trend regime, and price action.]

SYMBOL: ${req.symbol}
TIMEFRAME: ${req.timeframe}

--- INTERNAL ANALYSIS ---
Dominant regime: ${req.regime.dominantRegime} (confidence ${req.regime.confidence.toFixed(2)})
Technical bias: ${req.technicalAnalysis.technicalBias} (confidence ${req.technicalAnalysis.confidence})
Microstructure bias: ${req.microstructure.bias} (confidence ${req.microstructure.confidence})
Liquidity score: ${req.microstructure.liquidity.liquidityScore}/100
Spread: ${(req.microstructure.orderBook.spreadPct * 10000).toFixed(2)} bps
Bid/ask imbalance: ${req.microstructure.orderBook.bidAskImbalance.toFixed(3)}
Depth imbalance: ${req.microstructure.orderBook.depthImbalance.toFixed(3)}
Portfolio gross exposure EUR: ${req.portfolioState.exposure.grossExposureEUR.toFixed(2)}
Best internal candidate: ${selected ? `${selected.strategy} ${selected.direction} score=${selected.score.toFixed(3)} EV=${selected.expectedValue.expectedValuePct.toFixed(4)}%` : 'none'}

--- MARKET DATA ---
Binance 24h change: ${t24.priceChangePercent.toFixed(2)}%
Binance 24h volume: ${t24.volume.toFixed(4)} base / ${t24.quoteVolume.toFixed(2)} quote
Binance high/low: ${t24.highPrice.toFixed(2)} / ${t24.lowPrice.toFixed(2)}
${enriched.coinGecko ? `CoinGecko 24h change: ${enriched.coinGecko.price_change_percentage_24h?.toFixed(2) ?? 'n/a'}%` : ''}
${enriched.coinGecko ? `CoinGecko market cap rank: #${enriched.coinGecko.market_cap_rank}` : ''}
${enriched.coinGecko ? `CoinGecko 24h volume USD: $${enriched.coinGecko.total_volume?.toLocaleString() ?? 'n/a'}` : ''}

--- MACRO / SENTIMENT ---
Fear & Greed: ${enriched.fearGreed ? `${enriched.fearGreed.value} — ${enriched.fearGreed.value_classification}` : 'unavailable'}
Trending coins: ${enriched.trendingCoins.length ? enriched.trendingCoins.join(', ') : 'unavailable'}

--- FORUM SENTIMENT (r/CryptoCurrency) ---
${enriched.redditPosts.length ? enriched.redditPosts.map((p) => `- ${p.title} (score ${p.score})`).join('\n') : 'No recent posts fetched.'}

--- NEWS HEADLINES ---
${enriched.newsHeadlines.length ? enriched.newsHeadlines.map((h) => `- ${h}`).join('\n') : 'No headlines fetched.'}

--- CROSS-PAIR SIGNALS ---
${enriched.topPairs.length
  ? enriched.topPairs
      .map(
        (p) =>
          `- vs ${p.hedgeSymbol}: correlation ${p.correlation.toFixed(2)}, z-score ${p.zScore.toFixed(2)}, signal ${p.signal}`
      )
      .join('\n')
  : 'No actionable cointegrated pairs.'}

--- ON-CHAIN INTELLIGENCE ---
${enriched.onchain
  ? `- Wrapped asset: ${enriched.onchain.wrappedAsset} (${enriched.onchain.contractAddress} on chain ${enriched.onchain.chainId})
- Token: ${enriched.onchain.tokenInfo?.name ?? 'n/a'} (${enriched.onchain.tokenInfo?.symbol ?? 'n/a'})
- Decimals: ${enriched.onchain.tokenInfo?.decimals ?? 'n/a'}
- Total supply: ${enriched.onchain.tokenInfo?.totalSupply ?? 'n/a'}
- Contract owner: ${enriched.onchain.tokenInfo?.owner ?? (enriched.onchain.tokenInfo?.hasOwnerAbi ? 'renounced/no owner' : 'n/a')}
- 24h transfer count: ${enriched.onchain.transferSummary?.count24h ?? 'n/a'}
- 24h transfer volume (raw): ${enriched.onchain.transferSummary?.volume24h ?? 'n/a'}
- Unique senders/receivers 24h: ${enriched.onchain.transferSummary?.uniqueSenders ?? 'n/a'} / ${enriched.onchain.transferSummary?.uniqueReceivers ?? 'n/a'}
- GoPlus risk level: ${enriched.onchain.goPlus?.riskLevel ?? 'n/a'}
- GoPlus warnings: ${enriched.onchain.goPlus?.warnings.length ? enriched.onchain.goPlus.warnings.join('; ') : 'none'}
- GoPlus DEX liquidity USD: $${enriched.onchain.goPlus?.dexLiquidityUsd.toLocaleString() ?? 'n/a'}
- GoPlus holders: ${enriched.onchain.goPlus?.holderCount ?? 'n/a'}, LP holders: ${enriched.onchain.goPlus?.lpHolderCount ?? 'n/a'}
- GoPlus top-10 holder %: ${enriched.onchain.goPlus?.top10HolderPercent.toFixed(2) ?? 'n/a'}%`
  : 'No on-chain mapping for this symbol.'}

--- DERIVATIVES / INSTITUTIONAL DATA (COINGLASS) ---
${enriched.coinglass
  ? `- Funding rate: ${enriched.coinglass.fundingRate !== undefined ? (enriched.coinglass.fundingRate * 100).toFixed(4) + '%' : 'n/a'}
- Open interest USD: $${enriched.coinglass.openInterestUsd?.toLocaleString() ?? 'n/a'}
- 24h long liquidations USD: $${enriched.coinglass.liquidationLongUsd24h?.toLocaleString() ?? 'n/a'}
- 24h short liquidations USD: $${enriched.coinglass.liquidationShortUsd24h?.toLocaleString() ?? 'n/a'}`
  : 'DERIVATIVES / COINGLASS: NOT_CONFIGURED'}

--- SMART MONEY / ENTITY FORENSICS ---
${enriched.arkham || enriched.bubblemaps
  ? `${enriched.arkham
      ? `- Arkham entity: ${enriched.arkham.entity ?? 'unknown'}
- Entity type: ${enriched.arkham.entityType ?? 'n/a'}
- Label: ${enriched.arkham.label ?? 'n/a'}
- Notes: ${enriched.arkham.riskNotes.length ? enriched.arkham.riskNotes.join('; ') : 'none'}`
      : ''}
${enriched.bubblemaps
      ? `- BubbleMaps decentralization score: ${enriched.bubblemaps.decentralizationScore}/100
- Clusters detected: ${enriched.bubblemaps.clusterCount}
- Top holder %: ${enriched.bubblemaps.topHolderPercent.toFixed(2)}%
- Warnings: ${enriched.bubblemaps.warnings.length ? enriched.bubblemaps.warnings.join('; ') : 'none'}`
      : ''}`
  : 'SMART_MONEY: NOT_CONFIGURED'}

TASK:
1. Synthesize the data into a 2-3 sentence thesis.
2. Pick a direction (long/short/no_trade) and recommended action.
3. List the concrete risk factors and invalidation conditions.
4. Set confidence 0.0-1.0 based on evidence strength.
5. Set expectedEdge as the estimated net edge after costs, as a decimal (e.g. 0.001 = 0.1%).
6. List the sources you actually used (e.g. "binance_24h", "coingecko", "fear_greed", "cointelegraph", "pair_discovery", "onchain", "goplus", "coinglass", "arkham", "bubblemaps", "internal_analysis").

If evidence is weak, contradictory, or data is missing, recommend NO_TRADE.`;
  }

  private async callLLM(prompt: string): Promise<ClawbotResponse> {
    if (!config.openaiApiKey) {
      throw new Error('No OpenAI API key configured for CLAWBOT');
    }

    const { data } = await axios.post(
      `${config.openaiBaseUrl}/chat/completions`,
      {
        model: config.openaiModel,
        messages: [
          {
            role: 'system',
            content:
              'You are CLAWBOT, an expert crypto quant analyst. You only emit JSON. You never fabricate data. If uncertain, recommend NO_TRADE.',
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
      logger.warn('CLAWBOT could not parse JSON from model response', { content: content.slice(0, 500) });
      return {};
    }
  }

  private validateResponse(data: unknown): ClawbotResponse {
    const raw = data as Partial<ClawbotResponse>;
    return {
      thesis: raw.thesis ?? 'No thesis provided',
      strategy: raw.strategy ?? 'none',
      direction: (raw.direction as TradeDirection) ?? 'no_trade',
      confidence: clamp(raw.confidence ?? 0),
      expectedEdge: raw.expectedEdge ?? 0,
      riskFactors: Array.isArray(raw.riskFactors) ? raw.riskFactors : [],
      invalidationConditions: Array.isArray(raw.invalidationConditions) ? raw.invalidationConditions : [],
      recommendedAction: (raw.recommendedAction as ClawbotResponse['recommendedAction']) ?? 'NO_TRADE',
      sources: Array.isArray(raw.sources) ? raw.sources : ['internal_analysis'],
    };
  }

  private conservativeNoTrade(
    _req: ClawbotRequest,
    _enriched: EnrichedMarketData,
    reason: string
  ): ClawbotResponse {
    return {
      thesis: `CLAWBOT synthesis failed or returned no actionable data: ${reason}. Conservative stance.`,
      strategy: 'none',
      direction: 'no_trade',
      confidence: 0,
      expectedEdge: 0,
      riskFactors: ['CLAWBOT synthesis unavailable', reason],
      invalidationConditions: [],
      recommendedAction: 'NO_TRADE',
      sources: ['internal_analysis'],
    };
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export const clawbotAgent = new ClawbotAgent();
export default clawbotAgent;

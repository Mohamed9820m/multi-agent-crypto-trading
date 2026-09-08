import axios from 'axios';
import Decimal from 'decimal.js';
import config from '../shared/config';
import logger from '../shared/logger';
import { getTokenMapping } from '../agents/clawbot/sources/tokenMapping';
import { latencyMonitor } from './latencyMonitor';
import { VenueQuote } from './types';

const USDT_ADDRESS: `0x${string}` = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

/**
 * Fetch a DEX quote via the 1inch Aggregation Router API.
 *
 * Requires ONEINCH_API_KEY. If disabled or misconfigured, returns undefined
 * so the router falls back to the CeFi venue.
 */
export async function getDexQuote(
  symbol: string,
  side: 'buy' | 'sell',
  notional: Decimal
): Promise<VenueQuote | undefined> {
  if (!config.dexEnabled || !config.oneinchApiKey) return undefined;

  const mapping = getTokenMapping(symbol);
  if (!mapping || mapping.chainId !== 1) {
    logger.debug('DEX quote unavailable: symbol not mapped to Ethereum', { symbol });
    return undefined;
  }

  // For BTCUSDT long, we swap USDT -> WBTC. For sell, WBTC -> USDT.
  const fromToken = side === 'buy' ? USDT_ADDRESS : mapping.address;
  const toToken = side === 'buy' ? mapping.address : USDT_ADDRESS;

  // Use 6 decimals for USDT, mapped decimals for base token.
  const fromDecimals = side === 'buy' ? 6 : mapping.decimals;
  const amountIn = BigInt(notional.times(10 ** fromDecimals).toFixed(0));

  try {
    const url = `https://api.1inch.dev/swap/v6.0/1/quote?src=${fromToken}&dst=${toToken}&amount=${amountIn.toString()}`;
    const { data } = await latencyMonitor.measure('1inch', 'quote', () =>
      axios.get(url, {
        headers: { Authorization: `Bearer ${config.oneinchApiKey}` },
        timeout: 8000,
      })
    );

    const toDecimals = side === 'buy' ? mapping.decimals : 6;
    const amountOut = BigInt(data.dstAmount ?? '0');
    const amountOutDecimal = new Decimal(amountOut.toString()).div(10 ** toDecimals);

    const price = side === 'buy'
      ? notional.div(amountOutDecimal)
      : amountOutDecimal.div(notional);

    // Rough gas cost estimate: 150k gas @ 20 gwei @ $2,500 ETH = ~$7.50
    const estimatedGasUsd = 7.5;
    const notionalUsd = notional.toNumber();
    const gasCostPct = notionalUsd > 0 ? estimatedGasUsd / notionalUsd : 0;

    return {
      venue: 'dex',
      name: '1inch',
      side,
      expectedAmountOut: amountOutDecimal,
      expectedPrice: price,
      expectedCostPct: 0.001 + gasCostPct, // 0.1% aggregator fee + gas
      expectedLatencyMs: 2500, // DEX latency is higher: wallet signature + mempool inclusion
      confidence: 0.75,
      route: `${fromToken} -> ${toToken}`,
      raw: data,
    };
  } catch (err) {
    logger.warn('1inch DEX quote failed', { symbol, side, err: (err as Error).message });
    return undefined;
  }
}

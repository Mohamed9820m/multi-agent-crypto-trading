import Decimal from 'decimal.js';
import logger from '../shared/logger';
import { getCexQuote } from './cexQuoter';
import { getDexQuote } from './dexQuoter';
import { estimateEthGasCostUsd } from './gasEstimator';
import { VenueQuote, VenueSelection } from './types';

const CEX_TAKER_FEE_PCT = 0.001;

/**
 * Hybrid CeFi / DeFi venue router.
 *
 * Fetches quotes from both CeFi (Binance) and DEX (1inch) venues, fetches the
 * live Ethereum gas cost in USD, and selects the venue with the highest net
 * output after all costs.
 *
 * Strict fallback: if the net DEX output (after gas) is not greater than the
 * Binance net output, the router rejects the DEX venue and returns CeFi.
 *
 * DEX is only enabled when DEX_ENABLED=true and a 1inch API key is configured.
 */
export async function selectBestVenue(
  symbol: string,
  side: 'buy' | 'sell',
  notional: Decimal,
  referencePrice: Decimal
): Promise<VenueSelection> {
  logger.info('VenueRouter selecting best venue', {
    symbol,
    side,
    notional: notional.toFixed(2),
    referencePrice: referencePrice.toFixed(2),
  });

  const alternatives: (VenueQuote | undefined)[] = await Promise.all([
    getCexQuote(symbol, side, notional),
    getDexQuote(symbol, side, notional),
  ]);

  const quotes = alternatives.filter((q): q is VenueQuote => !!q);
  const reasoning: string[] = [];

  if (quotes.length === 0) {
    reasoning.push('No venue quotes available; defaulting to CeFi execution');
    return {
      selectedVenue: 'cex',
      winner: placeholderCexQuote(symbol, side, notional),
      alternatives: [],
      reasoning,
    };
  }

  const cexQuote = quotes.find((q) => q.venue === 'cex');
  const dexQuote = quotes.find((q) => q.venue === 'dex');

  // If no DEX quote, winner is CeFi by default.
  if (!dexQuote || !cexQuote) {
    const winner = cexQuote ?? quotes[0];
    reasoning.push(`${winner.name} selected; DEX quote unavailable`);
    return {
      selectedVenue: winner.venue,
      winner,
      alternatives: quotes.filter((q) => q !== winner),
      reasoning,
    };
  }

  const gasCostUsd = await estimateEthGasCostUsd();
  const cexOutputUsd = computeOutputUsd(cexQuote, referencePrice);
  const dexGrossOutputUsd = computeOutputUsd(dexQuote, referencePrice);
  const dexNetOutputUsd = dexGrossOutputUsd.minus(gasCostUsd);
  const cexNetOutputUsd = cexOutputUsd.times(1 - CEX_TAKER_FEE_PCT);

  reasoning.push(
    `Binance gross output: $${cexOutputUsd.toFixed(2)}, net after ${(CEX_TAKER_FEE_PCT * 100).toFixed(2)}% fee: $${cexNetOutputUsd.toFixed(2)}`
  );
  reasoning.push(
    `1inch gross output: $${dexGrossOutputUsd.toFixed(2)}, gas cost: $${gasCostUsd.toFixed(2)}, net: $${dexNetOutputUsd.toFixed(2)}`
  );

  if (dexNetOutputUsd.gt(cexNetOutputUsd)) {
    reasoning.push(
      `DEX selected: net $${dexNetOutputUsd.toFixed(2)} > CEX net $${cexNetOutputUsd.toFixed(2)}`
    );
    logger.info('VenueRouter result', { selected: 'dex', name: dexQuote.name });
    return {
      selectedVenue: 'dex',
      winner: dexQuote,
      alternatives: [cexQuote],
      reasoning,
    };
  }

  reasoning.push(
    `CEX selected: DEX net $${dexNetOutputUsd.toFixed(2)} <= CEX net $${cexNetOutputUsd.toFixed(2)} (gas too expensive or DEX quote worse)`
  );
  logger.info('VenueRouter result', { selected: 'cex', name: cexQuote.name });
  return {
    selectedVenue: 'cex',
    winner: cexQuote,
    alternatives: [dexQuote],
    reasoning,
  };
}

function computeOutputUsd(quote: VenueQuote, referencePrice: Decimal): Decimal {
  if (quote.side === 'buy') {
    // We receive base tokens; value them at the reference price.
    return quote.expectedAmountOut.times(referencePrice);
  }
  // sell: we receive quote tokens directly (USDT)
  return quote.expectedAmountOut;
}

function placeholderCexQuote(symbol: string, side: 'buy' | 'sell', notional: Decimal): VenueQuote {
  return {
    venue: 'cex',
    name: 'binance_fallback',
    side,
    expectedAmountOut: notional,
    expectedPrice: new Decimal(0),
    expectedCostPct: 0.001,
    expectedLatencyMs: 100,
    confidence: 0.5,
    route: `${symbol} fallback`,
  };
}

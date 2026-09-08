import Decimal from 'decimal.js';
import config from '../shared/config';
import logger from '../shared/logger';
import { MarketData } from '../shared/types';
import { buildExecutionPlan, ExecutionPlan } from '../shared/executionPlanner';
import { selectBestVenue } from './venueRouter';
import { mempoolWatcher } from './mempoolWatcher';
import { DexSwapPlan, VenueSelection } from './types';
import { getTokenMapping } from '../agents/clawbot/sources/tokenMapping';

export interface HybridExecutionPlan {
  venue: 'cex' | 'dex';
  cexPlan?: ExecutionPlan;
  dexPlan?: DexSwapPlan;
  venueSelection: VenueSelection;
  mempoolSignal: import('./mempoolWatcher').MempoolSignal;
}

const USDT_ADDRESS: `0x${string}` = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

/**
 * Build a hybrid CeFi / DeFi execution plan.
 *
 * 1. Scans the mempool for toxic flow (stub if no infra configured).
 * 2. Quotes CeFi (Binance) and DEX (1inch) venues.
 * 3. Picks the venue with the lowest all-in cost + latency score.
 * 4. Returns a CEX plan via the existing execution planner, or a DEX swap plan.
 *
 * DEX is only enabled when DEX_ENABLED=true and a private key is configured.
 */
export async function buildHybridExecutionPlan(
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: Decimal,
  targetPrice: Decimal,
  marketData: MarketData,
  opts: {
    style?: import('../shared/executionPlanner').ExecutionStyle;
  } = {}
): Promise<HybridExecutionPlan> {
  logger.info('HybridExecutionPlanner building plan', { symbol, side, quantity: quantity.toFixed(6) });

  const mempoolSignal = await mempoolWatcher.scan(symbol);
  const notional = quantity.times(targetPrice);
  const dexSide = side === 'LONG' ? 'buy' : 'sell';

  const venueSelection = await selectBestVenue(symbol, dexSide, notional, targetPrice);

  if (venueSelection.selectedVenue === 'dex' && config.dexEnabled) {
    const dexPlan = buildDexSwapPlan(symbol, side, quantity, targetPrice);
    if (dexPlan) {
      return {
        venue: 'dex',
        dexPlan,
        venueSelection,
        mempoolSignal,
      };
    }
    logger.warn('DEX venue selected but DEX swap plan could not be built; falling back to CeFi');
  }

  const cexPlan = buildExecutionPlan(side, quantity, targetPrice, marketData, {
    style: opts.style ?? 'patient',
  });

  return {
    venue: 'cex',
    cexPlan,
    venueSelection,
    mempoolSignal,
  };
}

function buildDexSwapPlan(
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: Decimal,
  targetPrice: Decimal
): DexSwapPlan | undefined {
  const mapping = getTokenMapping(symbol);
  if (!mapping || mapping.chainId !== 1) return undefined;

  const fromToken = side === 'LONG' ? USDT_ADDRESS : mapping.address;
  const toToken = side === 'LONG' ? mapping.address : USDT_ADDRESS;
  const fromDecimals = side === 'LONG' ? 6 : mapping.decimals;
  const toDecimals = side === 'LONG' ? mapping.decimals : 6;

  const amountIn = BigInt(quantity.times(10 ** fromDecimals).toFixed(0));
  const amountOut = BigInt(quantity.times(targetPrice).times(10 ** toDecimals).toFixed(0));
  const minAmountOut = (amountOut * 99n) / 100n; // 1% slippage tolerance

  return {
    chainId: mapping.chainId,
    fromToken,
    toToken,
    amountIn,
    minAmountOut,
    recipient: '0x0000000000000000000000000000000000000000', // populated at execution time from wallet
    expectedGas: 200000n,
    gasPrice: 20n * 10n ** 9n, // 20 gwei placeholder
    deadline: Math.floor(Date.now() / 1000) + 300,
  };
}

import Decimal from 'decimal.js';
import { evmClient } from '../agents/clawbot/sources/evmClient';
import { binanceClient } from '../shared/binance';
import logger from '../shared/logger';

const DEFAULT_GAS_UNITS = 200000n;

/**
 * Estimate the USD cost of an Ethereum mainnet transaction.
 *
 * Uses live gas price from the configured RPC and the live ETH/USDT price
 * from Binance. Returns a high placeholder if any data source fails so that
 * the venue router falls back to CeFi safely.
 */
export async function estimateEthGasCostUsd(
  gasUnits = DEFAULT_GAS_UNITS
): Promise<Decimal> {
  try {
    const client = evmClient.getClient(1);
    if (!client) return new Decimal(50);

    const [gasPrice, ethTicker] = await Promise.all([
      client.getGasPrice(),
      binanceClient.getTicker24h('ETHUSDT').catch(() => undefined),
    ]);

    const ethPrice = ethTicker?.lastPrice?.toNumber() ?? 2500;
    const gasCostEth = Number(gasUnits * gasPrice) / 1e18;
    const gasCostUsd = gasCostEth * ethPrice;

    return new Decimal(gasCostUsd);
  } catch (err) {
    logger.warn('Gas cost estimation failed; using conservative fallback', {
      err: (err as Error).message,
    });
    return new Decimal(50); // conservative fallback
  }
}

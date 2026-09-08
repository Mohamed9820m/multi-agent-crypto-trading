import axios from 'axios';
import config from '../../../shared/config';
import logger from '../../../shared/logger';

export interface CoinGlassMetrics {
  symbol: string;
  fundingRate?: number; // latest avg funding rate
  openInterestUsd?: number;
  liquidationLongUsd24h?: number;
  liquidationShortUsd24h?: number;
  fundingHeatmap?: { exchange: string; rate: number }[];
}

export async function fetchCoinGlassMetrics(symbol: string): Promise<CoinGlassMetrics | undefined> {
  if (!config.coinglassApiKey) return undefined;

  const base = 'https://api.coinglass.com/api';
  const headers = { coinglassSecret: config.coinglassApiKey };
  const asset = symbol.replace(/USDT|BUSD|USDC$/, '').toUpperCase();

  try {
    const [fundingRes, oiRes, liqRes] = await Promise.allSettled([
      axios.get(`${base}/futures/fundingRate?symbol=${asset}&timeType=2`, { headers, timeout: 10000 }),
      axios.get(`${base}/futures/openInterest?symbol=${asset}&interval=1h`, { headers, timeout: 10000 }),
      axios.get(`${base}/futures/liquidationOrder?symbol=${asset}&timeType=2`, { headers, timeout: 10000 }),
    ]);

    const fundingRate =
      fundingRes.status === 'fulfilled'
        ? extractLatestFunding(fundingRes.value.data)
        : undefined;

    const openInterestUsd =
      oiRes.status === 'fulfilled'
        ? extractLatestOi(oiRes.value.data)
        : undefined;

    const { long, short } =
      liqRes.status === 'fulfilled'
        ? extractLiquidations(liqRes.value.data)
        : { long: undefined, short: undefined };

    return {
      symbol,
      fundingRate,
      openInterestUsd,
      liquidationLongUsd24h: long,
      liquidationShortUsd24h: short,
    };
  } catch (err) {
    logger.warn('CoinGlass fetch failed', { symbol, err: (err as Error).message });
    return undefined;
  }
}

function extractLatestFunding(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { data?: { dateList?: number[]; dataList?: { exchangeName: string; fundingRate?: number[] }[] } };
  // Try to grab the most recent funding rate from the first exchange series
  const series = d.data?.dataList?.[0]?.fundingRate;
  if (series && series.length > 0) return series[series.length - 1];
  return undefined;
}

function extractLatestOi(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { data?: { dateList?: number[]; dataList?: { exchangeName: string; openInterest?: number[] }[] } };
  const series = d.data?.dataList?.[0]?.openInterest;
  if (series && series.length > 0) {
    const latest = series[series.length - 1];
    return typeof latest === 'number' ? latest : undefined;
  }
  return undefined;
}

function extractLiquidations(data: unknown): { long?: number; short?: number } {
  if (!data || typeof data !== 'object') return {};
  const d = data as {
    data?: { buyList?: number[]; sellList?: number[] };
  };
  const buy = d.data?.buyList;
  const sell = d.data?.sellList;
  return {
    long: buy && buy.length > 0 ? buy.reduce((a, b) => a + b, 0) : undefined,
    short: sell && sell.length > 0 ? sell.reduce((a, b) => a + b, 0) : undefined,
  };
}

import axios from 'axios';
import config from '../../../shared/config';
import logger from '../../../shared/logger';

export interface BubbleMapsClustering {
  address: string;
  decentralizationScore: number; // 0-100, higher = more distributed
  clusterCount: number;
  topHolderPercent: number;
  warnings: string[];
}

/**
 * Fetch BubbleMaps holder clustering analysis.
 * Requires BUBBLEMAPS_API_KEY. Falls back to unavailable if missing/failing.
 */
export async function fetchBubbleMaps(address: string): Promise<BubbleMapsClustering | undefined> {
  if (!config.bubblemapsApiKey) return undefined;

  try {
    const { data } = await axios.get(
      `https://api.bubblemaps.io/api/v1/token?chain=eth&token=${address.toLowerCase()}`,
      {
        headers: { Authorization: `Bearer ${config.bubblemapsApiKey}` },
        timeout: 10000,
      }
    );

    const d = data as {
      decentralizationScore?: number;
      clusters?: unknown[];
      topHolders?: { percent?: number }[];
      warnings?: string[];
    };

    const topPct = d.topHolders?.[0]?.percent ?? 0;
    const warnings = Array.isArray(d.warnings) ? d.warnings : [];
    if (topPct > 50) warnings.push(`Top holder controls ${topPct.toFixed(1)}% of supply`);

    return {
      address,
      decentralizationScore: d.decentralizationScore ?? 0,
      clusterCount: Array.isArray(d.clusters) ? d.clusters.length : 0,
      topHolderPercent: topPct,
      warnings,
    };
  } catch (err) {
    logger.warn('BubbleMaps fetch failed', { address, err: (err as Error).message });
    return undefined;
  }
}

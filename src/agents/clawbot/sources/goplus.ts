import axios from 'axios';
import config from '../../../shared/config';
import logger from '../../../shared/logger';
import { isWhitelistedAsset } from './tokenMapping';

export interface GoPlusTokenSecurity {
  contractAddress: string;
  isOpenSource: boolean;
  isHoneypot: boolean;
  isMintable: boolean;
  isOwnerRenounced: boolean;
  buyTax: string;
  sellTax: string;
  cannotBuy: boolean;
  cannotSellAll: boolean;
  isAntiWhale: boolean;
  isAntiWhaleModifiable: boolean;
  isBlacklisted: boolean;
  isWhitelisted: boolean;
  holderCount?: number;
  lpHolderCount?: number;
  dexLiquidityUsd: number;
  top10HolderPercent: number;
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  warnings: string[];
}

/**
 * Fetch GoPlus token security summary.
 * GoPlus does not strictly require an API key for low-volume usage.
 */
export async function fetchGoPlusSecurity(
  chainId: number,
  contractAddress: string
): Promise<GoPlusTokenSecurity | undefined> {
  if (!config.goplusEnabled) return undefined;

  if (isWhitelistedAsset(contractAddress)) {
    return {
      contractAddress,
      isOpenSource: true,
      isHoneypot: false,
      isMintable: true, // major wrapped assets are mintable by design
      isOwnerRenounced: false,
      buyTax: '0',
      sellTax: '0',
      cannotBuy: false,
      cannotSellAll: false,
      isAntiWhale: false,
      isAntiWhaleModifiable: false,
      isBlacklisted: false,
      isWhitelisted: false,
      dexLiquidityUsd: 0,
      top10HolderPercent: 0,
      riskLevel: 'low',
      warnings: [],
    };
  }

  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${contractAddress.toLowerCase()}`;
    const { data } = await axios.get(url, { timeout: 15000 });

    const result = data?.result?.[contractAddress.toLowerCase()];
    if (!result) return undefined;

    const warnings: string[] = [];
    if (result.is_honeypot === '1') warnings.push('Honeypot detected');
    if (result.cannot_buy === '1') warnings.push('Buying disabled');
    if (result.cannot_sell_all === '1') warnings.push('Cannot sell entire balance');
    if (result.is_mintable === '1') warnings.push('Token is mintable');
    if (parseFloat(result.buy_tax || '0') > 0.05) warnings.push(`High buy tax ${result.buy_tax}`);
    if (parseFloat(result.sell_tax || '0') > 0.05) warnings.push(`High sell tax ${result.sell_tax}`);
    if (result.is_blacklisted === '1') warnings.push('Blacklist function present');
    if (result.is_anti_whale_modifiable === '1') warnings.push('Anti-whale rules modifiable');

    const top10Pct = parseFloat(result.holder_count ? result.top10_holder_percent : '0') || 0;
    const lpHolders = Number(result.lp_holder_count || '0');
    const holders = Number(result.holder_count || '0');

    // Estimate total DEX liquidity across pools
    let dexLiquidityUsd = 0;
    const dexes = result.dex || [];
    for (const d of dexes) {
      dexLiquidityUsd += parseFloat(d.liquidity || '0');
    }

    let riskLevel: GoPlusTokenSecurity['riskLevel'] = 'low';
    if (warnings.length >= 3 || result.is_honeypot === '1') riskLevel = 'high';
    else if (warnings.length >= 1 || top10Pct > 0.5) riskLevel = 'medium';

    return {
      contractAddress,
      isOpenSource: result.is_open_source === '1',
      isHoneypot: result.is_honeypot === '1',
      isMintable: result.is_mintable === '1',
      isOwnerRenounced: result.can_take_back_ownership !== '1' && result.owner_address === '0x0000000000000000000000000000000000000000',
      buyTax: result.buy_tax || '0',
      sellTax: result.sell_tax || '0',
      cannotBuy: result.cannot_buy === '1',
      cannotSellAll: result.cannot_sell_all === '1',
      isAntiWhale: result.is_anti_whale === '1',
      isAntiWhaleModifiable: result.is_anti_whale_modifiable === '1',
      isBlacklisted: result.is_blacklisted === '1',
      isWhitelisted: result.is_whitelisted === '1',
      holderCount: holders || undefined,
      lpHolderCount: lpHolders || undefined,
      dexLiquidityUsd,
      top10HolderPercent: top10Pct,
      riskLevel,
      warnings,
    };
  } catch (err) {
    logger.warn('GoPlus security fetch failed', { chainId, contractAddress, err: (err as Error).message });
    return undefined;
  }
}

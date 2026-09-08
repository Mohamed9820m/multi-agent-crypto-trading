import { Address } from 'viem';
import evmClient from './evmClient';
import { fetchGoPlusSecurity, GoPlusTokenSecurity } from './goplus';
import logger from '../../../shared/logger';

export interface OnChainEnrichment {
  wrappedAsset: string;
  contractAddress: string;
  chainId: number;
  tokenInfo?: {
    name?: string;
    symbol?: string;
    decimals?: number;
    totalSupply?: string;
    owner?: string;
    hasOwnerAbi: boolean;
  };
  transferSummary?: {
    count24h: number;
    volume24h: string;
    uniqueSenders: number;
    uniqueReceivers: number;
  };
  goPlus?: GoPlusTokenSecurity;
}

export async function enrichOnChain(
  symbol: string,
  mapping: { chainId: number; address: Address; decimals: number; wrappedAsset: string }
): Promise<OnChainEnrichment | undefined> {
  logger.info('CLAWBOT enriching on-chain data', { symbol, wrappedAsset: mapping.wrappedAsset });

  const [tokenInfo, transferSummary, goPlus] = await Promise.all([
    evmClient.getTokenInfo(mapping.chainId, mapping.address),
    evmClient.getRecentTransferSummary(mapping.chainId, mapping.address, 7200).catch(() => undefined),
    fetchGoPlusSecurity(mapping.chainId, mapping.address),
  ]);

  return {
    wrappedAsset: mapping.wrappedAsset,
    contractAddress: mapping.address,
    chainId: mapping.chainId,
    tokenInfo: tokenInfo
      ? {
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          decimals: tokenInfo.decimals,
          totalSupply: tokenInfo.totalSupply?.toString(),
          owner: tokenInfo.owner,
          hasOwnerAbi: tokenInfo.hasOwnerAbi,
        }
      : undefined,
    transferSummary: transferSummary
      ? {
          count24h: transferSummary.count24h,
          volume24h: transferSummary.volume24h.toString(),
          uniqueSenders: transferSummary.uniqueSenders,
          uniqueReceivers: transferSummary.uniqueReceivers,
        }
      : undefined,
    goPlus,
  };
}

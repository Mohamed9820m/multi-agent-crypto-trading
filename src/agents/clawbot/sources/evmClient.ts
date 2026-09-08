import { createPublicClient, http, parseAbi, type PublicClient, type Address, type Chain } from 'viem';
import { mainnet, bsc } from 'viem/chains';
import config from '../../../shared/config';
import logger from '../../../shared/logger';

const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  56: bsc,
};

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export interface EvmTokenInfo {
  chainId: number;
  address: Address;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  owner?: Address;
  hasOwnerAbi: boolean;
}

export interface TransferEventSummary {
  count24h: number;
  volume24h: bigint;
  uniqueSenders: number;
  uniqueReceivers: number;
}

export class EvmClient {
  private clients = new Map<number, PublicClient>();

  getClient(chainId: number): PublicClient | undefined {
    if (this.clients.has(chainId)) return this.clients.get(chainId)!;

    const chain = CHAIN_MAP[chainId];
    if (!chain) {
      logger.warn('EVM chain not supported', { chainId });
      return undefined;
    }

    const client = createPublicClient({
      chain,
      transport: http(config.ethRpcUrl),
    }) as PublicClient;

    this.clients.set(chainId, client);
    return client;
  }

  async getTokenInfo(chainId: number, address: Address): Promise<EvmTokenInfo | undefined> {
    const client = this.getClient(chainId);
    if (!client) return undefined;

    try {
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        client.readContract({ address, abi: ERC20_ABI, functionName: 'name' }).catch(() => undefined),
        client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => undefined),
        client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => undefined),
        client.readContract({ address, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => undefined),
      ]);

      let owner: Address | undefined;
      let hasOwnerAbi = false;
      try {
        owner = await client.readContract({ address, abi: ERC20_ABI, functionName: 'owner' });
        hasOwnerAbi = true;
      } catch {
        hasOwnerAbi = false;
      }

      return {
        chainId,
        address,
        name: name ?? undefined,
        symbol: symbol ?? undefined,
        decimals: decimals ?? undefined,
        totalSupply: totalSupply ?? undefined,
        owner: owner ?? undefined,
        hasOwnerAbi,
      };
    } catch (err) {
      logger.warn('EVM token info fetch failed', { chainId, address, err: (err as Error).message });
      return undefined;
    }
  }

  async getRecentTransferSummary(
    chainId: number,
    address: Address,
    blocksBack = 7200 // ~24h on Ethereum mainnet
  ): Promise<TransferEventSummary | undefined> {
    const client = this.getClient(chainId);
    if (!client) return undefined;

    const tryFetch = async (window: number): Promise<TransferEventSummary> => {
      const latest = await client.getBlockNumber();
      const fromBlock = latest - BigInt(window);

      const logs = await client.getLogs({
        address,
        event: ERC20_ABI[6], // Transfer event
        fromBlock,
        toBlock: latest,
      });

      const senders = new Set<string>();
      const receivers = new Set<string>();
      let volume = 0n;

      for (const log of logs) {
        const args = log.args as { from: Address; to: Address; value: bigint };
        if (!args) continue;
        senders.add(args.from);
        receivers.add(args.to);
        volume += args.value;
      }

      return {
        count24h: logs.length,
        volume24h: volume,
        uniqueSenders: senders.size,
        uniqueReceivers: receivers.size,
      };
    };

    try {
      return await tryFetch(blocksBack);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.toLowerCase().includes('archive')) {
        logger.warn('EVM archive logs unavailable; falling back to recent non-archive window', {
          chainId,
          address,
        });
        try {
          return await tryFetch(128);
        } catch (err2) {
          logger.warn('EVM transfer log fallback failed', { chainId, address, err: (err2 as Error).message });
          return undefined;
        }
      }
      logger.warn('EVM transfer log fetch failed', { chainId, address, err: msg });
      return undefined;
    }
  }
}

export const evmClient = new EvmClient();
export default evmClient;

/**
 * Maps trading symbols to on-chain token representations.
 *
 * Used by CLAWBOT to fetch EVM security, holder, and event data for assets
 * that also trade on CEXs. If a symbol is not mapped, on-chain enrichment
 * is skipped for that cycle.
 */

export interface TokenMapping {
  chainId: number;
  address: `0x${string}`;
  decimals: number;
  wrappedAsset: string; // e.g. WBTC for BTCUSDT
}

export const TOKEN_ADDRESS_MAP: Record<string, TokenMapping> = {
  BTCUSDT: {
    chainId: 1,
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    decimals: 8,
    wrappedAsset: 'WBTC',
  },
  ETHUSDT: {
    chainId: 1,
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    decimals: 18,
    wrappedAsset: 'WETH',
  },
  BNBUSDT: {
    chainId: 56,
    address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    decimals: 18,
    wrappedAsset: 'WBNB',
  },
  SOLUSDT: {
    // Solana is non-EVM; placeholder for future Solana enrichment
    chainId: 0,
    address: '0x0000000000000000000000000000000000000000',
    decimals: 9,
    wrappedAsset: 'SOL',
  },
};

/**
 * Verified major wrapped / stable assets. These are treated as safe regardless
 * of GoPlus flags such as "mintable", because their central minting authority
 * is by design.
 */
export const SAFE_ASSETS_WHITELIST: `0x${string}`[] = [
  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
];

export function isWhitelistedAsset(address: string): boolean {
  return SAFE_ASSETS_WHITELIST.includes(address.toLowerCase() as `0x${string}`);
}

export function getTokenMapping(symbol: string): TokenMapping | undefined {
  return TOKEN_ADDRESS_MAP[symbol.toUpperCase()];
}

export function isEvmToken(symbol: string): boolean {
  const m = getTokenMapping(symbol);
  return !!m && m.chainId !== 0;
}

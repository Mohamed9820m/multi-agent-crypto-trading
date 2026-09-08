import Decimal from 'decimal.js';

export type VenueType = 'cex' | 'dex';

export interface VenueQuote {
  venue: VenueType;
  name: string;
  side: 'buy' | 'sell';
  expectedAmountOut: Decimal;
  expectedPrice: Decimal;
  expectedCostPct: number; // fees + spread + slippage + gas as % of notional
  expectedLatencyMs: number;
  confidence: number; // 0-1, how reliable the quote is
  route?: string;
  raw?: unknown;
}

export interface VenueSelection {
  selectedVenue: VenueType;
  winner: VenueQuote;
  alternatives: VenueQuote[];
  reasoning: string[];
}

export interface DexSwapPlan {
  chainId: number;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: `0x${string}`;
  routerAddress?: `0x${string}`;
  callData?: `0x${string}`;
  expectedGas: bigint;
  gasPrice: bigint;
  deadline: number;
}

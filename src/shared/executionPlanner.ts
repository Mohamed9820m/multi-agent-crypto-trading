import Decimal from 'decimal.js';
import { MarketData } from '../shared/types';

export type ExecutionStyle = 'patient' | 'urgent' | 'twap';

export interface ExecutionPlan {
  style: ExecutionStyle;
  orderType: 'LIMIT' | 'MARKET' | 'LIMIT_MAKER';
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  slices: { quantity: Decimal; price?: Decimal }[];
  expectedSlippagePct: number;
  expectedCostPct: number;
  reasoning: string[];
}

export function buildExecutionPlan(
  side: 'LONG' | 'SHORT',
  quantity: Decimal,
  targetPrice: Decimal,
  marketData: MarketData,
  opts: {
    style?: ExecutionStyle;
    makerFeePct?: number;
    takerFeePct?: number;
    twapSlices?: number;
    twapDurationMs?: number;
  } = {}
): ExecutionPlan {
  const style = opts.style ?? 'patient';
  const makerFeePct = opts.makerFeePct ?? 0.001;
  const takerFeePct = opts.takerFeePct ?? 0.001;

  const bestBid = marketData.orderBook.bids[0]?.price;
  const bestAsk = marketData.orderBook.asks[0]?.price;
  const spread = bestAsk && bestBid ? bestAsk.minus(bestBid) : new Decimal(0);
  const mid = bestAsk && bestBid ? bestBid.plus(bestAsk).div(2) : targetPrice;
  const spreadPct = mid.gt(0) ? spread.div(mid).toNumber() : 0;

  const reasoning: string[] = [];
  let orderType: ExecutionPlan['orderType'] = 'LIMIT';
  let timeInForce: ExecutionPlan['timeInForce'] = 'GTC';
  let slices: { quantity: Decimal; price?: Decimal }[] = [];
  let expectedSlippagePct = 0;

  // Estimate market impact based on depth within 0.1% of mid
  const depthSide = side === 'LONG' ? marketData.orderBook.asks : marketData.orderBook.bids;
  const depth0_1pct = depthSide
    .filter((l) => l.price.minus(mid).abs().div(mid).toNumber() < 0.001)
    .reduce((a, l) => a.plus(l.quantity), new Decimal(0));
  const marketImpactPct = depth0_1pct.gt(0) ? quantity.div(depth0_1pct).toNumber() * 0.0005 : 0.0005;

  if (style === 'urgent' || spreadPct > 0.0005) {
    orderType = 'MARKET';
    timeInForce = undefined;
    slices = [{ quantity, price: undefined }];
    expectedSlippagePct = spreadPct + marketImpactPct;
    reasoning.push(`Urgent execution or wide spread (${(spreadPct * 10000).toFixed(1)} bps); using MARKET`);
  } else if (style === 'twap') {
    const sliceCount = opts.twapSlices ?? 4;
    const sliceQty = quantity.div(sliceCount);
    orderType = 'LIMIT';
    timeInForce = 'GTC';
    for (let i = 0; i < sliceCount; i++) {
      slices.push({ quantity: sliceQty, price: targetPrice });
    }
    expectedSlippagePct = marketImpactPct / sliceCount + spreadPct / 2;
    reasoning.push(`TWAP execution: ${sliceCount} slices over ${opts.twapDurationMs ?? 60000}ms`);
  } else {
    // patient: post liquidity with LIMIT_MAKER if possible, else GTC limit
    orderType = 'LIMIT';
    timeInForce = 'GTC';
    const postPrice = side === 'LONG' ? bestBid : bestAsk;
    slices = [{ quantity, price: postPrice ?? targetPrice }];
    expectedSlippagePct = marketImpactPct;
    reasoning.push(`Patient limit order; posting at ${postPrice?.toFixed(2) ?? targetPrice.toFixed(2)}`);
  }

  const feePct = orderType === 'MARKET' ? takerFeePct : makerFeePct;
  const expectedCostPct = feePct * 2 + expectedSlippagePct * 2;

  return {
    style,
    orderType,
    timeInForce,
    slices,
    expectedSlippagePct,
    expectedCostPct,
    reasoning,
  };
}

export function computeImplementationShortfall(
  decisionPrice: Decimal,
  fillPrice: Decimal,
  side: 'LONG' | 'SHORT'
): Decimal {
  const raw = fillPrice.minus(decisionPrice);
  return side === 'LONG' ? raw : raw.negated();
}

export function computeSlippagePct(
  expectedPrice: Decimal,
  fillPrice: Decimal,
  side: 'LONG' | 'SHORT'
): number {
  const isf = computeImplementationShortfall(expectedPrice, fillPrice, side);
  return expectedPrice.gt(0) ? isf.div(expectedPrice).toNumber() : 0;
}

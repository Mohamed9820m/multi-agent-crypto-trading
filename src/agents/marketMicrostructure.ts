import Decimal from 'decimal.js';
import {
  Bias,
  Candle,
  LiquidityMetrics,
  MarketData,
  MicrostructureAnalysis,
  OrderBookImbalance,
  OrderFlowMetrics,
  VolumeDeltaMetrics,
} from '../shared/types';

function sumQty(levels: { price: Decimal; quantity: Decimal }[]): Decimal {
  return levels.reduce((acc, l) => acc.plus(l.quantity), new Decimal(0));
}

function sumQtyValue(levels: { price: Decimal; quantity: Decimal }[]): Decimal {
  return levels.reduce((acc, l) => acc.plus(l.price.times(l.quantity)), new Decimal(0));
}

export class MarketMicrostructureAgent {
  analyze(marketData: MarketData, recentCandles: Candle[]): MicrostructureAnalysis {
    const orderBook = this.analyzeOrderBook(marketData.orderBook);
    const volumeDelta = this.analyzeVolumeDelta(recentCandles);
    const liquidity = this.analyzeLiquidity(marketData.orderBook);

    // Aggregate bias from orderbook + delta
    let bullishPoints = 0;
    let bearishPoints = 0;

    if (orderBook.bidAskImbalance > 0.15) bullishPoints += 1;
    if (orderBook.bidAskImbalance < -0.15) bearishPoints += 1;
    if (liquidity.depthImbalance > 0.15) bullishPoints += 1;
    if (liquidity.depthImbalance < -0.15) bearishPoints += 1;
    if (volumeDelta.volumeDelta.gt(0)) bullishPoints += 1;
    if (volumeDelta.volumeDelta.lt(0)) bearishPoints += 1;

    let bias: Bias = 'neutral';
    if (bullishPoints > bearishPoints + 1) bias = 'bullish';
    else if (bearishPoints > bullishPoints + 1) bias = 'bearish';

    const confidence = Math.min(0.9, Math.abs(orderBook.bidAskImbalance) * 0.5 + Math.abs(liquidity.depthImbalance) * 0.3);

    return {
      orderBook,
      volumeDelta,
      orderFlow: this.estimateOrderFlow(orderBook, volumeDelta),
      liquidity,
      timestamp: Date.now(),
      bias,
      confidence,
    };
  }

  private analyzeOrderBook(orderBook: MarketData['orderBook']): OrderBookImbalance {
    const bids = orderBook.bids.slice(0, 5);
    const asks = orderBook.asks.slice(0, 5);

    const bestBid = bids[0]?.price ?? new Decimal(0);
    const bestAsk = asks[0]?.price ?? new Decimal(0);
    const spread = bestAsk.minus(bestBid);
    const spreadPct = bestAsk.gt(0) ? spread.div(bestAsk).toNumber() : 0;

    const bidVol = sumQty(bids);
    const askVol = sumQty(asks);
    const totalVol = bidVol.plus(askVol);
    const bidAskImbalance = totalVol.eq(0) ? 0 : bidVol.minus(askVol).div(totalVol).toNumber();

    const bidDepth5 = sumQtyValue(bids);
    const askDepth5 = sumQtyValue(asks);
    const totalDepth = bidDepth5.plus(askDepth5);
    const depthImbalance = totalDepth.eq(0) ? 0 : bidDepth5.minus(askDepth5).div(totalDepth).toNumber();

    const weightedMidPrice = totalVol.eq(0)
      ? null
      : sumQtyValue(bids).plus(sumQtyValue(asks)).div(totalVol);

    return {
      bidAskImbalance,
      depthImbalance,
      bestBid,
      bestAsk,
      spread,
      spreadPct,
      weightedMidPrice,
      bidDepth5,
      askDepth5,
    };
  }

  private analyzeVolumeDelta(candles: Candle[]): VolumeDeltaMetrics {
    let buyVolume = new Decimal(0);
    let sellVolume = new Decimal(0);
    const deltaPerPeriod: Decimal[] = [];

    for (const c of candles) {
      // Heuristic: if close in upper half of candle, treat volume as buyer-led; else seller-led.
      const range = c.high.minus(c.low);
      const position = range.eq(0) ? new Decimal(0.5) : c.close.minus(c.low).div(range);
      const periodBuy = c.volume.times(position);
      const periodSell = c.volume.times(new Decimal(1).minus(position));
      buyVolume = buyVolume.plus(periodBuy);
      sellVolume = sellVolume.plus(periodSell);
      deltaPerPeriod.push(periodBuy.minus(periodSell));
    }

    return {
      volumeDelta: buyVolume.minus(sellVolume),
      cumulativeDelta: buyVolume.minus(sellVolume),
      buyVolume,
      sellVolume,
      deltaPerPeriod,
    };
  }

  private analyzeLiquidity(orderBook: MarketData['orderBook']): LiquidityMetrics {
    const bids = orderBook.bids.slice(0, 5);
    const asks = orderBook.asks.slice(0, 5);
    const bidDepth5 = sumQtyValue(bids);
    const askDepth5 = sumQtyValue(asks);
    const totalDepth5 = bidDepth5.plus(askDepth5);
    const depthImbalance = totalDepth5.eq(0) ? 0 : bidDepth5.minus(askDepth5).div(totalDepth5).toNumber();

    const bestBid = bids[0]?.price ?? new Decimal(0);
    const bestAsk = asks[0]?.price ?? new Decimal(0);
    const spread = bestAsk.minus(bestBid);
    const spreadPct = bestAsk.gt(0) ? spread.div(bestAsk).toNumber() : 1;

    // Simple liquidity score: deeper and tighter = higher. Normalize loosely around 50.
    const depthScore = Math.min(50, totalDepth5.div(100000).toNumber());
    const spreadScore = Math.max(0, 50 - spreadPct * 10000);
    const liquidityScore = Math.min(100, depthScore + spreadScore + 25 - Math.abs(depthImbalance) * 15);

    let gapRisk: 'low' | 'medium' | 'high' = 'low';
    if (spreadPct > 0.001) gapRisk = 'medium';
    if (spreadPct > 0.003 || liquidityScore < 30) gapRisk = 'high';

    return {
      bidDepth5,
      askDepth5,
      totalDepth5,
      depthImbalance,
      liquidityScore,
      gapRisk,
    };
  }

  private estimateOrderFlow(
    orderBook: OrderBookImbalance,
    volumeDelta: VolumeDeltaMetrics
  ): OrderFlowMetrics {
    const orderFlowImbalance = orderBook.depthImbalance * 0.7 + orderBook.bidAskImbalance * 0.3;
    const totalVolume = volumeDelta.buyVolume.plus(volumeDelta.sellVolume);
    const tradeAggressorImbalance = volumeDelta.volumeDelta
      .div(Decimal.max(totalVolume, new Decimal(1)))
      .toNumber();

    // Simple heuristic absorption/sweep scores based on imbalance extremes and volume
    const absImbalance = Math.abs(orderFlowImbalance);
    const absorptionScore = Math.min(100, absImbalance * 100 + 10);
    const sweepScore = Math.min(100, absImbalance * 120 + Math.abs(tradeAggressorImbalance) * 30);
    const replenishmentScore = Math.max(0, 50 - absImbalance * 50);

    return {
      orderFlowImbalance,
      tradeAggressorImbalance,
      absorptionScore,
      sweepScore,
      replenishmentScore,
    };
  }
}

export const marketMicrostructureAgent = new MarketMicrostructureAgent();
export default marketMicrostructureAgent;

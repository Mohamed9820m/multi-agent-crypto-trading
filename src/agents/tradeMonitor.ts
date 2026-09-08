import Decimal from 'decimal.js';
import { MarketRegime, Position, TradeMonitorUpdate } from '../shared/types';

export class TradeMonitorAgent {
  monitor(
    position: Position,
    currentPrice: Decimal,
    regime: MarketRegime = 'UNCERTAIN',
    fundingPaid: Decimal = new Decimal(0)
  ): TradeMonitorUpdate {
    const unrealizedPnlPct = position.side === 'LONG'
      ? currentPrice.minus(position.entryPrice).div(position.entryPrice).toNumber()
      : position.entryPrice.minus(currentPrice).div(position.entryPrice).toNumber();

    const unrealizedPnlEUR = position.entryPrice
      .times(position.quantity)
      .times(unrealizedPnlPct);

    const distanceToStopPct = position.stopLoss
      ? position.side === 'LONG'
        ? currentPrice.minus(position.stopLoss).div(position.entryPrice).toNumber()
        : position.stopLoss.minus(currentPrice).div(position.entryPrice).toNumber()
      : 0;

    const distanceToTargetPct = position.takeProfit
      ? position.side === 'LONG'
        ? position.takeProfit.minus(currentPrice).div(position.entryPrice).toNumber()
        : currentPrice.minus(position.takeProfit).div(position.entryPrice).toNumber()
      : null;

    // Thesis validity: simple distance-based check
    let thesisValid = true;
    if (distanceToStopPct < 0) thesisValid = false;

    let recommendedAction: TradeMonitorUpdate['recommendedAction'] = 'hold';
    if (!thesisValid) {
      recommendedAction = 'exit';
    } else if (distanceToTargetPct !== null && distanceToTargetPct <= 0) {
      recommendedAction = 'take_partial';
    } else if (regime === 'PANIC' || regime === 'EUPHORIA') {
      recommendedAction = 'reduce';
    }

    return {
      positionId: position.positionId,
      currentPrice,
      unrealizedPnlPct,
      unrealizedPnlEUR,
      distanceToStopPct,
      distanceToTargetPct,
      slippage: 0,
      fundingPaid,
      liquidationDistance: undefined,
      regime,
      thesisValid,
      recommendedAction,
    };
  }
}

export const tradeMonitorAgent = new TradeMonitorAgent();
export default tradeMonitorAgent;

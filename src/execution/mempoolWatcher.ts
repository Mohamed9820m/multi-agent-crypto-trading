import logger from '../shared/logger';

export interface MempoolSignal {
  detected: boolean;
  type?: 'front_run' | 'back_run' | 'sandwich' | 'arbitrage' | 'none';
  confidence: number;
  notes: string[];
}

/**
 * Mempool watcher stub for the hybrid execution engine.
 *
 * Real mempool interception requires infrastructure such as Flashbots
 * mev-share, bloXroute BDN, or Jito block-engine gRPC streams. This module
 * provides the interface and a safe fallback so the router can be wired up
 * without needing that infrastructure in testnet/paper mode.
 */
export class MempoolWatcher {
  async scan(symbol: string): Promise<MempoolSignal> {
    logger.debug('MempoolWatcher scan', { symbol });
    return {
      detected: false,
      type: 'none',
      confidence: 0,
      notes: ['Mempool interception not active (Flashbots/bloXroute/Jito not configured)'],
    };
  }
}

export const mempoolWatcher = new MempoolWatcher();
export default mempoolWatcher;

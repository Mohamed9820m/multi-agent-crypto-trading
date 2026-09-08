import logger from '../shared/logger';

export interface LatencySample {
  venue: string;
  operation: string;
  durationMs: number;
  timestamp: number;
  success: boolean;
}

/**
 * Lightweight latency monitor for execution venues.
 *
 * Tracks round-trip times for venue operations and surfaces a smoothed
 * estimate for routing decisions. This is the first building block of the
 * hybrid CeFi/DeFi execution engine.
 */
export class LatencyMonitor {
  private samples: LatencySample[] = [];
  private readonly maxSamples = 100;

  record(sample: LatencySample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  async measure<T>(
    venue: string,
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.record({ venue, operation, durationMs: Date.now() - start, timestamp: start, success: true });
      return result;
    } catch (err) {
      this.record({ venue, operation, durationMs: Date.now() - start, timestamp: start, success: false });
      throw err;
    }
  }

  averageLatencyMs(venue: string, operation?: string): number | null {
    const filtered = this.samples.filter(
      (s) => s.venue === venue && (operation ? s.operation === operation : true) && s.success
    );
    if (filtered.length === 0) return null;
    return filtered.reduce((a, s) => a + s.durationMs, 0) / filtered.length;
  }

  report(): Record<string, number | null> {
    const venues = Array.from(new Set(this.samples.map((s) => s.venue)));
    const report: Record<string, number | null> = {};
    for (const venue of venues) {
      report[venue] = this.averageLatencyMs(venue);
      logger.debug('Latency monitor report', { venue, avgMs: report[venue] });
    }
    return report;
  }
}

export const latencyMonitor = new LatencyMonitor();
export default latencyMonitor;

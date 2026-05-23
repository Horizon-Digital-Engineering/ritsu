import type { Request, Response } from 'express';

/**
 * Tiny in-process counter store. Process-wide singleton. No labels to keep
 * this dependency-free; if we ever need real labels, swap to prom-client.
 *
 * Counters are append-only ints. The /metrics endpoint serializes them in
 * Prometheus exposition format so any standard scraper can consume.
 */
class MetricsRegistry {
  private readonly counters = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Returns Prometheus text exposition. */
  serialize(extra: Record<string, number> = {}): string {
    const mem = process.memoryUsage();
    const out: string[] = [];

    out.push('# HELP ritsu_process_rss_bytes Resident set size of the node process.');
    out.push('# TYPE ritsu_process_rss_bytes gauge');
    out.push(`ritsu_process_rss_bytes ${mem.rss}`);

    out.push('# HELP ritsu_process_heap_used_bytes V8 heap used.');
    out.push('# TYPE ritsu_process_heap_used_bytes gauge');
    out.push(`ritsu_process_heap_used_bytes ${mem.heapUsed}`);

    out.push('# HELP ritsu_process_heap_total_bytes V8 heap total.');
    out.push('# TYPE ritsu_process_heap_total_bytes gauge');
    out.push(`ritsu_process_heap_total_bytes ${mem.heapTotal}`);

    out.push('# HELP ritsu_process_uptime_seconds Seconds since process start.');
    out.push('# TYPE ritsu_process_uptime_seconds counter');
    out.push(`ritsu_process_uptime_seconds ${Math.round(process.uptime())}`);

    for (const [name, value] of Object.entries(extra)) {
      out.push(`# TYPE ${name} gauge`);
      out.push(`${name} ${value}`);
    }

    for (const [name, value] of this.counters) {
      out.push(`# TYPE ${name} counter`);
      out.push(`${name} ${value}`);
    }

    return out.join('\n') + '\n';
  }
}

export const metrics = new MetricsRegistry();

export function metricsHandler(gauges: () => Record<string, number>) {
  return (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.serialize(gauges()));
  };
}

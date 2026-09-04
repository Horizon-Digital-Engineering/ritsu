/**
 * Fixed-window per-IP token bucket, shared by every rate-limited mount
 * (admin API, /mcp, /oauth/register, the OAuth dance).
 *
 * The buckets are swept. A plain Map keyed on source address reclaims an
 * expired entry only if that same address comes back, so a scan across a /16
 * leaves 65k entries resident forever — worst on the DCR limiter, whose
 * window is an hour. Sweeping is opportunistic rather than on a timer: no
 * interval to keep the event loop alive, and the cost lands on the request
 * that grew the map past the threshold.
 */
const SWEEP_THRESHOLD = 1024;

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly windowMs: number, private readonly max: number) {}

  /** Count one request. Returns null when allowed, or the Retry-After seconds. */
  hit(ip: string, now = Date.now()): number | null {
    const bucket = this.buckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
      if (this.buckets.size >= SWEEP_THRESHOLD) this.sweep(now);
      this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs });
      return null;
    }
    bucket.count++;
    if (bucket.count > this.max) return Math.ceil((bucket.resetAt - now) / 1000);
    return null;
  }

  /** Live entry count. Tests assert the sweep actually reclaims. */
  get size(): number { return this.buckets.size; }

  private sweep(now: number): void {
    for (const [ip, b] of this.buckets) {
      if (b.resetAt < now) this.buckets.delete(ip);
    }
  }
}

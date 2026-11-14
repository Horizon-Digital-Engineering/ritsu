/**
 * Runs `fn` over `items` with at most `limit` in flight. Results land by input
 * index, so callers that care about order get it for free whatever finishes
 * first. `until()` is consulted before each pick-up: once it returns true no new
 * item starts, in-flight ones finish, and never-started slots stay undefined.
 */
export function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
export function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, until: () => boolean): Promise<(R | undefined)[]>;
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  until: () => boolean = () => false,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    // The pull loop is the pool: each worker waits on one item at a time by design.
    while (next < items.length && !until()) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

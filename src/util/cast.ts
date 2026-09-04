/**
 * Type-narrowing coercions for `unknown`-typed inputs.
 *
 * `String(x ?? '')` is the obvious shape and works at runtime for strings,
 * numbers, booleans — but on objects it returns "[object Object]", which
 * is almost never what a tool handler or admin endpoint wants. The
 * type-checker rule `@typescript-eslint/no-base-to-string` flags this
 * exact pattern. These helpers do the explicit narrow.
 */

/** Coerce an unknown to a string. Returns `fallback` when the value isn't
 *  already a string — number/boolean/object get the fallback rather than
 *  a JS-default stringification. */
export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Coerce an unknown to a finite number, or null. Tool arguments arrive as
 *  parsed JSON, so a provider can send a string where the schema said integer;
 *  numeric strings are accepted, everything else is null. */
export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

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

/** Like `asString` but only accepts non-empty strings. Use when the caller
 *  treats `''` as "missing" anyway — saves the `.trim() === ''` check. */
export function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

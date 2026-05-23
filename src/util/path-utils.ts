/**
 * Tiny string helpers — kept regex-free on purpose so static analyzers can
 * prove linear-time behavior without needing to reason about the regex
 * engine's backtracking.
 */

/**
 * Strip every trailing `/` from a string. Equivalent to `.replace(/\/+$/, '')`
 * but written as an explicit O(n) scan so SonarQube's ReDoS rule (S5852) has
 * nothing to flag and so a code reviewer can trivially see this can't
 * pathologically backtrack on a large input.
 *
 * Defensive type-guard: this function is called with HTTP query/body
 * parameters in several places, and Express turns `?foo=a&foo=b` into
 * an array under the hood. If `s` arrives as an array (or anything
 * non-string), `s.length` would still work but `s.codePointAt` would
 * return `undefined`, so the loop short-circuits and the array is
 * returned unchanged — silently bypassing the trim that the caller
 * expected to have happened. CodeQL flags this as
 * `js/type-confusion-through-parameter-tampering`. Reject the
 * non-string case at the boundary so the caller gets a loud error
 * instead of a misleading-shape return.
 */
export function stripTrailingSlashes(s: string): string {
  if (typeof s !== 'string') {
    throw new TypeError(`stripTrailingSlashes: expected string, got ${Array.isArray(s) ? 'array' : typeof s}`);
  }
  let end = s.length;
  while (end > 0 && s.codePointAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}

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
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}

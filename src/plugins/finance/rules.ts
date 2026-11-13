/**
 * Operator rules over incoming transactions: match on payee/description text
 * and amount, then set category, payee, tags or exclusion. Plain substring
 * matching only — a rule is typed by hand, and a regex engine here would be
 * one more thing to get wrong against attacker-shaped bank descriptions.
 */
import type { Rule, Transaction } from './store.js';

export interface RuleEffect { category_id?: string | null; payee?: string; excluded?: boolean; tags?: string[] }

function textMatches(rule: Rule, t: Transaction): boolean {
  const hay = rule.field === 'payee' ? [t.payee] : rule.field === 'description' ? [t.description] : [t.payee, t.description];
  const needle = rule.pattern.toLowerCase();
  return hay.some(h => {
    const s = h.toLowerCase();
    if (rule.op === 'equals') return s === needle;
    if (rule.op === 'starts_with') return s.startsWith(needle);
    return s.includes(needle);
  });
}

export function ruleMatches(rule: Rule, t: Transaction): boolean {
  if (!rule.enabled) return false;
  if (rule.account_id && rule.account_id !== t.account_id) return false;
  const abs = Math.abs(t.amount);
  if (rule.amount_min != null && abs < rule.amount_min) return false;
  if (rule.amount_max != null && abs > rule.amount_max) return false;
  return textMatches(rule, t);
}

/** First matching rule by priority wins for each field it sets. */
export function applyRules(rules: Rule[], t: Transaction): RuleEffect | null {
  const effect: RuleEffect = {};
  let hit = false;
  for (const r of rules) {
    if (!ruleMatches(r, t)) continue;
    hit = true;
    if (r.set_category_id && effect.category_id === undefined) effect.category_id = r.set_category_id;
    if (r.set_payee && effect.payee === undefined) effect.payee = r.set_payee;
    if (r.set_excluded != null && effect.excluded === undefined) effect.excluded = r.set_excluded;
    if (r.set_tags.length) effect.tags = [...new Set([...(effect.tags ?? []), ...r.set_tags])];
  }
  return hit ? effect : null;
}

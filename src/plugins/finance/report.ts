/**
 * Reporting over the synced finance cache. Pure functions on plain arrays so
 * they're deterministic + unit-testable — the date-dependent windowing ("this
 * month", "last 90 days") is the caller's job (it passes filtered rows / month
 * keys). Spend = positive amount (Plaid convention); income = negative.
 */
import type { Account, Transaction, CategoryTarget } from './store.js';

// Plaid account types: depository (checking/savings), investment/brokerage,
// credit (card), loan. Credit + loan balances are amounts OWED → liabilities.
const LIABILITY_TYPES = new Set(['credit', 'loan']);

export interface NetWorth {
  assets: number;
  liabilities: number;
  net: number;
  byType: Array<{ type: string; total: number; accounts: number }>;
  currency: string;
}

export function netWorth(accounts: Account[]): NetWorth {
  let assets = 0;
  let liabilities = 0;
  let currency = 'USD';
  const byType = new Map<string, { total: number; accounts: number }>();
  for (const a of accounts) {
    const bal = a.current_balance ?? 0;
    if (a.iso_currency) currency = a.iso_currency;
    const g = byType.get(a.type) ?? { total: 0, accounts: 0 };
    g.total += bal;
    g.accounts += 1;
    byType.set(a.type, g);
    if (LIABILITY_TYPES.has(a.type)) liabilities += bal;
    else assets += bal;
  }
  return {
    assets, liabilities, net: assets - liabilities, currency,
    byType: [...byType.entries()].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.total - a.total),
  };
}

export interface CategorySpend { category: string; total: number; count: number }

export function spendByCategory(txns: Transaction[]): CategorySpend[] {
  const m = new Map<string, { total: number; count: number }>();
  for (const t of txns) {
    if (t.amount <= 0) continue;
    const cat = t.category || 'Uncategorized';
    const g = m.get(cat) ?? { total: 0, count: 0 };
    g.total += t.amount; g.count += 1;
    m.set(cat, g);
  }
  return [...m.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.total - a.total);
}

export function spendByMonth(txns: Transaction[]): Array<{ month: string; total: number }> {
  const m = new Map<string, number>();
  for (const t of txns) {
    if (t.amount <= 0) continue;
    const mo = t.date.slice(0, 7);
    m.set(mo, (m.get(mo) ?? 0) + t.amount);
  }
  return [...m.entries()].map(([month, total]) => ({ month, total })).sort((a, b) => (a.month < b.month ? 1 : -1));
}

export function topMerchants(txns: Transaction[], n = 10): Array<{ merchant: string; total: number; count: number }> {
  const m = new Map<string, { total: number; count: number }>();
  for (const t of txns) {
    if (t.amount <= 0) continue;
    const name = t.merchant_name || t.name || 'Unknown';
    const g = m.get(name) ?? { total: 0, count: 0 };
    g.total += t.amount; g.count += 1;
    m.set(name, g);
  }
  return [...m.entries()].map(([merchant, v]) => ({ merchant, ...v })).sort((a, b) => b.total - a.total).slice(0, n);
}

/** Keep only transactions in the given YYYY-MM month. */
export function inMonth(txns: Transaction[], month: string): Transaction[] {
  return txns.filter(t => t.date.slice(0, 7) === month);
}

export interface Subscription { merchant: string; avgAmount: number; occurrences: number; lastDate: string; cadence: string }

/**
 * Heuristic recurring-charge detection over the passed window: a merchant that
 * charges ≥2 times with roughly-consistent amounts and a regular cadence
 * (weekly / biweekly / monthly / yearly). A stand-in until Plaid's recurring
 * endpoint is wired — deliberately conservative to avoid false "subscriptions".
 */
export function detectSubscriptions(txns: Transaction[]): Subscription[] {
  const byMerchant = new Map<string, Transaction[]>();
  for (const t of txns) {
    if (t.amount <= 0) continue;
    const key = (t.merchant_name || t.name || '').trim().toLowerCase();
    if (!key) continue;
    const arr = byMerchant.get(key);
    if (arr) arr.push(t); else byMerchant.set(key, [t]);
  }
  const subs: Subscription[] = [];
  for (const list of byMerchant.values()) {
    if (list.length < 2) continue;
    const amounts = list.map(t => t.amount);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    if (!amounts.every(a => Math.abs(a - avg) <= Math.max(1, avg * 0.25))) continue;
    const dates = list.map(t => t.date).sort();
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push(dayGap(dates[i - 1], dates[i]));
    const cadence = classifyCadence(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    if (cadence === 'irregular') continue;
    subs.push({
      merchant: list[0].merchant_name || list[0].name,
      avgAmount: avg, occurrences: list.length, lastDate: dates[dates.length - 1], cadence,
    });
  }
  return subs.sort((a, b) => b.avgAmount - a.avgAmount);
}

export interface BudgetLine { category: string; spent: number; limit: number; remaining: number; over: boolean }

/** Overlay per-category monthly targets on this month's spend. `monthSpend`
 *  should already be scoped to the month being judged. */
export function budgetStatus(monthSpend: CategorySpend[], targets: CategoryTarget[]): BudgetLine[] {
  const spent = new Map(monthSpend.map(s => [s.category, s.total]));
  return targets
    .map(t => {
      const s = spent.get(t.category) ?? 0;
      return { category: t.category, spent: s, limit: t.monthly_limit, remaining: t.monthly_limit - s, over: s > t.monthly_limit };
    })
    .sort((a, b) => (b.spent - b.limit) - (a.spent - a.limit));
}

// ---- date helpers (YYYY-MM-DD strings) ------------------------------------
function dayGap(a: string, b: string): number {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86_400_000;
}

function classifyCadence(avgDays: number): 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'irregular' {
  const near = (target: number, tol: number) => Math.abs(avgDays - target) <= tol;
  if (near(7, 2)) return 'weekly';
  if (near(14, 3)) return 'biweekly';
  if (near(30, 6)) return 'monthly';
  if (near(365, 30)) return 'yearly';
  return 'irregular';
}

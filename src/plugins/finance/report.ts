/**
 * Reporting over the ledger. Pure functions on plain arrays so they're
 * deterministic and unit-testable; the store does the windowing. Sign
 * convention: inflow positive, outflow negative, liability balances negative.
 */
import type { Account, Transaction, Split, Category, Budget, Recurring, Goal } from './store.js';
import { LIABILITY_TYPES } from './store.js';
import { UNCATEGORIZED } from './categories.js';

export interface NetWorth {
  net: number; assets: number; liabilities: number; currency: string;
  byType: Array<{ type: string; total: number; accounts: number }>;
}

export function netWorth(accounts: Account[]): NetWorth {
  let assets = 0, liabilities = 0, currency = 'USD';
  const byType = new Map<string, { total: number; accounts: number }>();
  for (const a of accounts) {
    if (a.hidden || a.closed) continue;
    if (a.currency) currency = a.currency;
    const g = byType.get(a.type) ?? { total: 0, accounts: 0 };
    g.total += a.balance; g.accounts += 1;
    byType.set(a.type, g);
    if (LIABILITY_TYPES.has(a.type)) liabilities += -a.balance; else assets += a.balance;
  }
  return {
    net: assets - liabilities, assets, liabilities, currency,
    byType: [...byType.entries()].map(([type, v]) => ({ type, ...v })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
  };
}

export interface NetWorthPoint { date: string; net: number; assets: number; liabilities: number }

/**
 * Daily net worth from balance snapshots, carrying each account's last known
 * balance forward. `seed` is each account's last balance before `from`, so a
 * window that starts after an account was created still counts it.
 */
export function netWorthSeries(
  history: Array<{ account_id: string; date: string; balance: number }>,
  seed: Array<{ account_id: string; date: string; balance: number }>,
  accounts: Account[],
  from: string,
  to: string,
): NetWorthPoint[] {
  const types = new Map(accounts.filter(a => !a.hidden).map(a => [a.id, a.type]));
  const current = new Map<string, number>();
  for (const s of seed) if (types.has(s.account_id)) current.set(s.account_id, s.balance);
  const byDate = snapshotsByDate(history, types);
  const out: NetWorthPoint[] = [];
  const dates = [...new Set([from, ...byDate.keys(), to])].filter(d => d >= from && d <= to).sort((a, b) => a.localeCompare(b));
  for (const d of dates) {
    for (const h of byDate.get(d) ?? []) current.set(h.account_id, h.balance);
    // Before the first snapshot there is nothing to plot; a zero there would read as a crash.
    if (current.size === 0) continue;
    out.push({ date: d, ...splitBalances(current, types) });
  }
  return out;
}

function snapshotsByDate(history: Array<{ account_id: string; date: string; balance: number }>, types: Map<string, string>): Map<string, Array<{ account_id: string; balance: number }>> {
  const byDate = new Map<string, Array<{ account_id: string; balance: number }>>();
  for (const h of history) {
    if (!types.has(h.account_id)) continue;
    const arr = byDate.get(h.date); if (arr) arr.push(h); else byDate.set(h.date, [h]);
  }
  return byDate;
}

function splitBalances(current: Map<string, number>, types: Map<string, string>): { net: number; assets: number; liabilities: number } {
  let assets = 0, liabilities = 0;
  for (const [id, bal] of current) {
    if (LIABILITY_TYPES.has(types.get(id) ?? '')) liabilities += -bal; else assets += bal;
  }
  return { net: assets - liabilities, assets, liabilities };
}

/** One categorized amount. A split transaction contributes its splits, not its own category. */
export interface Line { date: string; category_id: string; amount: number; payee: string; account_id: string; transaction_id: string }

export function expandLines(txns: Transaction[], splits: Map<string, Split[]>): Line[] {
  const out: Line[] = [];
  for (const t of txns) {
    const s = splits.get(t.id);
    if (s?.length) {
      for (const x of s) out.push({ date: t.date, category_id: x.category_id ?? UNCATEGORIZED, amount: x.amount, payee: t.payee, account_id: t.account_id, transaction_id: t.id });
    } else {
      out.push({ date: t.date, category_id: t.category_id ?? UNCATEGORIZED, amount: t.amount, payee: t.payee, account_id: t.account_id, transaction_id: t.id });
    }
  }
  return out;
}

const kindOf = (cats: Map<string, Category>, id: string) => cats.get(id)?.kind ?? 'expense';

export interface CashFlowMonth { month: string; income: number; expenses: number; net: number; savings_rate: number | null }

/** Per-month income vs spend; transfers are skipped regardless of sign. */
export function cashFlow(lines: Line[], categories: Category[], months: string[]): CashFlowMonth[] {
  const cats = new Map(categories.map(c => [c.id, c]));
  const m = new Map(months.map(mo => [mo, { income: 0, expenses: 0 }]));
  for (const l of lines) {
    const mo = l.date.slice(0, 7);
    const g = m.get(mo); if (!g) continue;
    if (kindOf(cats, l.category_id) === 'transfer') continue;
    if (l.amount > 0) g.income += l.amount; else g.expenses += -l.amount;
  }
  return months.map(month => {
    const g = m.get(month)!;
    const net = g.income - g.expenses;
    return { month, income: g.income, expenses: g.expenses, net, savings_rate: g.income > 0 ? net / g.income : null };
  });
}

export interface CategorySpend { category_id: string; name: string; group: string; total: number; count: number }

/** Outflows by category (or by group with `byGroup`), largest first. */
export function spendByCategory(lines: Line[], categories: Category[], byGroup = false): CategorySpend[] {
  const cats = new Map(categories.map(c => [c.id, c]));
  const m = new Map<string, CategorySpend>();
  for (const l of lines) {
    if (l.amount >= 0) continue;
    const c = cats.get(l.category_id);
    if (c?.kind === 'transfer') continue;
    const key = byGroup ? (c?.group_name || 'Other') : l.category_id;
    const g = m.get(key) ?? { category_id: byGroup ? '' : l.category_id, name: byGroup ? key : (c?.name ?? l.category_id), group: c?.group_name ?? '', total: 0, count: 0 };
    g.total += -l.amount; g.count += 1;
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

export function spendByPayee(lines: Line[], categories: Category[], n = 15): Array<{ payee: string; total: number; count: number }> {
  const cats = new Map(categories.map(c => [c.id, c]));
  const m = new Map<string, { total: number; count: number }>();
  for (const l of lines) {
    if (l.amount >= 0 || kindOf(cats, l.category_id) === 'transfer') continue;
    const key = l.payee || 'Unknown';
    const g = m.get(key) ?? { total: 0, count: 0 };
    g.total += -l.amount; g.count += 1;
    m.set(key, g);
  }
  return [...m.entries()].map(([payee, v]) => ({ payee, ...v })).sort((a, b) => b.total - a.total).slice(0, n);
}

export function incomeBySource(lines: Line[], categories: Category[]): Array<{ payee: string; total: number; count: number }> {
  const cats = new Map(categories.map(c => [c.id, c]));
  const m = new Map<string, { total: number; count: number }>();
  for (const l of lines) {
    if (l.amount <= 0 || kindOf(cats, l.category_id) === 'transfer') continue;
    const key = l.payee || 'Unknown';
    const g = m.get(key) ?? { total: 0, count: 0 };
    g.total += l.amount; g.count += 1;
    m.set(key, g);
  }
  return [...m.entries()].map(([payee, v]) => ({ payee, ...v })).sort((a, b) => b.total - a.total);
}

/** Monthly totals for one category (or group) across `months`. */
export function categoryTrend(lines: Line[], categories: Category[], months: string[], categoryId?: string, group?: string): Array<{ month: string; total: number }> {
  const cats = new Map(categories.map(c => [c.id, c]));
  const m = new Map(months.map(mo => [mo, 0]));
  for (const l of lines) {
    const mo = l.date.slice(0, 7);
    if (!m.has(mo)) continue;
    const c = cats.get(l.category_id);
    if (categoryId && l.category_id !== categoryId) continue;
    if (group && (c?.group_name ?? '') !== group) continue;
    if (c?.kind === 'income') m.set(mo, m.get(mo)! + l.amount);
    else if (l.amount < 0) m.set(mo, m.get(mo)! + -l.amount);
  }
  return months.map(month => ({ month, total: m.get(month)! }));
}

export interface BudgetLine { category_id: string; name: string; group: string; kind: string; budget: number; actual: number; remaining: number; over: boolean; source: 'month' | 'default' }
export interface BudgetReport {
  month: string; lines: BudgetLine[];
  totals: { budgeted_expenses: number; actual_expenses: number; budgeted_income: number; actual_income: number; unbudgeted_expenses: number };
}

type BudgetChoice = { amount: number; source: 'month' | 'default' };

/** Signed actuals per category: income positive, spend positive, transfers skipped. */
function actualsByCategory(monthLines: Line[], cats: Map<string, Category>): Map<string, number> {
  const actual = new Map<string, number>();
  for (const l of monthLines) {
    const c = cats.get(l.category_id);
    if (c?.kind === 'transfer') continue;
    const v = c?.kind === 'income' ? l.amount : -l.amount;
    actual.set(l.category_id, (actual.get(l.category_id) ?? 0) + v);
  }
  return actual;
}

/** A per-month amount wins over the default ('*'). */
function chosenBudgets(budgets: Budget[], month: string): Map<string, BudgetChoice> {
  const chosen = new Map<string, BudgetChoice>();
  for (const b of budgets) {
    if (b.month === month) chosen.set(b.category_id, { amount: b.amount, source: 'month' });
    else if (b.month === '*' && !chosen.has(b.category_id)) chosen.set(b.category_id, { amount: b.amount, source: 'default' });
  }
  return chosen;
}

/** Income lines first; within a kind, the most over budget first. */
function budgetLineOrder(a: BudgetLine, b: BudgetLine): number {
  if (a.kind === b.kind) return (b.actual - b.budget) - (a.actual - a.budget);
  return a.kind === 'income' ? -1 : 1;
}

/** The month's actuals against its budget: a per-month amount wins over the default ('*'). */
export function budgetReport(monthLines: Line[], categories: Category[], budgets: Budget[], month: string): BudgetReport {
  const cats = new Map(categories.map(c => [c.id, c]));
  const actual = actualsByCategory(monthLines, cats);
  const chosen = chosenBudgets(budgets, month);
  const lines: BudgetLine[] = [];
  const totals = { budgeted_expenses: 0, actual_expenses: 0, budgeted_income: 0, actual_income: 0, unbudgeted_expenses: 0 };
  for (const [id, b] of chosen) {
    const c = cats.get(id);
    const kind = c?.kind ?? 'expense';
    const a = actual.get(id) ?? 0;
    lines.push({ category_id: id, name: c?.name ?? id, group: c?.group_name ?? '', kind, budget: b.amount, actual: a, remaining: b.amount - a, over: kind === 'expense' && a > b.amount, source: b.source });
    if (kind === 'income') { totals.budgeted_income += b.amount; totals.actual_income += a; }
    else { totals.budgeted_expenses += b.amount; totals.actual_expenses += a; }
  }
  for (const [id, a] of actual) {
    if (chosen.has(id)) continue;
    const kind = cats.get(id)?.kind ?? 'expense';
    if (kind === 'income') totals.actual_income += a;
    else { totals.actual_expenses += a; totals.unbudgeted_expenses += a; }
  }
  lines.sort(budgetLineOrder);
  return { month, lines, totals };
}

/** Confirmed and detected recurring items due within the horizon, soonest first. */
export function upcomingRecurring(items: Recurring[], today: string, horizonDays = 30): Array<Recurring & { days_until: number }> {
  const end = addDays(today, horizonDays);
  return items
    .filter(r => r.status !== 'dismissed' && r.next_date && r.next_date <= end)
    .map(r => ({ ...r, days_until: Math.round((Date.parse(r.next_date) - Date.parse(today)) / 86_400_000) }))
    .sort((a, b) => a.next_date.localeCompare(b.next_date));
}

export interface GoalProgress { goal: Goal; current: number; progress: number; remaining: number; on_track: boolean | null; monthly_needed: number | null }

export function goalProgress(goal: Goal, accounts: Account[], today: string): GoalProgress {
  const linked = accounts.filter(a => goal.account_ids.includes(a.id));
  const sum = linked.reduce((s, a) => s + a.balance, 0);
  // A payoff goal measures debt retired since it was set; a savings goal measures the balance itself.
  const current = goal.kind === 'payoff' ? Math.max(0, (goal.start_balance ?? sum) - sum) * -1 + 0 : sum;
  const cur = goal.kind === 'payoff' ? Math.abs((goal.start_balance ?? sum) - sum) : current;
  const progress = goal.target_amount > 0 ? Math.min(1, Math.max(0, cur / goal.target_amount)) : 0;
  const remaining = Math.max(0, goal.target_amount - cur);
  let monthly_needed: number | null = null, on_track: boolean | null = null;
  if (goal.target_date) {
    const months = Math.max(0.5, (Date.parse(goal.target_date) - Date.parse(today)) / (30.44 * 86_400_000));
    monthly_needed = remaining / months;
    const elapsed = (Date.parse(today) - goal.created_at * 1000) / (30.44 * 86_400_000);
    const totalMonths = (Date.parse(goal.target_date) - goal.created_at * 1000) / (30.44 * 86_400_000);
    on_track = totalMonths <= 0 ? remaining === 0 : progress >= Math.min(1, elapsed / totalMonths) - 0.02;
  }
  return { goal, current: cur, progress, remaining, on_track, monthly_needed };
}

// ---- date helpers (YYYY-MM-DD) ----------------------------------------------
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
}
export function monthKey(date: string | Date): string {
  return (typeof date === 'string' ? date : date.toISOString()).slice(0, 7);
}
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
/** The last `n` months ending at `month`, oldest first. */
export function lastMonths(month: string, n: number): string[] {
  const [y, m] = month.split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

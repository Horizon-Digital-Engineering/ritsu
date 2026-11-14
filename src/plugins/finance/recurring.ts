/**
 * Recurring-charge detection over the ledger: a payee charging at a steady
 * cadence with steady amounts. Conservative on purpose — a false "subscription"
 * costs trust faster than a missed one. Proposals land as `detected`; the
 * operator confirms or dismisses, and either sticks across re-detection.
 */
import type { Transaction } from './store.js';
import { addDays } from './report.js';

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, yearly: 365 };

export interface DetectedRecurring {
  payee_key: string; display_name: string; category_id: string | null; account_id: string;
  amount: number; cadence: Cadence; last_date: string; next_date: string; occurrences: number;
}

/** Normalize a payee so "NETFLIX.COM 866-579-7172" and "Netflix" collapse. */
export function payeeKey(s: string): string {
  return s.toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\.(com|net|org|io|co|us)\b/g, ' ')
    .split(/\s+/).filter(tok => !/\d/.test(tok)).join(' ')
    .replace(/[^a-z& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}

function classify(avgGap: number): Cadence | null {
  const near = (target: number, tol: number) => Math.abs(avgGap - target) <= tol;
  if (near(7, 1.5)) return 'weekly';
  if (near(14, 2.5)) return 'biweekly';
  if (near(30.4, 4)) return 'monthly';
  if (near(91, 10)) return 'quarterly';
  if (near(365, 20)) return 'yearly';
  return null;
}

function steadyAmounts(amounts: number[]): boolean {
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  return amounts.every(a => Math.abs(a - avg) <= Math.max(2, Math.abs(avg) * 0.2));
}

/** Outflows per account+payee; pending rows and transfers never count. */
function groupByPayee(txns: Transaction[]): Map<string, Transaction[]> {
  const groups = new Map<string, Transaction[]>();
  for (const t of txns) {
    if (t.amount >= 0 || t.pending || t.transfer_group) continue;
    const key = payeeKey(t.payee || t.description);
    if (key.length < 3) continue;
    const k = `${t.account_id}|${key}`;
    const arr = groups.get(k); if (arr) arr.push(t); else groups.set(k, [t]);
  }
  return groups;
}

/** Date-ordered occurrences; same-day duplicates (a retry, a split charge) are one. */
function occurrences(list: Transaction[]): Transaction[] {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.filter((t, i) => i === 0 || t.date !== sorted[i - 1].date);
}

function cadenceOf(dedup: Transaction[]): Cadence | null {
  const gaps: number[] = [];
  for (let i = 1; i < dedup.length; i++) gaps.push((Date.parse(dedup[i].date) - Date.parse(dedup[i - 1].date)) / 86_400_000);
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const cadence = classify(avgGap);
  if (!cadence) return null;
  // Two data points only prove a yearly/quarterly pattern; shorter cadences need three.
  if ((cadence === 'weekly' || cadence === 'biweekly') && dedup.length < 3) return null;
  const steady = gaps.every(g => Math.abs(g - avgGap) <= Math.max(3, avgGap * 0.25));
  return steady ? cadence : null;
}

function isStale(lastDate: string, cadence: Cadence, today: string): boolean {
  return (Date.parse(today) - Date.parse(lastDate)) / 86_400_000 > CADENCE_DAYS[cadence] * 2 + 7;
}

function nextDue(lastDate: string, cadence: Cadence, today: string): string {
  let next = addDays(lastDate, CADENCE_DAYS[cadence]);
  while (next < today) next = addDays(next, CADENCE_DAYS[cadence]);
  return next;
}

function proposal(key: string, list: Transaction[], today: string): DetectedRecurring | null {
  if (list.length < 2) return null;
  const dedup = occurrences(list);
  if (dedup.length < 2) return null;
  const cadence = cadenceOf(dedup);
  if (!cadence) return null;
  const amounts = dedup.map(t => t.amount);
  if (!steadyAmounts(amounts)) return null;
  const last = dedup.at(-1)!;
  if (isStale(last.date, cadence, today)) return null;
  return {
    payee_key: key.split('|')[1], display_name: last.payee || last.description, category_id: last.category_id,
    account_id: last.account_id, amount: amounts.reduce((a, b) => a + b, 0) / amounts.length, cadence,
    last_date: last.date, next_date: nextDue(last.date, cadence, today), occurrences: dedup.length,
  };
}

/** `txns` should span at least ~13 months for yearly items to show. */
export function detectRecurring(txns: Transaction[], today: string): DetectedRecurring[] {
  const out: DetectedRecurring[] = [];
  for (const [k, list] of groupByPayee(txns)) {
    const p = proposal(k, list, today);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.amount - b.amount);
}

export function nextAfter(date: string, cadence: string): string {
  const days = CADENCE_DAYS[cadence as Cadence] ?? 30;
  return addDays(date, days);
}

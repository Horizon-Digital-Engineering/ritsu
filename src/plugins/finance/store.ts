/**
 * Data access over the finance ledger (plugin_finance_*). Sign convention:
 * inflow positive, outflow negative; a liability account's balance is
 * negative. Provider credentials never live in these tables.
 */
import { randomBytes } from 'node:crypto';
import type { PluginDb } from '../types.js';
import { UNCATEGORIZED } from './categories.js';

export type AccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'property' | 'other';
export const LIABILITY_TYPES = new Set<string>(['credit', 'loan']);

export interface Connection {
  id: string; provider: string; label: string; status: string; error: string | null;
  cursor: string | null; last_synced_at: number | null; created_at: number; updated_at: number;
}

export interface Account {
  id: string; connection_id: string | null; provider_account_id: string; name: string; official_name: string;
  type: string; subtype: string; mask: string; institution: string; balance: number; available_balance: number | null;
  currency: string; balance_as_of: string; hidden: boolean; closed: boolean; sort_order: number;
  created_at: number; updated_at: number;
}

export interface Transaction {
  id: string; account_id: string; date: string; description: string; payee: string; amount: number; currency: string;
  category_id: string | null; category_source: string; provider_category: string; pending: boolean; notes: string;
  reviewed: boolean; excluded: boolean; transfer_group: string | null; source: string;
  created_at: number; updated_at: number;
  tags: string[];
}

export interface Split { id: number; transaction_id: string; category_id: string | null; amount: number; notes: string }
export interface Category { id: string; name: string; group_name: string; kind: string; sort: number; archived: boolean; builtin: boolean }
export interface Rule {
  id: number; priority: number; enabled: boolean; field: string; op: string; pattern: string;
  amount_min: number | null; amount_max: number | null; account_id: string | null;
  set_category_id: string | null; set_payee: string | null; set_excluded: boolean | null; set_tags: string[]; created_at: number;
}
export interface Budget { category_id: string; month: string; amount: number }
export interface Recurring {
  id: number; payee_key: string; display_name: string; category_id: string | null; account_id: string | null;
  amount: number; cadence: string; last_date: string; next_date: string; status: string; occurrences: number;
  created_at: number; updated_at: number;
}
export interface Goal {
  id: number; name: string; kind: string; target_amount: number; target_date: string | null;
  account_ids: string[]; start_balance: number | null; created_at: number;
}
export interface Holding {
  id: string; account_id: string; symbol: string; description: string; quantity: number | null; price: number | null;
  market_value: number | null; cost_basis: number | null; currency: string; as_of: string; updated_at: number;
}

export interface TransactionFilter {
  from?: string; to?: string; account_id?: string; category_id?: string; q?: string;
  uncategorized?: boolean; unreviewed?: boolean; include_excluded?: boolean; include_pending?: boolean;
  limit?: number; offset?: number;
}

type Row = Record<string, unknown>;
const bool = (v: unknown) => v === 1 || v === true;

const toAccount = (r: Row): Account => ({ ...(r as unknown as Account), hidden: bool(r.hidden), closed: bool(r.closed) });
const toTxn = (r: Row): Transaction => ({
  ...(r as unknown as Transaction), pending: bool(r.pending), reviewed: bool(r.reviewed), excluded: bool(r.excluded), tags: [],
});
const toCategory = (r: Row): Category => ({ ...(r as unknown as Category), archived: bool(r.archived), builtin: bool(r.builtin) });
const toRule = (r: Row): Rule => ({
  ...(r as unknown as Rule), enabled: bool(r.enabled),
  set_excluded: r.set_excluded == null ? null : bool(r.set_excluded),
  set_tags: JSON.parse(typeof r.set_tags === 'string' ? r.set_tags : '[]') as string[],
});
/** SQLite has no nullable boolean; a rule's set_excluded is 1/0/NULL. */
const tri = (v: boolean | null | undefined): 0 | 1 | null => {
  if (v == null) return null;
  return v ? 1 : 0;
};
type RulePatch = Partial<Omit<Rule, 'id' | 'created_at'>>;
const RULE_COLUMNS: Array<keyof RulePatch> = ['priority', 'enabled', 'field', 'op', 'pattern', 'amount_min', 'amount_max', 'account_id', 'set_category_id', 'set_payee', 'set_excluded', 'set_tags'];
const ruleCell = (col: keyof RulePatch, v: RulePatch[keyof RulePatch]): unknown => {
  switch (col) {
    case 'enabled': return v ? 1 : 0;
    case 'set_excluded': return tri(v as boolean | null);
    case 'set_tags': return JSON.stringify(v);
    default: return v;
  }
};
const toGoal = (r: Row): Goal => ({ ...(r as unknown as Goal), account_ids: JSON.parse(typeof r.account_ids === 'string' ? r.account_ids : '[]') as string[] });

export class FinanceStore {
  private inTx = false;
  constructor(private readonly db: PluginDb) {}
  private t(name: string): string { return this.db.table(name); }
  /** Re-entrant: a store method that opens a transaction can be called from inside one. */
  transaction<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    try { return this.db.transaction(fn)(); }
    finally { this.inTx = false; }
  }

  // ---- connections -------------------------------------------------------
  upsertConnection(c: { id: string; provider: string; label?: string }): void {
    this.db.prepare(
      `INSERT INTO ${this.t('connections')} (id, provider, label) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END, updated_at = strftime('%s','now')`,
    ).run(c.id, c.provider, c.label ?? '');
  }
  listConnections(): Connection[] {
    return this.db.prepare(`SELECT * FROM ${this.t('connections')} ORDER BY label COLLATE NOCASE`).all() as unknown as Connection[];
  }
  getConnection(id: string): Connection | null {
    return (this.db.prepare(`SELECT * FROM ${this.t('connections')} WHERE id = ?`).get(id) as Connection | undefined) ?? null;
  }
  setCursor(id: string, cursor: string): void {
    this.db.prepare(`UPDATE ${this.t('connections')} SET cursor = ?, updated_at = strftime('%s','now') WHERE id = ?`).run(cursor, id);
  }
  setConnectionStatus(id: string, status: string, error: string | null = null): void {
    this.db.prepare(
      `UPDATE ${this.t('connections')} SET status = ?, error = ?, last_synced_at = CASE WHEN ? = 'active' THEN strftime('%s','now') ELSE last_synced_at END, updated_at = strftime('%s','now') WHERE id = ?`,
    ).run(status, error, status, id);
  }
  deleteConnection(id: string): void {
    this.transaction(() => {
      const accts = (this.db.prepare(`SELECT id FROM ${this.t('accounts')} WHERE connection_id = ?`).all(id) as Array<{ id: string }>).map(a => a.id);
      for (const a of accts) this.deleteAccount(a);
      this.db.prepare(`DELETE FROM ${this.t('connections')} WHERE id = ?`).run(id);
    });
  }
  lastSyncedAt(): number | null {
    const r = this.db.prepare(`SELECT MAX(last_synced_at) AS m FROM ${this.t('connections')}`).get() as { m: number | null } | undefined;
    return r?.m ?? null;
  }

  // ---- accounts ----------------------------------------------------------
  upsertAccount(a: {
    id: string; connection_id: string | null; provider_account_id?: string; name: string; official_name?: string;
    type: string; subtype?: string; mask?: string; institution?: string; balance: number; available_balance?: number | null;
    currency?: string; balance_as_of: string;
  }): void {
    this.db.prepare(
      `INSERT INTO ${this.t('accounts')}
         (id, connection_id, provider_account_id, name, official_name, type, subtype, mask, institution, balance, available_balance, currency, balance_as_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         connection_id = excluded.connection_id, provider_account_id = excluded.provider_account_id,
         official_name = excluded.official_name, subtype = excluded.subtype, mask = excluded.mask,
         institution = CASE WHEN excluded.institution = '' THEN institution ELSE excluded.institution END,
         balance = excluded.balance, available_balance = excluded.available_balance, currency = excluded.currency,
         balance_as_of = excluded.balance_as_of, updated_at = strftime('%s','now')`,
    ).run(a.id, a.connection_id, a.provider_account_id ?? '', a.name, a.official_name ?? '', a.type, a.subtype ?? '', a.mask ?? '',
      a.institution ?? '', a.balance, a.available_balance ?? null, a.currency ?? 'USD', a.balance_as_of);
    this.recordBalance(a.id, a.balance_as_of, a.balance);
  }
  /** Operator edits: the provider never overrides these fields on sync. */
  updateAccount(id: string, patch: { name?: string; type?: string; hidden?: boolean; closed?: boolean; sort_order?: number; institution?: string }): boolean {
    const sets: string[] = []; const vals: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (patch.type !== undefined) { sets.push('type = ?'); vals.push(patch.type); }
    if (patch.institution !== undefined) { sets.push('institution = ?'); vals.push(patch.institution); }
    if (patch.hidden !== undefined) { sets.push('hidden = ?'); vals.push(patch.hidden ? 1 : 0); }
    if (patch.closed !== undefined) { sets.push('closed = ?'); vals.push(patch.closed ? 1 : 0); }
    if (patch.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(patch.sort_order); }
    if (!sets.length) return false;
    sets.push(`updated_at = strftime('%s','now')`);
    return this.db.prepare(`UPDATE ${this.t('accounts')} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id).changes > 0;
  }
  setBalance(id: string, balance: number, asOf: string): boolean {
    const ch = this.db.prepare(`UPDATE ${this.t('accounts')} SET balance = ?, balance_as_of = ?, updated_at = strftime('%s','now') WHERE id = ?`).run(balance, asOf, id).changes;
    if (ch > 0) this.recordBalance(id, asOf, balance);
    return ch > 0;
  }
  recordBalance(accountId: string, date: string, balance: number): void {
    this.db.prepare(`INSERT INTO ${this.t('balance_history')} (account_id, date, balance) VALUES (?, ?, ?) ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance`).run(accountId, date, balance);
  }
  listAccounts(includeHidden = true): Account[] {
    const where = includeHidden ? '' : ' WHERE hidden = 0';
    return (this.db.prepare(`SELECT * FROM ${this.t('accounts')}${where} ORDER BY sort_order, type, name COLLATE NOCASE`).all() as Row[]).map(toAccount);
  }
  getAccount(id: string): Account | null {
    const r = this.db.prepare(`SELECT * FROM ${this.t('accounts')} WHERE id = ?`).get(id) as Row | undefined;
    return r ? toAccount(r) : null;
  }
  deleteAccount(id: string): boolean {
    return this.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.t('splits')} WHERE transaction_id IN (SELECT id FROM ${this.t('transactions')} WHERE account_id = ?)`).run(id);
      this.db.prepare(`DELETE FROM ${this.t('transaction_tags')} WHERE transaction_id IN (SELECT id FROM ${this.t('transactions')} WHERE account_id = ?)`).run(id);
      this.db.prepare(`DELETE FROM ${this.t('transactions')} WHERE account_id = ?`).run(id);
      this.db.prepare(`DELETE FROM ${this.t('balance_history')} WHERE account_id = ?`).run(id);
      this.db.prepare(`DELETE FROM ${this.t('holdings')} WHERE account_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM ${this.t('accounts')} WHERE id = ?`).run(id).changes > 0;
    });
  }
  balanceHistory(from: string, to: string): Array<{ account_id: string; date: string; balance: number }> {
    return this.db.prepare(`SELECT account_id, date, balance FROM ${this.t('balance_history')} WHERE date >= ? AND date <= ? ORDER BY date`).all(from, to) as Array<{ account_id: string; date: string; balance: number }>;
  }
  /** Last balance per account at or before `date`, for carrying history forward. */
  balancesBefore(date: string): Array<{ account_id: string; date: string; balance: number }> {
    return this.db.prepare(
      `SELECT account_id, date, balance FROM ${this.t('balance_history')} b
       WHERE date < ? AND date = (SELECT MAX(date) FROM ${this.t('balance_history')} WHERE account_id = b.account_id AND date < ?)`,
    ).all(date, date) as Array<{ account_id: string; date: string; balance: number }>;
  }

  // ---- transactions ------------------------------------------------------
  /** Sync upsert. Operator-owned fields (payee edits, category set by
   *  the operator or a rule, notes, flags) survive a re-sync. */
  upsertTransaction(t: {
    id: string; account_id: string; date: string; description: string; payee?: string; amount: number; currency?: string;
    category_id?: string | null; category_source?: string; provider_category?: string; pending?: boolean;
    source?: string;
  }): 'added' | 'updated' {
    const existing = this.db.prepare(`SELECT id FROM ${this.t('transactions')} WHERE id = ?`).get(t.id) as { id: string } | undefined;
    this.db.prepare(
      `INSERT INTO ${this.t('transactions')}
         (id, account_id, date, description, payee, amount, currency, category_id, category_source, provider_category, pending, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id, date = excluded.date, description = excluded.description,
         payee = CASE WHEN category_source = 'user' OR payee <> description THEN payee ELSE excluded.payee END,
         amount = excluded.amount, currency = excluded.currency,
         category_id = CASE WHEN category_source IN ('user','rule') THEN category_id ELSE excluded.category_id END,
         category_source = CASE WHEN category_source IN ('user','rule') THEN category_source ELSE excluded.category_source END,
         provider_category = excluded.provider_category, pending = excluded.pending,
         updated_at = strftime('%s','now')`,
    ).run(t.id, t.account_id, t.date, t.description, t.payee ?? t.description, t.amount, t.currency ?? 'USD',
      t.category_id ?? null, t.category_source ?? (t.category_id ? 'provider' : 'none'), t.provider_category ?? '',
      t.pending ? 1 : 0, t.source ?? 'sync');
    return existing ? 'updated' : 'added';
  }
  insertManualTransaction(t: { account_id: string; date: string; payee: string; amount: number; category_id?: string | null; category_source?: string; notes?: string }): Transaction {
    const id = `manual:${randomBytes(10).toString('hex')}`;
    this.db.prepare(
      `INSERT INTO ${this.t('transactions')} (id, account_id, date, description, payee, amount, category_id, category_source, notes, source, reviewed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1)`,
    ).run(id, t.account_id, t.date, t.payee, t.payee, t.amount, t.category_id ?? null, t.category_source ?? (t.category_id ? 'user' : 'none'), t.notes ?? '');
    return this.getTransaction(id)!;
  }
  hasTransaction(id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM ${this.t('transactions')} WHERE id = ?`).get(id);
  }
  getTransaction(id: string): Transaction | null {
    const r = this.db.prepare(`SELECT * FROM ${this.t('transactions')} WHERE id = ?`).get(id) as Row | undefined;
    if (!r) return null;
    const t = toTxn(r);
    t.tags = this.tagsFor([id]).get(id) ?? [];
    return t;
  }
  updateTransaction(id: string, patch: {
    payee?: string; category_id?: string | null; notes?: string; excluded?: boolean; reviewed?: boolean;
    date?: string; amount?: number; tags?: string[];
  }): boolean {
    const sets: string[] = []; const vals: unknown[] = [];
    if (patch.payee !== undefined) { sets.push('payee = ?'); vals.push(patch.payee); }
    if (patch.category_id !== undefined) { sets.push('category_id = ?', `category_source = 'user'`); vals.push(patch.category_id); }
    if (patch.notes !== undefined) { sets.push('notes = ?'); vals.push(patch.notes); }
    if (patch.excluded !== undefined) { sets.push('excluded = ?'); vals.push(patch.excluded ? 1 : 0); }
    if (patch.reviewed !== undefined) { sets.push('reviewed = ?'); vals.push(patch.reviewed ? 1 : 0); }
    if (patch.date !== undefined) { sets.push('date = ?'); vals.push(patch.date); }
    if (patch.amount !== undefined) { sets.push('amount = ?'); vals.push(patch.amount); }
    return this.transaction(() => {
      let changed = false;
      if (sets.length) {
        sets.push(`updated_at = strftime('%s','now')`);
        changed = this.db.prepare(`UPDATE ${this.t('transactions')} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id).changes > 0;
      }
      if (patch.tags !== undefined) {
        this.db.prepare(`DELETE FROM ${this.t('transaction_tags')} WHERE transaction_id = ?`).run(id);
        const ins = this.db.prepare(`INSERT OR IGNORE INTO ${this.t('transaction_tags')} (transaction_id, tag) VALUES (?, ?)`);
        for (const tag of patch.tags) ins.run(id, tag.trim().toLowerCase());
        changed = true;
      }
      return changed;
    });
  }
  /** Rule application: only touches rows the operator hasn't categorized. */
  applyRuleResult(id: string, r: { category_id?: string | null; payee?: string; excluded?: boolean; tags?: string[] }): void {
    this.transaction(() => {
      if (r.category_id !== undefined) {
        this.db.prepare(`UPDATE ${this.t('transactions')} SET category_id = ?, category_source = 'rule', updated_at = strftime('%s','now') WHERE id = ? AND category_source <> 'user'`).run(r.category_id, id);
      }
      if (r.payee !== undefined) this.db.prepare(`UPDATE ${this.t('transactions')} SET payee = ? WHERE id = ?`).run(r.payee, id);
      if (r.excluded !== undefined) this.db.prepare(`UPDATE ${this.t('transactions')} SET excluded = ? WHERE id = ?`).run(r.excluded ? 1 : 0, id);
      if (r.tags?.length) {
        const ins = this.db.prepare(`INSERT OR IGNORE INTO ${this.t('transaction_tags')} (transaction_id, tag) VALUES (?, ?)`);
        for (const tag of r.tags) ins.run(id, tag.trim().toLowerCase());
      }
    });
  }
  setTransferGroup(ids: string[], group: string | null): void {
    const upd = this.db.prepare(`UPDATE ${this.t('transactions')} SET transfer_group = ?, excluded = ?, category_id = CASE WHEN category_source = 'user' THEN category_id ELSE ? END, category_source = CASE WHEN category_source = 'user' THEN category_source ELSE 'rule' END WHERE id = ?`);
    this.transaction(() => { for (const id of ids) upd.run(group, group ? 1 : 0, group ? 'transfer' : null, id); });
  }
  deleteTransaction(id: string): boolean {
    return this.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.t('splits')} WHERE transaction_id = ?`).run(id);
      this.db.prepare(`DELETE FROM ${this.t('transaction_tags')} WHERE transaction_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM ${this.t('transactions')} WHERE id = ?`).run(id).changes > 0;
    });
  }
  /** Rows Plaid reports removed (pending that never posted, reversals). */
  deleteTransactions(ids: string[]): void {
    for (const id of ids) this.deleteTransaction(id);
  }
  listTransactions(f: TransactionFilter = {}): { rows: Transaction[]; total: number } {
    const where: string[] = []; const vals: unknown[] = [];
    if (f.from) { where.push('t.date >= ?'); vals.push(f.from); }
    if (f.to) { where.push('t.date <= ?'); vals.push(f.to); }
    if (f.account_id) { where.push('t.account_id = ?'); vals.push(f.account_id); }
    if (f.category_id) { where.push('t.category_id = ?'); vals.push(f.category_id); }
    if (f.uncategorized) where.push(`(t.category_id IS NULL OR t.category_id = '${UNCATEGORIZED}')`);
    if (f.unreviewed) where.push('t.reviewed = 0');
    if (!f.include_excluded) where.push('t.excluded = 0');
    if (!f.include_pending) where.push('t.pending = 0');
    if (f.q) { where.push('(t.payee LIKE ? OR t.description LIKE ? OR t.notes LIKE ?)'); const like = `%${f.q}%`; vals.push(like, like, like); }
    const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.t('transactions')} t${w}`).get(...vals) as { n: number }).n;
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    const offset = Math.max(f.offset ?? 0, 0);
    const rows = (this.db.prepare(`SELECT t.* FROM ${this.t('transactions')} t${w} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset) as Row[]).map(toTxn);
    const tags = this.tagsFor(rows.map(r => r.id));
    for (const r of rows) r.tags = tags.get(r.id) ?? [];
    return { rows, total };
  }
  /** Every posted, non-excluded row in a window — the reporting feed. */
  ledger(from: string, to: string, opts: { includeExcluded?: boolean } = {}): Transaction[] {
    const ex = opts.includeExcluded ? '' : ' AND excluded = 0';
    return (this.db.prepare(`SELECT * FROM ${this.t('transactions')} WHERE date >= ? AND date <= ? AND pending = 0${ex} ORDER BY date DESC, id DESC`).all(from, to) as Row[]).map(toTxn);
  }
  /** Rows a sync just touched that no operator or rule has categorized yet. */
  uncategorizedIds(sinceEpoch?: number): Transaction[] {
    const w = sinceEpoch ? ' AND updated_at >= ?' : '';
    const vals = sinceEpoch ? [sinceEpoch] : [];
    return (this.db.prepare(`SELECT * FROM ${this.t('transactions')} WHERE category_source NOT IN ('user','rule')${w}`).all(...vals) as Row[]).map(toTxn);
  }
  /** Candidate counterpart for a transfer: opposite amount, another account, within ±days. */
  transferCandidates(t: Transaction, days = 3): Transaction[] {
    return (this.db.prepare(
      `SELECT * FROM ${this.t('transactions')} WHERE account_id <> ? AND transfer_group IS NULL AND ABS(amount + ?) < 0.005
         AND date >= date(?, ?) AND date <= date(?, ?) AND category_source <> 'user'`,
    ).all(t.account_id, t.amount, t.date, `-${days} days`, t.date, `+${days} days`) as Row[]).map(toTxn);
  }
  private tagsFor(ids: string[]): Map<string, string[]> {
    const m = new Map<string, string[]>();
    if (!ids.length) return m;
    const chunk = 500;
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      const rows = this.db.prepare(`SELECT transaction_id, tag FROM ${this.t('transaction_tags')} WHERE transaction_id IN (${part.map(() => '?').join(',')}) ORDER BY tag`).all(...part) as Array<{ transaction_id: string; tag: string }>;
      for (const r of rows) { const arr = m.get(r.transaction_id); if (arr) arr.push(r.tag); else m.set(r.transaction_id, [r.tag]); }
    }
    return m;
  }
  listTags(): string[] {
    return (this.db.prepare(`SELECT DISTINCT tag FROM ${this.t('transaction_tags')} ORDER BY tag`).all() as Array<{ tag: string }>).map(r => r.tag);
  }

  // ---- splits ------------------------------------------------------------
  splitsFor(ids: string[]): Map<string, Split[]> {
    const m = new Map<string, Split[]>();
    if (!ids.length) return m;
    const chunk = 500;
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      const rows = this.db.prepare(`SELECT * FROM ${this.t('splits')} WHERE transaction_id IN (${part.map(() => '?').join(',')}) ORDER BY id`).all(...part) as Split[];
      for (const r of rows) { const arr = m.get(r.transaction_id); if (arr) arr.push(r); else m.set(r.transaction_id, [r]); }
    }
    return m;
  }
  allSplits(from: string, to: string): Split[] {
    return this.db.prepare(
      `SELECT s.* FROM ${this.t('splits')} s JOIN ${this.t('transactions')} t ON t.id = s.transaction_id WHERE t.date >= ? AND t.date <= ? AND t.pending = 0 AND t.excluded = 0`,
    ).all(from, to) as Split[];
  }
  setSplits(transactionId: string, splits: Array<{ category_id: string | null; amount: number; notes?: string }>): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.t('splits')} WHERE transaction_id = ?`).run(transactionId);
      const ins = this.db.prepare(`INSERT INTO ${this.t('splits')} (transaction_id, category_id, amount, notes) VALUES (?, ?, ?, ?)`);
      for (const s of splits) ins.run(transactionId, s.category_id, s.amount, s.notes ?? '');
      if (splits.length) this.db.prepare(`UPDATE ${this.t('transactions')} SET category_source = 'user', updated_at = strftime('%s','now') WHERE id = ?`).run(transactionId);
    });
  }

  // ---- categories --------------------------------------------------------
  listCategories(includeArchived = false): Category[] {
    const w = includeArchived ? '' : ' WHERE archived = 0';
    return (this.db.prepare(`SELECT * FROM ${this.t('categories')}${w} ORDER BY sort, name`).all() as Row[]).map(toCategory);
  }
  getCategory(id: string): Category | null {
    const r = this.db.prepare(`SELECT * FROM ${this.t('categories')} WHERE id = ?`).get(id) as Row | undefined;
    return r ? toCategory(r) : null;
  }
  createCategory(c: { id: string; name: string; group_name: string; kind: string }): Category {
    const max = (this.db.prepare(`SELECT COALESCE(MAX(sort), 0) AS m FROM ${this.t('categories')}`).get() as { m: number }).m;
    this.db.prepare(`INSERT INTO ${this.t('categories')} (id, name, group_name, kind, sort) VALUES (?, ?, ?, ?, ?)`).run(c.id, c.name, c.group_name, c.kind, max + 1);
    return this.getCategory(c.id)!;
  }
  updateCategory(id: string, patch: { name?: string; group_name?: string; kind?: string; archived?: boolean; sort?: number }): boolean {
    const sets: string[] = []; const vals: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (patch.group_name !== undefined) { sets.push('group_name = ?'); vals.push(patch.group_name); }
    if (patch.kind !== undefined) { sets.push('kind = ?'); vals.push(patch.kind); }
    if (patch.archived !== undefined) { sets.push('archived = ?'); vals.push(patch.archived ? 1 : 0); }
    if (patch.sort !== undefined) { sets.push('sort = ?'); vals.push(patch.sort); }
    if (!sets.length) return false;
    return this.db.prepare(`UPDATE ${this.t('categories')} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id).changes > 0;
  }
  /** Delete a category and move its rows to Uncategorized. */
  deleteCategory(id: string): boolean {
    if (id === UNCATEGORIZED) return false;
    return this.transaction(() => {
      this.db.prepare(`UPDATE ${this.t('transactions')} SET category_id = ? WHERE category_id = ?`).run(UNCATEGORIZED, id);
      this.db.prepare(`UPDATE ${this.t('splits')} SET category_id = ? WHERE category_id = ?`).run(UNCATEGORIZED, id);
      this.db.prepare(`UPDATE ${this.t('provider_category_map')} SET category_id = ? WHERE category_id = ?`).run(UNCATEGORIZED, id);
      this.db.prepare(`DELETE FROM ${this.t('budgets')} WHERE category_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM ${this.t('categories')} WHERE id = ?`).run(id).changes > 0;
    });
  }
  providerCategoryMap(): Record<string, string> {
    const rows = this.db.prepare(`SELECT provider_category, category_id FROM ${this.t('provider_category_map')}`).all() as Array<{ provider_category: string; category_id: string }>;
    return Object.fromEntries(rows.map(r => [r.provider_category, r.category_id]));
  }
  setProviderCategory(providerCategory: string, categoryId: string): void {
    this.db.prepare(`INSERT INTO ${this.t('provider_category_map')} (provider_category, category_id) VALUES (?, ?) ON CONFLICT(provider_category) DO UPDATE SET category_id = excluded.category_id`).run(providerCategory, categoryId);
  }

  // ---- rules -------------------------------------------------------------
  listRules(): Rule[] {
    return (this.db.prepare(`SELECT * FROM ${this.t('rules')} ORDER BY priority, id`).all() as Row[]).map(toRule);
  }
  createRule(r: Omit<Rule, 'id' | 'created_at'>): Rule {
    const res = this.db.prepare(
      `INSERT INTO ${this.t('rules')} (priority, enabled, field, op, pattern, amount_min, amount_max, account_id, set_category_id, set_payee, set_excluded, set_tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.priority, r.enabled ? 1 : 0, r.field, r.op, r.pattern, r.amount_min, r.amount_max, r.account_id, r.set_category_id, r.set_payee,
      tri(r.set_excluded), JSON.stringify(r.set_tags));
    return toRule(this.db.prepare(`SELECT * FROM ${this.t('rules')} WHERE id = ?`).get(Number(res.lastInsertRowid)) as Row);
  }
  updateRule(id: number, patch: RulePatch): boolean {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const col of RULE_COLUMNS) {
      const v = patch[col];
      if (v === undefined) continue;
      sets.push(`${col} = ?`); vals.push(ruleCell(col, v));
    }
    if (!sets.length) return false;
    return this.db.prepare(`UPDATE ${this.t('rules')} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id).changes > 0;
  }
  deleteRule(id: number): boolean {
    return this.db.prepare(`DELETE FROM ${this.t('rules')} WHERE id = ?`).run(id).changes > 0;
  }

  // ---- budgets -----------------------------------------------------------
  listBudgets(): Budget[] {
    return this.db.prepare(`SELECT * FROM ${this.t('budgets')} ORDER BY category_id, month`).all() as Budget[];
  }
  setBudget(categoryId: string, month: string, amount: number): void {
    this.db.prepare(`INSERT INTO ${this.t('budgets')} (category_id, month, amount) VALUES (?, ?, ?) ON CONFLICT(category_id, month) DO UPDATE SET amount = excluded.amount`).run(categoryId, month, amount);
  }
  deleteBudget(categoryId: string, month: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.t('budgets')} WHERE category_id = ? AND month = ?`).run(categoryId, month).changes > 0;
  }

  // ---- recurring ---------------------------------------------------------
  listRecurring(): Recurring[] {
    return this.db.prepare(`SELECT * FROM ${this.t('recurring')} ORDER BY next_date, display_name`).all() as unknown as Recurring[];
  }
  getRecurring(id: number): Recurring | null {
    return (this.db.prepare(`SELECT * FROM ${this.t('recurring')} WHERE id = ?`).get(id) as Recurring | undefined) ?? null;
  }
  /** Detection upsert: a dismissed or confirmed row keeps its status and the
   *  operator's amount/category; only the observed dates and count move. */
  upsertDetectedRecurring(r: { payee_key: string; display_name: string; category_id: string | null; account_id: string | null; amount: number; cadence: string; last_date: string; next_date: string; occurrences: number }): void {
    this.db.prepare(
      `INSERT INTO ${this.t('recurring')} (payee_key, display_name, category_id, account_id, amount, cadence, last_date, next_date, status, occurrences)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'detected', ?)
       ON CONFLICT(payee_key, account_id) DO UPDATE SET
         last_date = excluded.last_date, next_date = excluded.next_date, occurrences = excluded.occurrences,
         amount = CASE WHEN status = 'detected' THEN excluded.amount ELSE amount END,
         cadence = CASE WHEN status = 'detected' THEN excluded.cadence ELSE cadence END,
         category_id = CASE WHEN status = 'detected' THEN excluded.category_id ELSE category_id END,
         updated_at = strftime('%s','now')`,
    ).run(r.payee_key, r.display_name, r.category_id, r.account_id, r.amount, r.cadence, r.last_date, r.next_date, r.occurrences);
  }
  /** After re-detection: proposals that no longer match the ledger go away; confirmed and dismissed rows stay. */
  pruneDetectedRecurring(keep: Array<{ payee_key: string; account_id: string | null }>): number {
    const rows = this.db.prepare(`SELECT id, payee_key, account_id FROM ${this.t('recurring')} WHERE status = 'detected'`).all() as Array<{ id: number; payee_key: string; account_id: string | null }>;
    const live = new Set(keep.map(k => `${k.payee_key}|${k.account_id ?? ''}`));
    let n = 0;
    for (const r of rows) if (!live.has(`${r.payee_key}|${r.account_id ?? ''}`)) { this.deleteRecurring(r.id); n++; }
    return n;
  }
  createRecurring(r: { display_name: string; category_id: string | null; account_id: string | null; amount: number; cadence: string; next_date: string }): Recurring {
    const key = `manual:${r.display_name.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const res = this.db.prepare(
      `INSERT INTO ${this.t('recurring')} (payee_key, display_name, category_id, account_id, amount, cadence, last_date, next_date, status, occurrences)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, 'confirmed', 0)`,
    ).run(key, r.display_name, r.category_id, r.account_id, r.amount, r.cadence, r.next_date);
    return this.getRecurring(Number(res.lastInsertRowid))!;
  }
  updateRecurring(id: number, patch: { status?: string; amount?: number; category_id?: string | null; cadence?: string; next_date?: string; display_name?: string }): boolean {
    const sets: string[] = []; const vals: unknown[] = [];
    const push = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.amount !== undefined) push('amount', patch.amount);
    if (patch.category_id !== undefined) push('category_id', patch.category_id);
    if (patch.cadence !== undefined) push('cadence', patch.cadence);
    if (patch.next_date !== undefined) push('next_date', patch.next_date);
    if (patch.display_name !== undefined) push('display_name', patch.display_name);
    if (!sets.length) return false;
    sets.push(`updated_at = strftime('%s','now')`);
    return this.db.prepare(`UPDATE ${this.t('recurring')} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id).changes > 0;
  }
  deleteRecurring(id: number): boolean {
    return this.db.prepare(`DELETE FROM ${this.t('recurring')} WHERE id = ?`).run(id).changes > 0;
  }

  // ---- goals -------------------------------------------------------------
  listGoals(): Goal[] {
    return (this.db.prepare(`SELECT * FROM ${this.t('goals')} ORDER BY id`).all() as Row[]).map(toGoal);
  }
  createGoal(g: { name: string; kind: string; target_amount: number; target_date: string | null; account_ids: string[]; start_balance: number | null }): Goal {
    const res = this.db.prepare(`INSERT INTO ${this.t('goals')} (name, kind, target_amount, target_date, account_ids, start_balance) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(g.name, g.kind, g.target_amount, g.target_date, JSON.stringify(g.account_ids), g.start_balance);
    return toGoal(this.db.prepare(`SELECT * FROM ${this.t('goals')} WHERE id = ?`).get(Number(res.lastInsertRowid)) as Row);
  }
  updateGoal(id: number, patch: { name?: string; target_amount?: number; target_date?: string | null; account_ids?: string[]; start_balance?: number | null }): boolean {
    const sets: string[] = []; const vals: unknown[] = [];
    const push = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.target_amount !== undefined) push('target_amount', patch.target_amount);
    if (patch.target_date !== undefined) push('target_date', patch.target_date);
    if (patch.account_ids !== undefined) push('account_ids', JSON.stringify(patch.account_ids));
    if (patch.start_balance !== undefined) push('start_balance', patch.start_balance);
    if (!sets.length) return false;
    return this.db.prepare(`UPDATE ${this.t('goals')} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id).changes > 0;
  }
  deleteGoal(id: number): boolean {
    return this.db.prepare(`DELETE FROM ${this.t('goals')} WHERE id = ?`).run(id).changes > 0;
  }

  // ---- holdings ----------------------------------------------------------
  replaceHoldings(accountId: string, rows: Array<Omit<Holding, 'account_id' | 'updated_at'>>): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.t('holdings')} WHERE account_id = ?`).run(accountId);
      const ins = this.db.prepare(`INSERT INTO ${this.t('holdings')} (id, account_id, symbol, description, quantity, price, market_value, cost_basis, currency, as_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const h of rows) ins.run(h.id, accountId, h.symbol, h.description, h.quantity, h.price, h.market_value, h.cost_basis, h.currency, h.as_of);
    });
  }
  listHoldings(): Holding[] {
    return this.db.prepare(`SELECT * FROM ${this.t('holdings')} ORDER BY account_id, market_value DESC`).all() as unknown as Holding[];
  }
}

/**
 * Finance plugin data access over scoped tables (plugin_finance_*). READ-ONLY
 * aggregation cache: rows are written by the Plaid sync and read by the
 * reporting layer + agent tools. Bank access tokens live in the SecretStore
 * (never in these tables). Amount sign follows Plaid: a POSITIVE amount is
 * money leaving the account (a spend/debit); NEGATIVE is money in (income/
 * refund).
 */
import type { PluginDb } from '../types.js';

export interface FinanceItem {
  item_id: string;
  institution_id: string;
  institution_name: string;
  cursor: string | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface Account {
  account_id: string;
  item_id: string;
  name: string;
  official_name: string;
  type: string;
  subtype: string;
  mask: string;
  current_balance: number | null;
  available_balance: number | null;
  iso_currency: string;
  updated_at: number;
}

export interface Transaction {
  transaction_id: string;
  account_id: string;
  date: string;            // YYYY-MM-DD
  name: string;
  merchant_name: string;
  amount: number;          // + = spend, - = income (Plaid convention)
  iso_currency: string;
  category: string;        // primary personal-finance category
  category_detailed: string;
  pending: boolean;
  updated_at: number;
}

export interface CategoryTarget {
  category: string;
  monthly_limit: number;
  updated_at: number;
}

interface ItemRow { item_id: string; institution_id: string; institution_name: string; cursor: string | null; status: string; error: string | null; created_at: number; updated_at: number }
interface AccountRow { account_id: string; item_id: string; name: string; official_name: string; type: string; subtype: string; mask: string; current_balance: number | null; available_balance: number | null; iso_currency: string; updated_at: number }
interface TxnRow { transaction_id: string; account_id: string; date: string; name: string; merchant_name: string; amount: number; iso_currency: string; category: string; category_detailed: string; pending: number; updated_at: number }
interface TargetRow { category: string; monthly_limit: number; updated_at: number }

const toTxn = (r: TxnRow): Transaction => ({ ...r, pending: r.pending === 1 });

export class FinanceStore {
  constructor(private readonly db: PluginDb) {}

  private get items(): string { return this.db.table('items'); }
  private get accounts(): string { return this.db.table('accounts'); }
  private get txns(): string { return this.db.table('transactions'); }
  private get targets(): string { return this.db.table('category_targets'); }

  // ---- items (linked institutions) --------------------------------------
  upsertItem(i: { item_id: string; institution_id?: string; institution_name?: string }): void {
    this.db.prepare(
      `INSERT INTO ${this.items} (item_id, institution_id, institution_name)
       VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         institution_id = excluded.institution_id,
         institution_name = excluded.institution_name,
         updated_at = strftime('%s','now')`,
    ).run(i.item_id, i.institution_id ?? '', i.institution_name ?? '');
  }

  listItems(): FinanceItem[] {
    return this.db.prepare(`SELECT * FROM ${this.items} ORDER BY institution_name COLLATE NOCASE ASC`).all() as ItemRow[];
  }

  getItem(itemId: string): FinanceItem | null {
    return (this.db.prepare(`SELECT * FROM ${this.items} WHERE item_id = ?`).get(itemId) as ItemRow | undefined) ?? null;
  }

  setCursor(itemId: string, cursor: string): void {
    this.db.prepare(`UPDATE ${this.items} SET cursor = ?, updated_at = strftime('%s','now') WHERE item_id = ?`).run(cursor, itemId);
  }

  setItemStatus(itemId: string, status: string, error: string | null = null): void {
    this.db.prepare(`UPDATE ${this.items} SET status = ?, error = ?, updated_at = strftime('%s','now') WHERE item_id = ?`).run(status, error, itemId);
  }

  /** Remove an item and everything it owns (accounts + transactions). */
  deleteItem(itemId: string): void {
    const tx = this.db.transaction(() => {
      const accts = (this.db.prepare(`SELECT account_id FROM ${this.accounts} WHERE item_id = ?`).all(itemId) as { account_id: string }[]).map(a => a.account_id);
      for (const a of accts) this.db.prepare(`DELETE FROM ${this.txns} WHERE account_id = ?`).run(a);
      this.db.prepare(`DELETE FROM ${this.accounts} WHERE item_id = ?`).run(itemId);
      this.db.prepare(`DELETE FROM ${this.items} WHERE item_id = ?`).run(itemId);
    });
    tx();
  }

  // ---- accounts ---------------------------------------------------------
  upsertAccount(a: Omit<Account, 'updated_at'>): void {
    this.db.prepare(
      `INSERT INTO ${this.accounts}
         (account_id, item_id, name, official_name, type, subtype, mask, current_balance, available_balance, iso_currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         item_id = excluded.item_id, name = excluded.name, official_name = excluded.official_name,
         type = excluded.type, subtype = excluded.subtype, mask = excluded.mask,
         current_balance = excluded.current_balance, available_balance = excluded.available_balance,
         iso_currency = excluded.iso_currency, updated_at = strftime('%s','now')`,
    ).run(a.account_id, a.item_id, a.name, a.official_name, a.type, a.subtype, a.mask, a.current_balance, a.available_balance, a.iso_currency);
  }

  listAccounts(): Account[] {
    return this.db.prepare(`SELECT * FROM ${this.accounts} ORDER BY type ASC, name COLLATE NOCASE ASC`).all() as AccountRow[];
  }

  // ---- transactions -----------------------------------------------------
  upsertTransaction(t: Omit<Transaction, 'updated_at'>): void {
    this.db.prepare(
      `INSERT INTO ${this.txns}
         (transaction_id, account_id, date, name, merchant_name, amount, iso_currency, category, category_detailed, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET
         account_id = excluded.account_id, date = excluded.date, name = excluded.name,
         merchant_name = excluded.merchant_name, amount = excluded.amount, iso_currency = excluded.iso_currency,
         category = excluded.category, category_detailed = excluded.category_detailed,
         pending = excluded.pending, updated_at = strftime('%s','now')`,
    ).run(t.transaction_id, t.account_id, t.date, t.name, t.merchant_name, t.amount, t.iso_currency, t.category, t.category_detailed, t.pending ? 1 : 0);
  }

  deleteTransaction(transactionId: string): void {
    this.db.prepare(`DELETE FROM ${this.txns} WHERE transaction_id = ?`).run(transactionId);
  }

  /** All transactions on/after `since` (YYYY-MM-DD), newest first. Excludes
   *  pending unless `includePending`. */
  transactionsSince(since: string, includePending = false): Transaction[] {
    const sql = `SELECT * FROM ${this.txns} WHERE date >= ?${includePending ? '' : ' AND pending = 0'} ORDER BY date DESC, transaction_id DESC`;
    return (this.db.prepare(sql).all(since) as TxnRow[]).map(toTxn);
  }

  /** Text search over name/merchant, newest first, capped. */
  searchTransactions(query: string, limit = 50): Transaction[] {
    const like = `%${query}%`;
    return (this.db.prepare(
      `SELECT * FROM ${this.txns} WHERE name LIKE ? OR merchant_name LIKE ? ORDER BY date DESC, transaction_id DESC LIMIT ?`,
    ).all(like, like, limit) as TxnRow[]).map(toTxn);
  }

  // ---- category targets (light budgets) ---------------------------------
  setTarget(category: string, monthlyLimit: number): void {
    this.db.prepare(
      `INSERT INTO ${this.targets} (category, monthly_limit) VALUES (?, ?)
       ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit, updated_at = strftime('%s','now')`,
    ).run(category, monthlyLimit);
  }

  listTargets(): CategoryTarget[] {
    return this.db.prepare(`SELECT * FROM ${this.targets} ORDER BY category ASC`).all() as TargetRow[];
  }

  deleteTarget(category: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.targets} WHERE category = ?`).run(category).changes > 0;
  }
}

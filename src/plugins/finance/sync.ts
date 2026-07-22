/**
 * Pull a linked item's balances + transactions from Plaid into the local
 * cache. Read-only: balances via /accounts/balance/get, transactions via the
 * incremental /transactions/sync cursor. Idempotent — re-running resumes from
 * the stored cursor and upserts, so it's safe to call on a schedule.
 */
import type { FinanceStore } from './store.js';
import type { PlaidAccount, PlaidTransaction, SyncResponse } from './plaid.js';

/** Minimal Plaid surface sync needs — lets tests pass a fake. */
export interface PlaidSyncClient {
  getBalances(accessToken: string): Promise<PlaidAccount[]>;
  syncTransactions(accessToken: string, cursor?: string): Promise<SyncResponse>;
}

function mapAccount(a: PlaidAccount, itemId: string) {
  return {
    account_id: a.account_id,
    item_id: itemId,
    name: a.name ?? '',
    official_name: a.official_name ?? '',
    type: a.type ?? '',
    subtype: a.subtype ?? '',
    mask: a.mask ?? '',
    current_balance: a.balances?.current ?? null,
    available_balance: a.balances?.available ?? null,
    iso_currency: a.balances?.iso_currency_code ?? 'USD',
  };
}

function mapTxn(t: PlaidTransaction) {
  const category = t.personal_finance_category?.primary || t.category?.[0] || 'Uncategorized';
  return {
    transaction_id: t.transaction_id,
    account_id: t.account_id,
    date: t.date,
    name: t.name ?? '',
    merchant_name: t.merchant_name ?? '',
    amount: t.amount,
    iso_currency: t.iso_currency_code ?? 'USD',
    category,
    category_detailed: t.personal_finance_category?.detailed ?? '',
    pending: t.pending,
  };
}

export interface SyncResult { accounts: number; added: number; modified: number; removed: number }

/** Cap on sync pages so a misbehaving/never-ending has_more can't loop forever. */
const MAX_SYNC_PAGES = 50;

export async function syncItem(store: FinanceStore, plaid: PlaidSyncClient, accessToken: string, itemId: string): Promise<SyncResult> {
  const accounts = await plaid.getBalances(accessToken);
  for (const a of accounts) store.upsertAccount(mapAccount(a, itemId));

  let cursor = store.getItem(itemId)?.cursor ?? undefined;
  let added = 0, modified = 0, removed = 0;
  for (let page = 0; page < MAX_SYNC_PAGES; page++) {
    const r = await plaid.syncTransactions(accessToken, cursor);
    for (const t of r.added) { store.upsertTransaction(mapTxn(t)); added++; }
    for (const t of r.modified) { store.upsertTransaction(mapTxn(t)); modified++; }
    for (const t of r.removed) { store.deleteTransaction(t.transaction_id); removed++; }
    cursor = r.next_cursor;
    store.setCursor(itemId, cursor);
    if (!r.has_more) break;
  }
  store.setItemStatus(itemId, 'active', null);
  return { accounts: accounts.length, added, modified, removed };
}

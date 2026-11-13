/**
 * Pull a connection's data into the ledger, then run the enrichment that makes
 * the ledger useful: provider/keyword categorization for new rows, operator
 * rules, transfer pairing, and recurring detection. Idempotent — re-running
 * upserts and never touches a category the operator set.
 */
import { randomBytes } from 'node:crypto';
import type { FinanceStore, Transaction } from './store.js';
import type { Provider, ProviderTransaction } from './providers/types.js';
import { categorizeByKeyword } from './categories.js';
import { applyRules } from './rules.js';
import { detectRecurring } from './recurring.js';

export interface SyncResult { accounts: number; added: number; modified: number; removed: number; holdings: number }

const accountId = (provider: string, pid: string) => `${provider}:${pid}`;
const txnId = (provider: string, pid: string) => `${provider}:${pid}`;

export async function syncConnection(store: FinanceStore, provider: Provider, connId: string): Promise<SyncResult> {
  const conn = store.getConnection(connId);
  if (!conn) throw new Error(`unknown connection ${connId}`);
  const r = await provider.fetch({ id: conn.id, cursor: conn.cursor, last_synced_at: conn.last_synced_at });
  const map = store.providerCategoryMap();
  const rules = store.listRules();
  const result: SyncResult = { accounts: 0, added: 0, modified: 0, removed: 0, holdings: 0 };
  const newIds: string[] = [];

  store.transaction(() => {
    for (const a of r.accounts) {
      store.upsertAccount({
        id: accountId(provider.name, a.provider_account_id), connection_id: conn.id, provider_account_id: a.provider_account_id,
        name: a.name, official_name: a.official_name, type: a.type, subtype: a.subtype, mask: a.mask, institution: a.institution,
        balance: a.balance, available_balance: a.available_balance, currency: a.currency, balance_as_of: a.balance_as_of,
      });
      result.accounts++;
    }
    const upsert = (t: ProviderTransaction, source: 'added' | 'modified') => {
      const id = txnId(provider.name, t.provider_transaction_id);
      const existed = store.hasTransaction(id);
      const cat = providerCategory(map, t.provider_categories) ?? categorizeByKeyword(`${t.payee ?? ''} ${t.description}`);
      store.upsertTransaction({
        id, account_id: accountId(provider.name, t.provider_account_id), date: t.date, description: t.description,
        payee: t.payee || t.description, amount: t.amount, currency: t.currency, category_id: cat,
        category_source: cat ? 'provider' : 'none', provider_category: t.provider_categories?.[0] ?? '', pending: t.pending,
      });
      if (existed) result.modified++; else { result.added++; newIds.push(id); }
      void source;
    };
    for (const t of r.added) upsert(t, 'added');
    for (const t of r.modified) upsert(t, 'modified');
    if (r.removed.length) { store.deleteTransactions(r.removed.map(id => txnId(provider.name, id))); result.removed = r.removed.length; }
    const byAccount = new Map<string, typeof r.holdings>();
    for (const h of r.holdings) { const k = accountId(provider.name, h.provider_account_id); const arr = byAccount.get(k); if (arr) arr.push(h); else byAccount.set(k, [h]); }
    for (const [acct, hs] of byAccount) {
      store.replaceHoldings(acct, hs.map(h => ({
        id: `${provider.name}:${h.provider_holding_id}`, symbol: h.symbol, description: h.description, quantity: h.quantity,
        price: h.price, market_value: h.market_value, cost_basis: h.cost_basis, currency: h.currency ?? 'USD', as_of: h.as_of,
      })));
      result.holdings += hs.length;
    }
    if (r.cursor) store.setCursor(conn.id, r.cursor);
    for (const id of newIds) {
      const t = store.getTransaction(id);
      if (t) enrichNew(store, rules, t);
    }
    store.setConnectionStatus(conn.id, 'active', r.warnings?.length ? r.warnings.join('; ') : null);
  });
  refreshRecurring(store);
  return result;
}

/** Map the provider's labels (most specific first) through the editable map. */
export function providerCategory(map: Record<string, string>, labels: string[] | undefined): string | null {
  for (const l of labels ?? []) { const hit = map[l]; if (hit) return hit; }
  return null;
}

/** Rules, then transfer pairing, for a row that just entered the ledger. */
export function enrichNew(store: FinanceStore, rules: ReturnType<FinanceStore['listRules']>, t: Transaction): void {
  const effect = applyRules(rules, t);
  if (effect) store.applyRuleResult(t.id, effect);
  if (!t.transfer_group && t.category_source !== 'user') {
    const [match] = store.transferCandidates(t);
    if (match) store.setTransferGroup([t.id, match.id], `tg_${randomBytes(6).toString('hex')}`);
  }
}

/** Re-detect recurring charges over the trailing ~13 months. */
export function refreshRecurring(store: FinanceStore): number {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const detected = detectRecurring(store.ledger(from, today), today);
  store.transaction(() => {
    for (const d of detected) store.upsertDetectedRecurring(d);
    store.pruneDetectedRecurring(detected);
  });
  return detected.length;
}

/** Re-run every enabled rule across rows the operator hasn't categorized by hand. */
export function reapplyRules(store: FinanceStore): number {
  const rules = store.listRules();
  let n = 0;
  store.transaction(() => {
    for (const t of store.uncategorizedIds()) {
      const effect = applyRules(rules, t);
      if (effect) { store.applyRuleResult(t.id, effect); n++; }
    }
  });
  return n;
}

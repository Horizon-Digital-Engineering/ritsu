import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb } from '../plugins/host.js';
import { migrate } from '../plugins/finance/migrate.js';
import { FinanceStore } from '../plugins/finance/store.js';
import { PlaidClient } from '../plugins/finance/plaid.js';
import { syncItem, type PlaidSyncClient } from '../plugins/finance/sync.js';
import type { PlaidAccount, SyncResponse } from '../plugins/finance/plaid.js';

function store(): FinanceStore {
  const db = new ScopedDb(openDatabase(':memory:'), 'finance');
  migrate(db);
  const s = new FinanceStore(db);
  s.upsertItem({ item_id: 'item-1', institution_name: 'Sandbox Bank' });
  return s;
}

describe('PlaidClient request shaping', () => {
  it('posts client_id+secret+params to the sandbox base, parses the response', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (url: string, init: { body: string }) => {
      seen = { url, body: JSON.parse(init.body) as Record<string, unknown> };
      return { ok: true, status: 200, json: async () => ({ access_token: 'access-sandbox-xyz', item_id: 'item-1' }) };
    }) as unknown as typeof fetch;
    const client = new PlaidClient({ creds: { clientId: 'cid', secret: 'sek', env: 'sandbox' }, fetchImpl });
    const r = await client.exchangePublicToken('public-sandbox-abc');
    assert.equal(r.access_token, 'access-sandbox-xyz');
    assert.equal(seen!.url, 'https://sandbox.plaid.com/item/public_token/exchange');
    assert.equal(seen!.body.client_id, 'cid');
    assert.equal(seen!.body.secret, 'sek');
    assert.equal(seen!.body.public_token, 'public-sandbox-abc');
  });

  it('throws a PlaidError with the code on a non-2xx', async () => {
    const fetchImpl = (async () => ({
      ok: false, status: 400, json: async () => ({ error_code: 'INVALID_ACCESS_TOKEN', error_message: 'bad token' }),
    })) as unknown as typeof fetch;
    const client = new PlaidClient({ creds: { clientId: 'c', secret: 's', env: 'sandbox' }, fetchImpl });
    await assert.rejects(client.getBalances('nope'), /bad token/);
  });
});

describe('syncItem', () => {
  const acct = (id: string, bal: number): PlaidAccount => ({
    account_id: id, name: 'Checking', official_name: null, mask: '0000', type: 'depository', subtype: 'checking',
    balances: { current: bal, available: bal, iso_currency_code: 'USD' },
  });
  const page = (over: Partial<SyncResponse>): SyncResponse => ({ added: [], modified: [], removed: [], next_cursor: 'c', has_more: false, ...over });
  const tx = (id: string, amount: number) => ({
    transaction_id: id, account_id: 'a1', date: '2026-07-01', name: 'X', merchant_name: 'X', amount,
    iso_currency_code: 'USD', personal_finance_category: { primary: 'FOOD', detailed: 'FOOD_RESTAURANTS' }, category: null, pending: false,
  });

  it('pulls balances + paginated transactions, advances the cursor, handles removals', async () => {
    const s = store();
    const pages: SyncResponse[] = [
      page({ added: [tx('t1', 10), tx('t2', 20)], next_cursor: 'cur1', has_more: true }),
      page({ modified: [tx('t1', 12)], removed: [{ transaction_id: 't2' }], next_cursor: 'cur2', has_more: false }),
    ];
    let call = 0;
    const fake: PlaidSyncClient = {
      getBalances: async () => [acct('a1', 1500)],
      syncTransactions: async () => pages[call++],
    };
    const r = await syncItem(s, fake, 'access-token', 'item-1');
    assert.equal(r.accounts, 1);
    assert.equal(r.added, 2);
    assert.equal(r.modified, 1);
    assert.equal(r.removed, 1);
    assert.equal(s.listAccounts()[0].current_balance, 1500);
    // t2 was removed; t1 remains (amount updated to 12), category mapped from PFC.primary
    const txns = s.transactionsSince('2000-01-01');
    assert.equal(txns.length, 1);
    assert.equal(txns[0].transaction_id, 't1');
    assert.equal(txns[0].amount, 12);
    assert.equal(txns[0].category, 'FOOD');
    assert.equal(s.getItem('item-1')?.cursor, 'cur2');
  });
});

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb, PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { financePlugin } from '../plugins/finance/plugin.js';
import { FinanceStore } from '../plugins/finance/store.js';
import { PlaidClient, PlaidError } from '../plugins/finance/providers/plaid.js';
import { SimpleFinClient, claimSetupToken, SimpleFinError } from '../plugins/finance/providers/simplefin.js';
import { guessAccountType } from '../plugins/finance/providers/types.js';
import { syncConnection } from '../plugins/finance/sync.js';

function fresh() {
  const db = openDatabase(':memory:');
  const host = new PluginHost(db, new SecretStore(db));
  host.register(financePlugin);
  return { store: new FinanceStore(new ScopedDb(db, 'finance', true)) };
}
const D = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const unix = (n: number) => Math.floor((Date.now() - n * 86_400_000) / 1000);

type Call = { url: string; body: unknown; headers: Record<string, string> };
function fakeFetch(routes: Record<string, unknown>, calls: Call[] = []) {
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find(k => url.includes(k));
    if (!key) return new Response(JSON.stringify({ error_code: 'NOT_FOUND', error_message: `no route ${url}` }), { status: 404 });
    const v = routes[key];
    const out = typeof v === 'function' ? (v as (b: unknown) => unknown)(body) : v;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe('Plaid client + provider', () => {
  const creds = { clientId: 'cid', secret: 'sec', env: 'sandbox' as const };

  it('posts credentials to the sandbox base and surfaces typed errors', async () => {
    const { fetch, calls } = fakeFetch({ '/item/public_token/exchange': { access_token: 'at', item_id: 'it' } });
    const c = new PlaidClient({ creds, fetchImpl: fetch });
    const r = await c.exchangePublicToken('pt');
    assert.equal(r.item_id, 'it');
    assert.ok(calls[0].url.startsWith('https://sandbox.plaid.com'));
    assert.deepEqual(calls[0].body, { client_id: 'cid', secret: 'sec', public_token: 'pt' });
    const bad = fakeFetch({ '/accounts/balance/get': new Response(JSON.stringify({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'relink' }), { status: 400 }) });
    await assert.rejects(() => new PlaidClient({ creds, fetchImpl: bad.fetch }).getBalances('x'), (e: unknown) => e instanceof PlaidError && e.code === 'ITEM_LOGIN_REQUIRED');
  });

  it('provider flips signs, pages the cursor, and the sync lands everything in the ledger', async () => {
    const { store } = fresh();
    let page = 0;
    const { fetch } = fakeFetch({
      '/accounts/balance/get': { accounts: [
        { account_id: 'A1', name: 'Checking', official_name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 1200, available: 1100, iso_currency_code: 'USD' } },
        { account_id: 'A2', name: 'Credit', official_name: null, mask: '3333', type: 'credit', subtype: 'credit card', balances: { current: 410, available: null, iso_currency_code: 'USD' } },
      ] },
      '/transactions/sync': () => {
        page++;
        if (page === 1) return { added: [
          { transaction_id: 'T1', account_id: 'A1', date: D(1), name: 'UNITED AIRLINES', merchant_name: 'United Airlines', amount: 500, iso_currency_code: 'USD', personal_finance_category: { primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS' }, category: null, pending: false },
          { transaction_id: 'T2', account_id: 'A1', date: D(2), name: 'ACME PAYROLL', merchant_name: null, amount: -2500, iso_currency_code: 'USD', personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' }, category: null, pending: false },
        ], modified: [], removed: [], next_cursor: 'c1', has_more: true };
        return { added: [
          { transaction_id: 'T3', account_id: 'A2', date: D(1), name: 'SQ *COFFEE', merchant_name: null, amount: 4.5, iso_currency_code: 'USD', personal_finance_category: null, category: null, pending: true },
        ], modified: [], removed: [{ transaction_id: 'T9' }], next_cursor: 'c2', has_more: false };
      },
    });
    const plaid = new PlaidClient({ creds, fetchImpl: fetch });
    store.upsertConnection({ id: 'item1', provider: 'plaid', label: 'Platypus' });
    const r = await syncConnection(store, plaid.provider('tok', 'Platypus'), 'item1');
    assert.deepEqual(r, { accounts: 2, added: 3, modified: 0, removed: 1, holdings: 0 });
    const accts = store.listAccounts();
    assert.equal(accts.find(a => a.id === 'plaid:A2')!.balance, -410);
    assert.equal(accts.find(a => a.id === 'plaid:A1')!.institution, 'Platypus');
    const t1 = store.getTransaction('plaid:T1')!;
    assert.equal(t1.amount, -500);
    assert.equal(t1.category_id, 'travel');
    assert.equal(t1.payee, 'United Airlines');
    assert.equal(store.getTransaction('plaid:T2')!.category_id, 'paycheck');
    assert.equal(store.getTransaction('plaid:T3')!.category_id, 'coffee');  // keyword fallback
    assert.equal(store.getConnection('item1')!.cursor, 'c2');
    assert.equal(store.getConnection('item1')!.status, 'active');
    assert.ok(store.getConnection('item1')!.last_synced_at);
  });
});

describe('SimpleFIN client + provider', () => {
  it('claims a setup token and rejects garbage', async () => {
    const claim = 'https://bridge.example/simplefin/claim/abc';
    const token = Buffer.from(claim).toString('base64');
    const { fetch, calls } = fakeFetch({ '/claim/abc': new Response('https://user:pass@bridge.example/simplefin', { status: 200 }) });
    assert.equal(await claimSetupToken(token, fetch), 'https://user:pass@bridge.example/simplefin');
    assert.equal(calls[0].url, claim);
    await assert.rejects(() => claimSetupToken('not base64 at all!!', fetch), SimpleFinError);
    await assert.rejects(() => claimSetupToken(Buffer.from('http://insecure').toString('base64'), fetch), /https/);
  });

  it('fetches accounts with basic auth over a window and the sync guesses types + categorizes by keyword', async () => {
    const { store } = fresh();
    const { fetch, calls } = fakeFetch({
      '/simplefin/accounts': { errors: [], accounts: [
        { org: { name: 'Example CU', domain: 'cu.example' }, id: 'ACT-1', name: 'Everyday Checking', currency: 'USD', balance: '2500.10', 'available-balance': '2400.00', 'balance-date': unix(0),
          transactions: [
            { id: 'TX1', posted: unix(3), amount: '-54.20', description: 'TRADER JOES #55', payee: 'Trader Joe\'s' },
            { id: 'TX2', posted: unix(5), amount: '1800.00', description: 'ACME CORP PAYROLL', payee: 'ACME' },
            { id: 'TX3', posted: unix(1), amount: '-9.99', description: 'Spotify', pending: true },
          ] },
        { org: { name: 'Example CU' }, id: 'ACT-2', name: 'Rewards Visa', currency: 'USD', balance: '-642.33', 'balance-date': unix(0), transactions: [] },
        { org: { name: 'Broker' }, id: 'ACT-3', name: 'Roth IRA', currency: 'USD', balance: '15000', 'balance-date': unix(0), transactions: [],
          holdings: [{ id: 'H1', created: unix(0), currency: 'USD', cost_basis: '9000', description: 'Total Market ETF', market_value: '15000', purchase_price: '90', shares: '100', symbol: 'VTI' }] },
      ] },
    });
    const client = new SimpleFinClient('https://u%40x:p@bridge.example/simplefin', fetch);
    store.upsertConnection({ id: 'sf1', provider: 'simplefin', label: '' });
    const r = await syncConnection(store, client.provider(), 'sf1');
    assert.deepEqual(r, { accounts: 3, added: 3, modified: 0, removed: 0, holdings: 1 });
    const u = new URL(calls[0].url);
    assert.ok(u.searchParams.get('start-date'));
    assert.equal(u.searchParams.get('pending'), '1');
    assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('u@x:p').toString('base64')}`);
    const accts = store.listAccounts();
    assert.equal(accts.find(a => a.id === 'simplefin:ACT-2')!.type, 'credit');
    assert.equal(accts.find(a => a.id === 'simplefin:ACT-3')!.type, 'investment');
    assert.equal(accts.find(a => a.id === 'simplefin:ACT-1')!.institution, 'Example CU');
    assert.equal(store.getTransaction('simplefin:TX1')!.category_id, 'groceries');
    assert.equal(store.getTransaction('simplefin:TX2')!.category_id, 'paycheck');
    assert.equal(store.getTransaction('simplefin:TX3')!.pending, true);
    assert.equal(store.listHoldings()[0].symbol, 'VTI');
    // second sync overlaps the previous window instead of refetching 400 days
    await syncConnection(store, client.provider(), 'sf1');
    const start2 = Number(new URL(calls[1].url).searchParams.get('start-date'));
    assert.ok(start2 > unix(20));
  });

  it('guessAccountType reads names and falls back on sign', () => {
    assert.equal(guessAccountType('Sapphire Preferred', -100), 'credit');
    assert.equal(guessAccountType('Auto Loan', -9000), 'loan');
    assert.equal(guessAccountType('401k', 5000), 'investment');
    assert.equal(guessAccountType('Savings', 10), 'depository');
    assert.equal(guessAccountType('Mystery', -5), 'credit');
  });
});

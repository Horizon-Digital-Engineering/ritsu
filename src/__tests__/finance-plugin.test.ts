import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb, PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { financePlugin } from '../plugins/finance/plugin.js';
import { FinanceStore } from '../plugins/finance/store.js';

describe('finance plugin registration + agent tools', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db, new SecretStore(db));
    host.register(financePlugin);
    const store = new FinanceStore(new ScopedDb(db, 'finance'));
    return { host, store };
  }

  it('registers with its tables + read-only, fenced tools (never approval-gated)', () => {
    const { host } = setup();
    const m = host.manifests().find(x => x.id === 'finance');
    assert.ok(m);
    assert.ok(m.tables.includes('plugin_finance_accounts'));
    const tools = host.toolsFor('finance');
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, ['budget_status', 'list_accounts', 'net_worth', 'search_transactions', 'spending_report', 'subscriptions']);
    // READ-ONLY: every tool fences its output and none requires approval
    assert.ok(tools.every(t => t.untrustedOutput === true));
    assert.ok(tools.every(t => !t.needsApproval));
  });

  it('net_worth + spending_report read the shared cache', async () => {
    const { host, store } = setup();
    store.upsertItem({ item_id: 'i', institution_name: 'Bank' });
    store.upsertAccount({ account_id: 'a', item_id: 'i', name: 'Checking', official_name: '', type: 'depository', subtype: 'checking', mask: '1234', current_balance: 4000, available_balance: 4000, iso_currency: 'USD' });
    store.upsertAccount({ account_id: 'v', item_id: 'i', name: 'Visa', official_name: '', type: 'credit', subtype: 'credit card', mask: '9999', current_balance: 1000, available_balance: null, iso_currency: 'USD' });
    store.upsertTransaction({ transaction_id: 't1', account_id: 'a', date: new Date().toISOString().slice(0, 10), name: 'Chipotle', merchant_name: 'Chipotle', amount: 25, iso_currency: 'USD', category: 'FOOD', category_detailed: '', pending: false });

    const tools = Object.fromEntries(host.toolsFor('finance').map(t => [t.name, t]));
    const nw = await tools.net_worth.handler({}, { agentId: 'x' });
    assert.match(nw.content[0].text, /Net worth: USD 3000\.00/);   // 4000 assets - 1000 credit
    const sp = await tools.spending_report.handler({ days: 60 }, { agentId: 'x' });
    assert.match(sp.content[0].text, /FOOD: USD 25\.00/);
  });

  const T = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it('empty-state tools report "nothing yet" instead of throwing', async () => {
    const { host } = setup();
    const tools = Object.fromEntries(host.toolsFor('finance').map(t => [t.name, t]));
    for (const [name, re] of [
      ['net_worth', /no accounts/], ['list_accounts', /no accounts/],
      ['subscriptions', /no recurring/], ['budget_status', /no category targets/],
    ] as const) {
      const r = await tools[name].handler({}, { agentId: 'x' });
      assert.match(r.content[0].text, re, name);
    }
    const s = await tools.search_transactions.handler({ query: 'nope' }, { agentId: 'x' });
    assert.match(s.content[0].text, /no matching/);
  });

  it('list_accounts, search_transactions, subscriptions and budget_status render seeded data', async () => {
    const { host, store } = setup();
    store.upsertItem({ item_id: 'i', institution_name: 'Bank' });
    store.upsertAccount({ account_id: 'a', item_id: 'i', name: 'Checking', official_name: '', type: 'depository', subtype: 'checking', mask: '1234', current_balance: 500, available_balance: 500, iso_currency: 'USD' });
    // A monthly recurring charge → detected as a subscription.
    for (let k = 0; k < 4; k++) {
      store.upsertTransaction({ transaction_id: `nf${k}`, account_id: 'a', date: T(30 * k + 1), name: 'Netflix', merchant_name: 'Netflix', amount: 15.99, iso_currency: 'USD', category: 'ENTERTAINMENT', category_detailed: '', pending: false });
    }
    store.upsertTransaction({ transaction_id: 'gr', account_id: 'a', date: T(2), name: 'Whole Foods', merchant_name: 'Whole Foods', amount: 80, iso_currency: 'USD', category: 'GROCERIES', category_detailed: '', pending: false });
    store.setTarget('GROCERIES', 50);   // spent 80 > 50 → OVER

    const tools = Object.fromEntries(host.toolsFor('finance').map(t => [t.name, t]));
    assert.match((await tools.list_accounts.handler({}, { agentId: 'x' })).content[0].text, /Checking ••1234/);
    assert.match((await tools.search_transactions.handler({ query: 'netflix', limit: 5 }, { agentId: 'x' })).content[0].text, /Netflix/);
    assert.match((await tools.subscriptions.handler({}, { agentId: 'x' })).content[0].text, /Netflix/);
    assert.match((await tools.budget_status.handler({}, { agentId: 'x' })).content[0].text, /GROCERIES.*OVER/);
  });
});

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb, PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { financePlugin } from '../plugins/finance/plugin.js';
import { FinanceStore } from '../plugins/finance/store.js';
import { netWorth, netWorthSeries, expandLines, cashFlow, spendByCategory, budgetReport, categoryTrend, upcomingRecurring, goalProgress, lastMonths, monthRange } from '../plugins/finance/report.js';
import { applyRules } from '../plugins/finance/rules.js';
import { detectRecurring, payeeKey } from '../plugins/finance/recurring.js';
import { categorizeByKeyword } from '../plugins/finance/categories.js';

function fresh() {
  const db = openDatabase(':memory:');
  const host = new PluginHost(db, new SecretStore(db));
  host.register(financePlugin);
  return { db, host, store: new FinanceStore(new ScopedDb(db, 'finance', true)) };
}
const D = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const today = () => D(0);

function seedAccounts(store: FinanceStore) {
  store.upsertConnection({ id: 'c1', provider: 'simplefin', label: 'Bank' });
  store.upsertAccount({ id: 'chk', connection_id: 'c1', name: 'Checking', type: 'depository', balance: 4000, balance_as_of: today() });
  store.upsertAccount({ id: 'card', connection_id: 'c1', name: 'Visa', type: 'credit', balance: -1000, balance_as_of: today() });
  store.upsertAccount({ id: 'brk', connection_id: 'c1', name: 'Brokerage', type: 'investment', balance: 10000, balance_as_of: today() });
}

describe('finance store', () => {
  it('migrates with seeded categories and scoped tables only', () => {
    const { host, store } = fresh();
    const m = host.manifests().find(x => x.id === 'finance')!;
    assert.ok(m.tables.includes('plugin_finance_transactions'));
    assert.ok(m.tables.every(t => t.startsWith('plugin_finance_')));
    const cats = store.listCategories();
    assert.ok(cats.length > 30);
    assert.ok(cats.find(c => c.id === 'groceries'));
    assert.equal(store.providerCategoryMap().FOOD_AND_DRINK_GROCERIES, 'groceries');
  });

  it('drops the 0.1.0 cache tables on first boot of the ledger schema', () => {
    const db = openDatabase(':memory:');
    db.exec(`CREATE TABLE plugin_finance_items (item_id TEXT PRIMARY KEY); CREATE TABLE plugin_finance_accounts (account_id TEXT PRIMARY KEY, current_balance REAL)`);
    const host = new PluginHost(db, new SecretStore(db));
    host.register(financePlugin);
    const cols = db.prepare(`SELECT name FROM pragma_table_info('plugin_finance_accounts')`).all() as Array<{ name: string }>;
    assert.ok(cols.some(c => c.name === 'balance'));
    assert.ok(!cols.some(c => c.name === 'current_balance'));
    assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'plugin_finance_items'`).get(), undefined);
  });

  it('upserts accounts, records balance history, and net worth sums signed balances', () => {
    const { store } = fresh();
    seedAccounts(store);
    const nw = netWorth(store.listAccounts());
    assert.equal(nw.assets, 14000);
    assert.equal(nw.liabilities, 1000);
    assert.equal(nw.net, 13000);
    store.setBalance('chk', 4500, today());
    assert.equal(store.balanceHistory(today(), today()).find(h => h.account_id === 'chk')!.balance, 4500);
    // operator-owned fields survive a re-sync
    store.updateAccount('chk', { name: 'Main Checking', type: 'depository', hidden: false });
    store.upsertAccount({ id: 'chk', connection_id: 'c1', name: 'Checking', type: 'depository', balance: 4600, balance_as_of: today() });
    assert.equal(store.getAccount('chk')!.name, 'Main Checking');
    assert.equal(store.getAccount('chk')!.balance, 4600);
  });

  it('hidden accounts leave net worth; deleting an account cascades', () => {
    const { store } = fresh();
    seedAccounts(store);
    store.updateAccount('brk', { hidden: true });
    assert.equal(netWorth(store.listAccounts()).net, 3000);
    store.upsertTransaction({ id: 't1', account_id: 'brk', date: today(), description: 'Buy', amount: -100 });
    store.deleteAccount('brk');
    assert.equal(store.getTransaction('t1'), null);
    assert.equal(store.listAccounts().length, 2);
  });

  it('re-sync keeps operator category and payee edits, provider updates the rest', () => {
    const { store } = fresh();
    seedAccounts(store);
    store.upsertTransaction({ id: 't1', account_id: 'chk', date: today(), description: 'CHIPOTLE 1234', payee: 'Chipotle', amount: -12, category_id: 'restaurants', category_source: 'provider', pending: true });
    store.updateTransaction('t1', { category_id: 'groceries', payee: 'Chipotle (lunch)', notes: 'team lunch', tags: ['Work'] });
    store.upsertTransaction({ id: 't1', account_id: 'chk', date: today(), description: 'CHIPOTLE 1234', payee: 'Chipotle', amount: -12.5, category_id: 'restaurants', category_source: 'provider', pending: false });
    const t = store.getTransaction('t1')!;
    assert.equal(t.category_id, 'groceries');
    assert.equal(t.category_source, 'user');
    assert.equal(t.payee, 'Chipotle (lunch)');
    assert.equal(t.amount, -12.5);
    assert.equal(t.pending, false);
    assert.deepEqual(t.tags, ['work']);
  });

  it('lists with filters, pagination and search; excludes pending and excluded by default', () => {
    const { store } = fresh();
    seedAccounts(store);
    for (let i = 0; i < 5; i++) store.upsertTransaction({ id: `t${i}`, account_id: 'chk', date: D(i), description: `Shop ${i}`, amount: -(10 + i), category_id: 'shopping' });
    store.upsertTransaction({ id: 'p', account_id: 'chk', date: today(), description: 'Pending thing', amount: -5, pending: true });
    store.upsertTransaction({ id: 'x', account_id: 'card', date: today(), description: 'Excluded thing', amount: -5 });
    store.updateTransaction('x', { excluded: true });
    assert.equal(store.listTransactions({}).total, 5);
    assert.equal(store.listTransactions({ include_pending: true, include_excluded: true }).total, 7);
    assert.equal(store.listTransactions({ q: 'Shop 3' }).rows[0].id, 't3');
    const page = store.listTransactions({ limit: 2, offset: 2 });
    assert.equal(page.rows.length, 2);
    assert.equal(page.total, 5);
    assert.equal(store.listTransactions({ account_id: 'card', include_excluded: true }).total, 1);
  });

  it('splits replace the parent category in reporting and must sum to the amount', () => {
    const { store } = fresh();
    seedAccounts(store);
    store.upsertTransaction({ id: 't1', account_id: 'chk', date: today(), description: 'Costco', amount: -100, category_id: 'shopping' });
    store.setSplits('t1', [{ category_id: 'groceries', amount: -70 }, { category_id: 'home_goods', amount: -30 }]);
    const txns = store.ledger(D(1), today());
    const lines = expandLines(txns, store.splitsFor(['t1']));
    const spend = spendByCategory(lines, store.listCategories());
    assert.deepEqual(spend.map(s => [s.category_id, s.total]), [['groceries', 70], ['home_goods', 30]]);
  });

  it('transfer candidates pair opposite amounts across accounts within three days', () => {
    const { store } = fresh();
    seedAccounts(store);
    store.upsertTransaction({ id: 'out', account_id: 'chk', date: D(2), description: 'Payment to Visa', amount: -500 });
    store.upsertTransaction({ id: 'in', account_id: 'card', date: D(1), description: 'Payment received', amount: 500 });
    const [m] = store.transferCandidates(store.getTransaction('out')!);
    assert.equal(m.id, 'in');
    store.setTransferGroup(['out', 'in'], 'tg_1');
    assert.equal(store.getTransaction('in')!.excluded, true);
    assert.equal(store.getTransaction('in')!.category_id, 'transfer');
  });
});

describe('finance reporting', () => {
  it('cash flow separates income and expenses per month and skips transfers', () => {
    const { store } = fresh();
    seedAccounts(store);
    const m = lastMonths(today().slice(0, 7), 2);
    const [prev, cur] = m;
    store.upsertTransaction({ id: 'pay', account_id: 'chk', date: `${cur}-01`, description: 'Payroll', amount: 3000, category_id: 'paycheck' });
    store.upsertTransaction({ id: 'rent', account_id: 'chk', date: `${cur}-02`, description: 'Rent', amount: -1500, category_id: 'rent_mortgage' });
    store.upsertTransaction({ id: 'xfer', account_id: 'chk', date: `${cur}-03`, description: 'To savings', amount: -400, category_id: 'transfer' });
    store.upsertTransaction({ id: 'old', account_id: 'chk', date: `${prev}-15`, description: 'Groceries', amount: -200, category_id: 'groceries' });
    const lines = expandLines(store.ledger(monthRange(prev).from, monthRange(cur).to), new Map());
    const flow = cashFlow(lines, store.listCategories(), m);
    assert.deepEqual(flow.map(f => [f.month, f.income, f.expenses]), [[prev, 0, 200], [cur, 3000, 1500]]);
    assert.equal(flow[1].savings_rate, 0.5);
  });

  it('budget report: per-month override beats default, flags over, totals unbudgeted spend', () => {
    const { store } = fresh();
    seedAccounts(store);
    const cur = today().slice(0, 7);
    store.setBudget('groceries', '*', 500);
    store.setBudget('groceries', cur, 300);
    store.setBudget('restaurants', '*', 200);
    store.setBudget('paycheck', '*', 4000);
    store.upsertTransaction({ id: 'g', account_id: 'chk', date: `${cur}-05`, description: 'Market', amount: -350, category_id: 'groceries' });
    store.upsertTransaction({ id: 'c', account_id: 'chk', date: `${cur}-06`, description: 'Coffee', amount: -20, category_id: 'coffee' });
    store.upsertTransaction({ id: 'p', account_id: 'chk', date: `${cur}-01`, description: 'Pay', amount: 3800, category_id: 'paycheck' });
    const { from, to } = monthRange(cur);
    const r = budgetReport(expandLines(store.ledger(from, to), new Map()), store.listCategories(), store.listBudgets(), cur);
    const g = r.lines.find(l => l.category_id === 'groceries')!;
    assert.equal(g.budget, 300); assert.equal(g.source, 'month'); assert.equal(g.over, true); assert.equal(g.remaining, -50);
    assert.equal(r.lines.find(l => l.category_id === 'restaurants')!.actual, 0);
    assert.equal(r.totals.unbudgeted_expenses, 20);
    assert.equal(r.totals.actual_income, 3800);
    assert.equal(r.totals.budgeted_expenses, 500);
  });

  it('net worth series carries balances forward from the seed', () => {
    const { store } = fresh();
    seedAccounts(store);
    store.recordBalance('chk', D(10), 3000);
    store.recordBalance('card', D(10), -800);
    store.recordBalance('chk', D(3), 3500);
    const from = D(5), to = today();
    const s = netWorthSeries(store.balanceHistory(from, to), store.balancesBefore(from), store.listAccounts(), from, to);
    assert.equal(s[0].date, from);
    assert.equal(s[0].net, 3000 - 800);  // the brokerage has no snapshot before the window, so it joins on its first one
    assert.equal(s.at(-1)!.net, 4000 - 1000 + 10000);
  });

  it('category trend sums expenses as positives and income as signed', () => {
    const { store } = fresh();
    seedAccounts(store);
    const cur = today().slice(0, 7);
    store.upsertTransaction({ id: 'a', account_id: 'chk', date: `${cur}-02`, description: 'a', amount: -40, category_id: 'groceries' });
    store.upsertTransaction({ id: 'b', account_id: 'chk', date: `${cur}-03`, description: 'b', amount: -60, category_id: 'restaurants' });
    const lines = expandLines(store.ledger(`${cur}-01`, monthRange(cur).to), new Map());
    assert.equal(categoryTrend(lines, store.listCategories(), [cur], 'groceries')[0].total, 40);
    assert.equal(categoryTrend(lines, store.listCategories(), [cur], undefined, 'Food & Dining')[0].total, 100);
  });

  it('upcoming recurring + goal progress', () => {
    const { store } = fresh();
    seedAccounts(store);
    store.createRecurring({ display_name: 'Netflix', category_id: 'subscriptions', account_id: null, amount: -15.49, cadence: 'monthly', next_date: D(-5) });
    store.createRecurring({ display_name: 'Far away', category_id: null, account_id: null, amount: -100, cadence: 'yearly', next_date: D(-200) });
    const up = upcomingRecurring(store.listRecurring(), today(), 30);
    assert.deepEqual(up.map(u => u.display_name), ['Netflix']);
    assert.equal(up[0].days_until, 5);
    const g = store.createGoal({ name: 'Cushion', kind: 'save', target_amount: 8000, target_date: null, account_ids: ['chk'], start_balance: null });
    const p = goalProgress(g, store.listAccounts(), today());
    assert.equal(p.current, 4000); assert.equal(p.progress, 0.5); assert.equal(p.remaining, 4000);
    const pay = store.createGoal({ name: 'Kill card', kind: 'payoff', target_amount: 1000, target_date: null, account_ids: ['card'], start_balance: -1000 });
    store.setBalance('card', -400, today());
    assert.equal(goalProgress(pay, store.listAccounts(), today()).current, 600);
  });
});

describe('rules, keywords, recurring detection', () => {
  const txn = (over: Partial<Parameters<typeof applyRules>[1]>) => ({
    id: 'x', account_id: 'chk', date: today(), description: 'AMAZON MKTPL*1234', payee: 'Amazon', amount: -42, currency: 'USD', category_id: null,
    category_source: 'none', provider_category: '', pending: false, notes: '', reviewed: false, excluded: false, transfer_group: null,
    source: 'sync', created_at: 0, updated_at: 0, tags: [], ...over,
  });
  const rule = (over: Partial<Parameters<typeof applyRules>[0][number]>) => ({
    id: 1, priority: 100, enabled: true, field: 'any', op: 'contains', pattern: 'amazon', amount_min: null, amount_max: null,
    account_id: null, set_category_id: 'shopping', set_payee: null, set_excluded: null, set_tags: [], created_at: 0, ...over,
  });

  it('first rule by priority wins per field; amount and account bounds apply', () => {
    const rules = [rule({ id: 2, priority: 10, pattern: 'amazon', set_category_id: 'electronics', amount_min: 100 }), rule({ id: 1, set_payee: 'Amazon', set_tags: ['online'] })];
    const e = applyRules(rules, txn({}))!;
    assert.equal(e.category_id, 'shopping');
    assert.equal(e.payee, 'Amazon');
    assert.deepEqual(e.tags, ['online']);
    assert.equal(applyRules(rules, txn({ amount: -150 }))!.category_id, 'electronics');
    assert.equal(applyRules([rule({ account_id: 'card' })], txn({})), null);
    assert.equal(applyRules([rule({ op: 'equals', field: 'payee', pattern: 'amazon' })], txn({}))!.category_id, 'shopping');
    assert.equal(applyRules([rule({ enabled: false })], txn({})), null);
  });

  it('keyword categorizer covers the obvious merchants and falls through to null', () => {
    assert.equal(categorizeByKeyword('NETFLIX.COM'), 'subscriptions');
    assert.equal(categorizeByKeyword('TRADER JOES #123'), 'groceries');
    assert.equal(categorizeByKeyword('ACME PAYROLL DIRECT DEP'), 'paycheck');
    assert.equal(categorizeByKeyword('zzz unknown vendor'), null);
  });

  it('detects monthly and biweekly patterns, ignores one-offs and irregular amounts', () => {
    const rows: ReturnType<typeof txn>[] = [];
    const mk = (id: string, daysAgo: number, amount: number, payee: string) => rows.push(txn({ id, date: D(daysAgo), amount, payee, description: payee }));
    mk('n1', 95, -15.49, 'Netflix'); mk('n2', 65, -15.49, 'NETFLIX.COM'); mk('n3', 34, -15.99, 'Netflix'); mk('n4', 4, -15.99, 'Netflix');
    mk('g1', 70, -120, 'Gym'); mk('g2', 56, -120, 'Gym'); mk('g3', 42, -120, 'Gym'); mk('g4', 28, -120, 'Gym'); mk('g5', 14, -120, 'Gym');
    mk('r1', 60, -80, 'Restaurant'); mk('r2', 30, -300, 'Restaurant');
    mk('o1', 10, -999, 'Once');
    const det = detectRecurring(rows, today());
    const names = det.map(d => d.display_name).sort();
    assert.deepEqual(names, ['Gym', 'Netflix']);
    const nf = det.find(d => d.display_name === 'Netflix')!;
    assert.equal(nf.cadence, 'monthly');
    assert.equal(nf.occurrences, 4);
    assert.ok(nf.next_date >= today());
    assert.equal(det.find(d => d.display_name === 'Gym')!.cadence, 'biweekly');
  });

  it('payee keys normalize noise', () => {
    assert.equal(payeeKey('NETFLIX.COM 866-579-7172'), 'netflix');
    assert.equal(payeeKey('Netflix'), 'netflix');
    assert.equal(payeeKey('AMAZON MKTPL*2K4L9 Amzn.com/bill WA'), 'amazon amzn bill');
  });
});

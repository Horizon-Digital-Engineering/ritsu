import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb } from '../plugins/host.js';
import { migrate } from '../plugins/finance/migrate.js';
import { FinanceStore, type Transaction } from '../plugins/finance/store.js';
import {
  netWorth, spendByCategory, spendByMonth, topMerchants, detectSubscriptions, budgetStatus, inMonth,
} from '../plugins/finance/report.js';

function store(): FinanceStore {
  const db = new ScopedDb(openDatabase(':memory:'), 'finance');
  migrate(db);
  return new FinanceStore(db);
}

const txn = (o: Partial<Transaction> & { transaction_id: string; date: string; amount: number }): Omit<Transaction, 'updated_at'> => ({
  account_id: 'acc1', name: o.name ?? 'x', merchant_name: o.merchant_name ?? '', iso_currency: 'USD',
  category: o.category ?? 'General', category_detailed: '', pending: o.pending ?? false, ...o,
});

describe('FinanceStore', () => {
  let s: FinanceStore;
  beforeEach(() => { s = store(); });

  it('upserts accounts and lists them', () => {
    s.upsertItem({ item_id: 'i1', institution_name: 'Test Bank' });
    s.upsertAccount({ account_id: 'a1', item_id: 'i1', name: 'Checking', official_name: '', type: 'depository', subtype: 'checking', mask: '0000', current_balance: 1200, available_balance: 1200, iso_currency: 'USD' });
    const accts = s.listAccounts();
    assert.equal(accts.length, 1);
    assert.equal(accts[0].current_balance, 1200);
  });

  it('deleteItem cascades to accounts + transactions', () => {
    s.upsertItem({ item_id: 'i1', institution_name: 'B' });
    s.upsertAccount({ account_id: 'a1', item_id: 'i1', name: 'C', official_name: '', type: 'depository', subtype: 'checking', mask: '0', current_balance: 1, available_balance: 1, iso_currency: 'USD' });
    s.upsertTransaction(txn({ transaction_id: 't1', date: '2026-07-01', amount: 5, account_id: 'a1' }));
    s.deleteItem('i1');
    assert.equal(s.listAccounts().length, 0);
    assert.equal(s.transactionsSince('2000-01-01').length, 0);
  });

  it('search + since exclude pending by default', () => {
    s.upsertTransaction(txn({ transaction_id: 't1', date: '2026-07-01', amount: 10, merchant_name: 'Coffee Co' }));
    s.upsertTransaction(txn({ transaction_id: 't2', date: '2026-07-02', amount: 3, merchant_name: 'Coffee Co', pending: true }));
    assert.equal(s.transactionsSince('2026-07-01').length, 1);
    assert.equal(s.transactionsSince('2026-07-01', true).length, 2);
    assert.equal(s.searchTransactions('coffee').length, 2);
  });
});

describe('finance reporting', () => {
  it('net worth = assets - liabilities, grouped by type', () => {
    const accounts = [
      { account_id: 'a', item_id: 'i', name: 'Checking', official_name: '', type: 'depository', subtype: 'checking', mask: '', current_balance: 5000, available_balance: 5000, iso_currency: 'USD', updated_at: 0 },
      { account_id: 'b', item_id: 'i', name: 'Brokerage', official_name: '', type: 'investment', subtype: '', mask: '', current_balance: 20000, available_balance: null, iso_currency: 'USD', updated_at: 0 },
      { account_id: 'c', item_id: 'i', name: 'Visa', official_name: '', type: 'credit', subtype: 'credit card', mask: '', current_balance: 1500, available_balance: null, iso_currency: 'USD', updated_at: 0 },
    ];
    const nw = netWorth(accounts);
    assert.equal(nw.assets, 25000);
    assert.equal(nw.liabilities, 1500);
    assert.equal(nw.net, 23500);
    assert.equal(nw.byType.find(t => t.type === 'credit')?.total, 1500);
  });

  it('spend rolls up by category and month, income excluded', () => {
    const txns: Transaction[] = [
      { transaction_id: '1', account_id: 'a', date: '2026-07-03', name: 'Chipotle', merchant_name: 'Chipotle', amount: 14, iso_currency: 'USD', category: 'Food', category_detailed: '', pending: false, updated_at: 0 },
      { transaction_id: '2', account_id: 'a', date: '2026-07-10', name: 'Chipotle', merchant_name: 'Chipotle', amount: 16, iso_currency: 'USD', category: 'Food', category_detailed: '', pending: false, updated_at: 0 },
      { transaction_id: '3', account_id: 'a', date: '2026-07-05', name: 'Shell', merchant_name: 'Shell', amount: 40, iso_currency: 'USD', category: 'Gas', category_detailed: '', pending: false, updated_at: 0 },
      { transaction_id: '4', account_id: 'a', date: '2026-06-15', name: 'Paycheck', merchant_name: '', amount: -2000, iso_currency: 'USD', category: 'Income', category_detailed: '', pending: false, updated_at: 0 },
    ];
    const byCat = spendByCategory(txns);
    assert.equal(byCat[0].category, 'Gas');   // 40 highest
    assert.equal(byCat.find(c => c.category === 'Food')?.total, 30);
    assert.equal(byCat.find(c => c.category === 'Income'), undefined); // income not spend
    const byMonth = spendByMonth(txns);
    assert.equal(byMonth.find(m => m.month === '2026-07')?.total, 70);
    assert.equal(topMerchants(txns, 1)[0].merchant, 'Shell'); // Shell 40 > Chipotle 30
  });

  it('detects a monthly subscription, ignores one-offs', () => {
    const netflix: Transaction[] = ['2026-05-04', '2026-06-04', '2026-07-04'].map((d, i) => ({
      transaction_id: `n${i}`, account_id: 'a', date: d, name: 'Netflix', merchant_name: 'Netflix',
      amount: 15.99, iso_currency: 'USD', category: 'Entertainment', category_detailed: '', pending: false, updated_at: 0,
    }));
    const oneoff: Transaction = { transaction_id: 'z', account_id: 'a', date: '2026-07-01', name: 'Best Buy', merchant_name: 'Best Buy', amount: 300, iso_currency: 'USD', category: 'Shopping', category_detailed: '', pending: false, updated_at: 0 };
    const subs = detectSubscriptions([...netflix, oneoff]);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].merchant, 'Netflix');
    assert.equal(subs[0].cadence, 'monthly');
  });

  it('budget status flags over/under for the month', () => {
    const july: Transaction[] = [
      { transaction_id: '1', account_id: 'a', date: '2026-07-03', name: 'x', merchant_name: '', amount: 520, iso_currency: 'USD', category: 'Food', category_detailed: '', pending: false, updated_at: 0 },
      { transaction_id: '2', account_id: 'a', date: '2026-07-04', name: 'y', merchant_name: '', amount: 100, iso_currency: 'USD', category: 'Gas', category_detailed: '', pending: false, updated_at: 0 },
    ];
    const lines = budgetStatus(spendByCategory(inMonth(july, '2026-07')), [
      { category: 'Food', monthly_limit: 400, updated_at: 0 },
      { category: 'Gas', monthly_limit: 200, updated_at: 0 },
    ]);
    const food = lines.find(l => l.category === 'Food')!;
    assert.equal(food.over, true);
    assert.equal(food.remaining, -120);
    assert.equal(lines.find(l => l.category === 'Gas')!.over, false);
  });
});

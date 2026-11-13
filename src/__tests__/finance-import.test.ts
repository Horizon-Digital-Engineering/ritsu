import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb, PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { financePlugin } from '../plugins/finance/plugin.js';
import { FinanceStore } from '../plugins/finance/store.js';
import { parseCsv, detectColumns, parseAmount, parseDate } from '../plugins/finance/import/csv.js';
import { parseOfx } from '../plugins/finance/import/ofx.js';
import { parseImport, previewImport, commitImport, detectFormat } from '../plugins/finance/import/index.js';

function fresh() {
  const db = openDatabase(':memory:');
  const host = new PluginHost(db, new SecretStore(db));
  host.register(financePlugin);
  const store = new FinanceStore(new ScopedDb(db, 'finance', true));
  store.upsertAccount({ id: 'manual:1', connection_id: null, name: 'Imported Checking', type: 'depository', balance: 0, balance_as_of: '2026-01-01' });
  return { store };
}

const CHASE_CSV = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
01/15/2026,01/16/2026,TRADER JOE'S #123,Groceries,Sale,-54.20,
01/14/2026,01/15/2026,"NETFLIX.COM, INC",Entertainment,Sale,-15.49,
01/13/2026,01/13/2026,Payment Thank You-Mobile,,Payment,500.00,
`;
const DEBIT_CREDIT_CSV = `Date,Description,Debit,Credit,Balance
2026-02-01,ACME PAYROLL,,1800.00,2500.00
2026-02-02,SHELL OIL 123,45.10,,2454.90
`;
const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><BANKID>123456789<ACCTID>987654321<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260101<DTEND>20260131
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105120000[-5:EST]<TRNAMT>-23.45<FITID>2026010500001<NAME>STARBUCKS STORE 1<MEMO>Card purchase</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260110<TRNAMT>1,200.00<FITID>2026011000002<NAME>DIRECT DEP ACME</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>3456.78<DTASOF>20260131</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('csv primitives', () => {
  it('parses quotes, embedded commas and CRLF', () => {
    const rows = parseCsv('a,b,c\r\n1,"x, y","he said ""hi"""\r\n');
    assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'he said "hi"']]);
  });
  it('detects columns across common bank headers', () => {
    const c = detectColumns(['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo']);
    assert.equal(c.date, 0); assert.equal(c.description, 2); assert.equal(c.amount, 5); assert.equal(c.category, 3); assert.equal(c.memo, 6);
    const d = detectColumns(['Date', 'Description', 'Debit', 'Credit', 'Balance']);
    assert.equal(d.amount, -1); assert.equal(d.debit, 2); assert.equal(d.credit, 3);
  });
  it('amounts and dates in the usual shapes', () => {
    assert.equal(parseAmount('$1,234.56'), 1234.56);
    assert.equal(parseAmount('(45.10)'), -45.1);
    assert.equal(parseAmount('-12'), -12);
    assert.equal(parseAmount(''), null);
    assert.equal(parseDate('01/15/2026'), '2026-01-15');
    assert.equal(parseDate('2026-01-15T00:00:00'), '2026-01-15');
    assert.equal(parseDate('20260115120000[-5:EST]'), '2026-01-15');
    assert.equal(parseDate('Jan 5, 2026'), '2026-01-05');
    assert.equal(parseDate('nope'), null);
  });
});

describe('ofx parser', () => {
  it('reads SGML statements with unclosed tags', () => {
    const [s] = parseOfx(OFX);
    assert.equal(s.account_id, '987654321');
    assert.equal(s.account_type, 'checking');
    assert.equal(s.balance, 3456.78);
    assert.equal(s.transactions.length, 2);
    assert.deepEqual(s.transactions[0], { fitid: '2026010500001', date: '2026-01-05', amount: -23.45, name: 'STARBUCKS STORE 1', memo: 'Card purchase', type: 'DEBIT' });
    assert.equal(s.transactions[1].amount, 1200);
  });
  it('format detection prefers the extension, then the header', () => {
    assert.equal(detectFormat(OFX, 'x.txt'), 'ofx');
    assert.equal(detectFormat(CHASE_CSV, 'card.csv'), 'csv');
    assert.equal(detectFormat('a,b', 'stmt.qfx'), 'ofx');
  });
});

describe('import pipeline', () => {
  it('parses a card CSV, previews duplicates, commits once, categorizes, and undoes', () => {
    const { store } = fresh();
    const p = parseImport(CHASE_CSV, 'chase.csv');
    assert.equal(p.rows.length, 3);
    assert.equal(p.rows[0].amount, -54.2);
    assert.equal(p.rows[1].payee, 'NETFLIX.COM, INC');
    const pre = previewImport(store, 'manual:1', CHASE_CSV, 'chase.csv');
    assert.equal(pre.total, 3); assert.equal(pre.duplicates, 0);
    const r = commitImport(store, 'manual:1', CHASE_CSV, 'chase.csv');
    assert.equal(r.added, 3);
    const rows = store.listTransactions({ include_excluded: true }).rows;
    assert.equal(rows.length, 3);
    const tj = rows.find(t => t.payee.startsWith('TRADER'))!;
    assert.equal(tj.category_id, 'groceries');            // CSV hint "Groceries" matched a category name
    assert.equal(tj.category_source, 'import');
    assert.equal(rows.find(t => t.payee.startsWith('NETFLIX'))!.category_id, 'entertainment');   // the file's own category wins over the keyword guess
    assert.equal(rows.find(t => t.payee.startsWith('Payment'))!.category_id, 'credit_card_payment');  // keyword
    // the same file again is all duplicates
    const again = commitImport(store, 'manual:1', CHASE_CSV, 'chase.csv');
    assert.equal(again.added, 0); assert.equal(again.duplicates, 3);
    assert.equal(store.listImports()[1].rows_added, 3);
    assert.equal(store.deleteImport(r.import_id), 3);
    assert.equal(store.listTransactions({ include_excluded: true }).total, 0);
  });

  it('debit/credit columns and sign flip', () => {
    const { store } = fresh();
    const p = parseImport(DEBIT_CREDIT_CSV, 'bank.csv');
    assert.deepEqual(p.rows.map(r => r.amount), [1800, -45.1]);
    const flipped = parseImport(DEBIT_CREDIT_CSV, 'bank.csv', { flip_sign: true });
    assert.deepEqual(flipped.rows.map(r => r.amount), [-1800, 45.1]);
    const r = commitImport(store, 'manual:1', DEBIT_CREDIT_CSV, 'bank.csv');
    assert.equal(r.added, 2);
    assert.equal(store.listTransactions({}).rows.find(t => t.payee.includes('SHELL'))!.category_id, 'gas');
  });

  it('OFX rows carry FITIDs so re-import is idempotent even if the description changes', () => {
    const { store } = fresh();
    assert.equal(commitImport(store, 'manual:1', OFX, 'stmt.qfx').added, 2);
    const changed = OFX.replace('STARBUCKS STORE 1', 'STARBUCKS STORE 1 NEW');
    const r = commitImport(store, 'manual:1', changed, 'stmt.qfx');
    assert.equal(r.added, 0); assert.equal(r.duplicates, 2);
    assert.equal(store.getTransaction('ofx:manual:1:2026010500001')!.category_id, 'coffee');
  });

  it('column overrides and headerless files', () => {
    const { store } = fresh();
    const headerless = '2026-03-01,Lunch,-12.00\n2026-03-02,Refund,30.00\n';
    const p = parseImport(headerless, 'x.csv');
    assert.equal(p.rows.length, 2);
    assert.equal(p.rows[0].payee, 'Lunch');
    const weird = 'When,What,How much\n2026-03-03,Thing,-1.00\n';
    const q = parseImport(weird, 'y.csv', { columns: { date: 0, description: 1, amount: 2 } });
    assert.equal(q.rows.length, 1);
    assert.equal(previewImport(store, 'manual:1', weird, 'y.csv', { columns: { date: 0, description: 1, amount: 2 } }).total, 1);
  });
});

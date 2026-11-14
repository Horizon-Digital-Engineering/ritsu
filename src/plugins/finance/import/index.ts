/**
 * File import into one account: CSV (any bank's export, columns auto-detected
 * and overridable) or OFX/QFX. Preview first, commit second — the same
 * confirm-before-write shape as the ingestion pipeline. Rows already in the
 * ledger (by provider id, FITID, or fingerprint) are skipped, so re-importing
 * an overlapping statement is safe.
 */
import { createHash } from 'node:crypto';
import type { FinanceStore } from '../store.js';
import { fingerprint } from '../store.js';
import { parseCsv, detectColumns, parseAmount, parseDate, type ColumnMap } from './csv.js';
import { parseOfx } from './ofx.js';
import { categorizeByKeyword } from '../categories.js';
import { enrichNew, refreshRecurring } from '../sync.js';

export interface ImportRow { ext_id: string | null; date: string; description: string; payee: string; amount: number; category_hint: string; memo: string }
export interface ImportOptions { flip_sign?: boolean; columns?: Partial<ColumnMap>; has_header?: boolean }
export interface AccountHint { account_id: string; type: string; balance: number | null }
export interface ParsedImport { format: 'csv' | 'ofx'; rows: ImportRow[]; skipped: number; columns?: ColumnMap; header?: string[]; account_hint?: AccountHint }
export interface ImportPreview extends ParsedImport { total: number; duplicates: number }

export function detectFormat(text: string, filename = ''): 'csv' | 'ofx' {
  if (/\.(ofx|qfx|qbo)$/i.test(filename)) return 'ofx';
  if (/OFXHEADER|<OFX>/i.test(text.slice(0, 2000))) return 'ofx';
  return 'csv';
}

export function parseImport(text: string, filename: string, opts: ImportOptions = {}): ParsedImport {
  return detectFormat(text, filename) === 'ofx' ? parseOfxImport(text, !!opts.flip_sign) : parseCsvImport(text, opts);
}

function parseOfxImport(text: string, flip: boolean): ParsedImport {
  const stmts = parseOfx(text);
  const rows = stmts.flatMap(s => s.transactions.map((t): ImportRow => ({
    ext_id: t.fitid, date: t.date, description: [t.name, t.memo].filter(Boolean).join(' '), payee: t.name || t.memo,
    amount: flip ? -t.amount : t.amount, category_hint: '', memo: t.memo,
  })));
  const first = stmts[0];
  return { format: 'ofx', rows, skipped: 0, account_hint: first ? { account_id: first.account_id, type: first.account_type, balance: first.balance } : undefined };
}

const NO_HEADER_COLUMNS: ColumnMap = { date: 0, description: 1, amount: 2, debit: -1, credit: -1, payee: -1, category: -1, memo: -1 };

function parseCsvImport(text: string, opts: ImportOptions): ParsedImport {
  const table = parseCsv(text);
  if (!table.length) return { format: 'csv', rows: [], skipped: 0 };
  const hasHeader = opts.has_header ?? looksLikeHeader(table[0]);
  const header = hasHeader ? table[0] : table[0].map((_, i) => `column ${i + 1}`);
  const columns: ColumnMap = { ...(hasHeader ? detectColumns(header) : NO_HEADER_COLUMNS), ...opts.columns };
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const cells of table.slice(hasHeader ? 1 : 0)) {
    const row = csvRow(cells, columns, !!opts.flip_sign);
    if (row) rows.push(row); else skipped++;
  }
  return { format: 'csv', rows, skipped, columns, header };
}

/** Empty when the column is unmapped (-1) or the row is short. */
const cellAt = (cells: string[], col: number): string => col >= 0 ? (cells[col] ?? '') : '';

function csvAmount(cells: string[], columns: ColumnMap): number | null {
  const amount = parseAmount(cellAt(cells, columns.amount));
  if (amount != null) return amount;
  const d = parseAmount(cellAt(cells, columns.debit));
  const c = parseAmount(cellAt(cells, columns.credit));
  if (d == null && c == null) return null;
  return (c ?? 0) - Math.abs(d ?? 0);
}

function csvRow(cells: string[], columns: ColumnMap, flip: boolean): ImportRow | null {
  const date = parseDate(cellAt(cells, columns.date));
  const amount = csvAmount(cells, columns);
  if (!date || amount == null) return null;
  const description = cellAt(cells, columns.description).trim();
  const payee = cellAt(cells, columns.payee).trim() || description;
  return {
    ext_id: null, date, description: description || payee, payee, amount: flip ? -amount : amount,
    category_hint: cellAt(cells, columns.category).trim(), memo: cellAt(cells, columns.memo).trim(),
  };
}

function looksLikeHeader(cells: string[]): boolean {
  return cells.some(c => /date|amount|desc|payee|memo|debit|credit/i.test(c)) && !cells.some(c => parseDate(c) !== null && /^\d/.test(c.trim()));
}

const rowId = (accountId: string, r: ImportRow): string => {
  if (r.ext_id) return `ofx:${accountId}:${r.ext_id}`;
  const digest = createHash('sha256').update(`${accountId}|${r.date}|${r.amount.toFixed(2)}|${r.description}|${r.payee}`).digest('hex');
  return `csv:${digest.slice(0, 24)}`;
};

const inLedger = (store: FinanceStore, accountId: string, id: string, r: ImportRow): boolean =>
  store.hasTransaction(id) || store.hasFingerprint(accountId, fingerprint(accountId, r.date, r.amount, r.description));

function categorySource(hinted: string | null, cat: string | null): 'import' | 'provider' | 'none' {
  if (hinted) return 'import';
  return cat ? 'provider' : 'none';
}

export function previewImport(store: FinanceStore, accountId: string, text: string, filename: string, opts: ImportOptions = {}): ImportPreview {
  const p = parseImport(text, filename, opts);
  const duplicates = p.rows.filter(r => inLedger(store, accountId, rowId(accountId, r), r)).length;
  return { ...p, rows: p.rows.slice(0, 25), total: p.rows.length, duplicates };
}

export function commitImport(store: FinanceStore, accountId: string, text: string, filename: string, opts: ImportOptions = {}): { import_id: number; added: number; duplicates: number; skipped: number } {
  const p = parseImport(text, filename, opts);
  const categories = new Map(store.listCategories(true).map(c => [c.name.toLowerCase(), c.id]));
  const rules = store.listRules();
  let added = 0, duplicates = 0;
  const importId = store.recordImport({ filename, format: p.format, account_id: accountId, rows_total: p.rows.length, rows_added: 0, rows_duplicate: 0 });
  store.transaction(() => {
    const seen = new Set<string>();
    for (const r of p.rows) {
      const id = rowId(accountId, r);
      // `seen` catches repeats inside this file; the store checks are per row so an earlier insert in this transaction counts too.
      if (seen.has(id) || inLedger(store, accountId, id, r)) { duplicates++; continue; }
      seen.add(id);
      const hinted = r.category_hint ? categories.get(r.category_hint.toLowerCase()) ?? null : null;
      const cat = hinted ?? categorizeByKeyword(`${r.payee} ${r.description}`);
      store.upsertTransaction({
        id, account_id: accountId, date: r.date, description: r.description, payee: r.payee, amount: r.amount,
        category_id: cat, category_source: categorySource(hinted, cat), provider_category: r.category_hint,
        source: 'import', import_id: importId,
      });
      const t = store.getTransaction(id);
      if (t) enrichNew(store, rules, t);
      added++;
    }
  });
  store.setImportCounts(importId, added, duplicates);
  refreshRecurring(store);
  return { import_id: importId, added, duplicates, skipped: p.skipped };
}

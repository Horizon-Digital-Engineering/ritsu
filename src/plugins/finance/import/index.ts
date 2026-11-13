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
export interface ImportPreview {
  format: 'csv' | 'ofx'; rows: ImportRow[]; total: number; duplicates: number; skipped: number;
  columns?: ColumnMap; header?: string[]; account_hint?: { account_id: string; type: string; balance: number | null };
}

export function detectFormat(text: string, filename = ''): 'csv' | 'ofx' {
  if (/\.(ofx|qfx|qbo)$/i.test(filename)) return 'ofx';
  if (/OFXHEADER|<OFX>/i.test(text.slice(0, 2000))) return 'ofx';
  return 'csv';
}

export function parseImport(text: string, filename: string, opts: ImportOptions = {}): { format: 'csv' | 'ofx'; rows: ImportRow[]; skipped: number; columns?: ColumnMap; header?: string[]; account_hint?: ImportPreview['account_hint'] } {
  if (detectFormat(text, filename) === 'ofx') {
    const stmts = parseOfx(text);
    const rows: ImportRow[] = [];
    for (const s of stmts) {
      for (const t of s.transactions) {
        rows.push({ ext_id: t.fitid, date: t.date, description: [t.name, t.memo].filter(Boolean).join(' '), payee: t.name || t.memo, amount: opts.flip_sign ? -t.amount : t.amount, category_hint: '', memo: t.memo });
      }
    }
    const first = stmts[0];
    return { format: 'ofx', rows, skipped: 0, account_hint: first ? { account_id: first.account_id, type: first.account_type, balance: first.balance } : undefined };
  }
  const table = parseCsv(text);
  if (!table.length) return { format: 'csv', rows: [], skipped: 0 };
  const hasHeader = opts.has_header ?? looksLikeHeader(table[0]);
  const header = hasHeader ? table[0] : table[0].map((_, i) => `column ${i + 1}`);
  const columns: ColumnMap = { ...(hasHeader ? detectColumns(header) : { date: 0, description: 1, amount: 2, debit: -1, credit: -1, payee: -1, category: -1, memo: -1 }), ...(opts.columns ?? {}) };
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const cells of table.slice(hasHeader ? 1 : 0)) {
    const date = columns.date >= 0 ? parseDate(cells[columns.date] ?? '') : null;
    let amount: number | null = null;
    if (columns.amount >= 0) amount = parseAmount(cells[columns.amount] ?? '');
    if (amount == null && (columns.debit >= 0 || columns.credit >= 0)) {
      const d = columns.debit >= 0 ? parseAmount(cells[columns.debit] ?? '') : null;
      const c = columns.credit >= 0 ? parseAmount(cells[columns.credit] ?? '') : null;
      if (d != null || c != null) amount = (c ?? 0) - Math.abs(d ?? 0);
    }
    if (!date || amount == null) { skipped++; continue; }
    const description = (columns.description >= 0 ? cells[columns.description] : '')?.trim() ?? '';
    const payee = (columns.payee >= 0 ? cells[columns.payee] : '')?.trim() || description;
    rows.push({
      ext_id: null, date, description: description || payee, payee, amount: opts.flip_sign ? -amount : amount,
      category_hint: columns.category >= 0 ? (cells[columns.category] ?? '').trim() : '',
      memo: columns.memo >= 0 ? (cells[columns.memo] ?? '').trim() : '',
    });
  }
  return { format: 'csv', rows, skipped, columns, header };
}

function looksLikeHeader(cells: string[]): boolean {
  return cells.some(c => /date|amount|desc|payee|memo|debit|credit/i.test(c)) && !cells.some(c => parseDate(c) !== null && /^\d/.test(c.trim()));
}

const rowId = (accountId: string, r: ImportRow) =>
  r.ext_id ? `ofx:${accountId}:${r.ext_id}` : `csv:${createHash('sha256').update(`${accountId}|${r.date}|${r.amount.toFixed(2)}|${r.description}|${r.payee}`).digest('hex').slice(0, 24)}`;

export function previewImport(store: FinanceStore, accountId: string, text: string, filename: string, opts: ImportOptions = {}): ImportPreview {
  const p = parseImport(text, filename, opts);
  let duplicates = 0;
  for (const r of p.rows) {
    if (store.hasTransaction(rowId(accountId, r)) || store.hasFingerprint(accountId, fingerprint(accountId, r.date, r.amount, r.description))) duplicates++;
  }
  return { format: p.format, rows: p.rows.slice(0, 25), total: p.rows.length, duplicates, skipped: p.skipped, columns: p.columns, header: p.header, account_hint: p.account_hint };
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
      const fp = fingerprint(accountId, r.date, r.amount, r.description);
      if (seen.has(id) || store.hasTransaction(id) || store.hasFingerprint(accountId, fp)) { duplicates++; continue; }
      seen.add(id);
      const hinted = r.category_hint ? categories.get(r.category_hint.toLowerCase()) ?? null : null;
      const cat = hinted ?? categorizeByKeyword(`${r.payee} ${r.description}`);
      store.upsertTransaction({
        id, account_id: accountId, date: r.date, description: r.description, payee: r.payee, amount: r.amount,
        category_id: cat, category_source: hinted ? 'import' : cat ? 'provider' : 'none', provider_category: r.category_hint,
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

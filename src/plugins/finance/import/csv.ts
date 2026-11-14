/** RFC-4180-ish CSV: quoted fields, doubled quotes, CRLF. Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const scan = new CsvScanner();
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) if (scan.feed(src[i], src[i + 1])) i++;
  scan.endRow();
  return scan.rows;
}

/** Rows whose cells are all blank are dropped. */
class CsvScanner {
  readonly rows: string[][] = [];
  private row: string[] = [];
  private cell = '';
  private inQ = false;

  /** Consumes one char; true when the next char was consumed with it. */
  feed(ch: string, next: string | undefined): boolean {
    return this.inQ ? this.quoted(ch, next) : this.plain(ch, next);
  }

  private quoted(ch: string, next: string | undefined): boolean {
    if (ch !== '"') { this.cell += ch; return false; }
    if (next === '"') { this.cell += '"'; return true; }
    this.inQ = false;
    return false;
  }

  private plain(ch: string, next: string | undefined): boolean {
    if (ch === '"') this.inQ = true;
    else if (ch === ',') this.endCell();
    else if (ch === '\n' || ch === '\r') { this.endRow(); return ch === '\r' && next === '\n'; }
    else this.cell += ch;
    return false;
  }

  private endCell(): void { this.row.push(this.cell); this.cell = ''; }

  endRow(): void {
    this.endCell();
    if (this.row.some(c => c.trim() !== '')) this.rows.push(this.row);
    this.row = [];
  }
}

export interface ColumnMap { date: number; description: number; amount: number; debit: number; credit: number; payee: number; category: number; memo: number }

const find = (header: string[], ...names: RegExp[]): number => {
  for (const re of names) { const i = header.findIndex(h => re.test(h)); if (i >= 0) return i; }
  return -1;
};

/** Guess which column is which from a header row. Any index may be -1. */
export function detectColumns(header: string[]): ColumnMap {
  const h = header.map(x => x.trim().toLowerCase());
  return {
    date: find(h, /^(transaction |posting |posted |trans )?date$/, /date/),
    description: find(h, /^description$/, /^original description$/, /^transaction$/, /descr|details|narrative|name/),
    amount: find(h, /^amount$/, /^amount \(usd\)$/, /amount/),
    debit: find(h, /^debit$/, /withdrawal|outflow|debit/),
    credit: find(h, /^credit$/, /deposit|inflow|credit/),
    payee: find(h, /^payee$/, /^merchant$/, /payee|merchant/),
    category: find(h, /^category$/, /category/),
    memo: find(h, /^memo$/, /^notes?$/, /memo|note/),
  };
}

export function parseAmount(s: string): number | null {
  let t = s.trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\bdr$/i.test(t)) { neg = true; }
  if (/\bcr$/i.test(t)) { neg = false; }
  t = t.replace(/[^0-9.-]/g, '');
  if (!t || t === '-' || t === '.') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

/** Accepts ISO, US (M/D/Y), compact (YYYYMMDD[...]) and "Jan 5, 2024". Returns YYYY-MM-DD or null. */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return iso(y, +m[1], +m[2]); }
  m = /^(\d{4})(\d{2})(\d{2})/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(t);
  if (m) return iso(+m[3], +m[2], +m[1]);
  const d = new Date(t);
  if (!Number.isNaN(d.getTime()) && /[a-z]/i.test(t)) return d.toISOString().slice(0, 10);
  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

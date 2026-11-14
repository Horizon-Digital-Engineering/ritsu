/**
 * Property value from a public price index. Zillow Research publishes the
 * ZHVI, a monthly home value index per ZIP code, as a free CSV: one row per
 * ZIP, one column per month since 2000. A house is valued by scaling an
 * anchor the operator trusts (purchase price, appraisal) by how its ZIP's
 * index moved since the anchor date. No key, no account, nothing per address
 * leaves the box: the whole file is fetched and only the wanted rows are kept.
 */
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

export const ZHVI_URL = 'https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv';

/** `date` is the month end the index value stands for, YYYY-MM-DD. */
export interface IndexPoint { date: string; value: number }

export interface ZipIndex { series: Map<string, IndexPoint[]>; last_modified: string | null }

const REGION_NAME_COL = 2;
const FIRST_DATE_COL = 9;

/** The file's Last-Modified, so a daily check can skip the download until a new month lands. */
export async function indexLastModified(fetchImpl: typeof fetch = fetch, url = ZHVI_URL): Promise<string | null> {
  const res = await fetchImpl(url, { method: 'HEAD' });
  if (!res.ok) throw new Error(`index HEAD failed (${res.status})`);
  return res.headers.get('last-modified');
}

/** Streams the CSV and keeps the rows for `zips`. */
export async function fetchZipIndex(zips: Iterable<string>, fetchImpl: typeof fetch = fetch, url = ZHVI_URL): Promise<ZipIndex> {
  const wanted = new Set([...zips].map(normalizeZip).filter(Boolean));
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`index fetch failed (${res.status})`);
  const series = new Map<string, IndexPoint[]>();
  let dates: string[] | null = null;
  // The file drops leading zeros, so the pre-check looks for both spellings.
  const needles = [...wanted].flatMap(z => [z, z.replace(/^0+/, '')]);
  const lines = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!dates) {
      dates = splitCsv(line).slice(FIRST_DATE_COL);
      continue;
    }
    // Cheap pre-check before a full parse: the ZIP sits inside the first few fields.
    const head = line.slice(0, 64);
    if (!needles.some(z => head.includes(`,${z},`))) continue;
    const cells = splitCsv(line);
    const zip = normalizeZip(cells[REGION_NAME_COL] ?? '');
    if (!wanted.has(zip)) continue;
    const points: IndexPoint[] = [];
    for (let i = 0; i < dates.length; i++) {
      const raw = cells[FIRST_DATE_COL + i];
      if (!raw) continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) points.push({ date: dates[i], value });
    }
    series.set(zip, points);
    if (series.size === wanted.size) break;
  }
  lines.close();
  return { series, last_modified: res.headers.get('last-modified') };
}

/** Five digits; the file writes ZIPs without leading zeros. */
export function normalizeZip(s: string): string {
  const digits = s.trim().replace(/\D/g, '');
  return digits.length ? digits.padStart(5, '0').slice(-5) : '';
}

export interface Valuation { value: number; as_of: string; from: string; ratio: number }

/**
 * Scales `anchorValue` by the index change from the anchor month to the newest
 * month. An anchor older than the series starts at the first point; an anchor
 * newer than the series keeps its own value.
 */
export function indexedValue(series: IndexPoint[], anchorDate: string, anchorValue: number): Valuation | null {
  if (!series.length) return null;
  const latest = series[series.length - 1];
  const month = anchorDate.slice(0, 7);
  // The anchor's own month when the index has it, else the first month after
  // it; an anchor older than the series starts at the series' first point.
  const base = series.find(p => p.date.slice(0, 7) >= month);
  if (!base) return { value: anchorValue, as_of: latest.date, from: anchorDate, ratio: 1 };
  const ratio = latest.value / base.value;
  return { value: Math.round(anchorValue * ratio), as_of: latest.date, from: base.date, ratio };
}

/** Minimal CSV split: handles quoted fields with embedded commas and doubled quotes. */
export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

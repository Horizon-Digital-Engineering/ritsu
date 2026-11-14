import type { FinanceStore } from './store.js';
import type { PluginLogger } from '../types.js';
import { fetchZipIndex, indexLastModified, indexedValue } from './providers/zhvi.js';

const META_LAST_MODIFIED = 'zhvi_last_modified';

export interface RevalueResult {
  valued: Array<{ id: string; name: string; value: number; as_of: string }>;
  /** ZIPs the index has no row for. */
  missing: string[];
  skipped: 'no properties' | 'index unchanged' | null;
}

/** Values every property from its ZIP's index. Without `force`, the download
 *  is skipped while the index file is the one already applied. */
export async function revalueProperties(store: FinanceStore, logger: PluginLogger, force = false, fetchImpl: typeof fetch = fetch): Promise<RevalueResult> {
  const props = store.listProperties();
  if (!props.length) return { valued: [], missing: [], skipped: 'no properties' };
  const lastModified = await indexLastModified(fetchImpl);
  if (!force && lastModified && lastModified === store.getMeta(META_LAST_MODIFIED)) {
    return { valued: [], missing: [], skipped: 'index unchanged' };
  }
  const index = await fetchZipIndex(props.map(p => p.zip), fetchImpl);
  const valued: RevalueResult['valued'] = [];
  const missing = new Set<string>();
  for (const p of props) {
    const series = index.series.get(p.zip.padStart(5, '0'));
    const v = series ? indexedValue(series, p.anchor_date, p.anchor_value ?? 0) : null;
    if (!v) { missing.add(p.zip); continue; }
    store.setBalance(p.id, v.value, v.as_of);
    valued.push({ id: p.id, name: p.name, value: v.value, as_of: v.as_of });
  }
  if (lastModified) store.setMeta(META_LAST_MODIFIED, lastModified);
  logger.info('finance.revalue', { valued: valued.length, missing: [...missing] });
  return { valued, missing: [...missing], skipped: null };
}

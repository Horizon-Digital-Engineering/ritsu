import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb, PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { financePlugin } from '../plugins/finance/plugin.js';
import { FinanceStore } from '../plugins/finance/store.js';
import { fetchZipIndex, indexedValue, normalizeZip, splitCsv } from '../plugins/finance/providers/zhvi.js';
import { revalueProperties } from '../plugins/finance/revalue.js';

const CSV = [
  'RegionID,SizeRank,RegionName,RegionType,StateName,State,City,Metro,CountyName,2020-01-31,2020-02-29,2026-08-31,2026-09-30',
  '1,10,85016,zip,AZ,AZ,Phoenix,"Phoenix-Mesa-Chandler, AZ",Maricopa County,300000,302000,450000,453000',
  '2,20,33101,zip,FL,FL,Miami,"Miami-Fort Lauderdale-Pompano Beach, FL",Miami-Dade County,,,500000,510000',
  '3,30,2134,zip,MA,MA,Boston,"Boston-Cambridge-Newton, MA-NH",Suffolk County,600000,601000,900000,905000',
].join('\n');

function fakeFetch(opts: { lastModified: string; calls: string[] }): typeof fetch {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    opts.calls.push(init?.method ?? 'GET');
    const headers = { 'last-modified': opts.lastModified };
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(CSV, { status: 200, headers });
  };
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function fresh() {
  const db = openDatabase(':memory:');
  const host = new PluginHost(db, new SecretStore(db));
  host.register(financePlugin);
  return new FinanceStore(new ScopedDb(db, 'finance', true));
}

describe('ZHVI index', () => {
  it('splits quoted CSV fields and pads ZIPs the file writes without leading zeros', () => {
    assert.deepEqual(splitCsv('a,"b, c","d ""e""",f'), ['a', 'b, c', 'd "e"', 'f']);
    assert.equal(normalizeZip('2134'), '02134');
    assert.equal(normalizeZip(' 85016 '), '85016');
  });

  it('streams only the wanted rows and keeps the months that have a value', async () => {
    const calls: string[] = [];
    const idx = await fetchZipIndex(['85016', '02134', '99999'], fakeFetch({ lastModified: 'x', calls }));
    assert.deepEqual([...idx.series.keys()].sort((a, b) => a.localeCompare(b)), ['02134', '85016']);
    assert.equal(idx.series.get('85016')!.length, 4);
    assert.equal(idx.last_modified, 'x');
  });

  it('scales the anchor from its month to the newest month', async () => {
    const idx = await fetchZipIndex(['85016', '33101'], fakeFetch({ lastModified: 'x', calls: [] }));
    const az = idx.series.get('85016')!;
    const v = indexedValue(az, '2020-01-15', 400_000)!;
    assert.equal(v.from, '2020-01-31');
    assert.equal(v.as_of, '2026-09-30');
    assert.equal(v.value, Math.round(400_000 * 453000 / 300000));
    // An anchor older than the series starts at the first point.
    assert.equal(indexedValue(az, '2015-06-01', 100_000)!.from, '2020-01-31');
    // Miami has no 2020 values, so a 2020 anchor starts at its first real month.
    const fl = idx.series.get('33101')!;
    assert.equal(fl.length, 2);
    assert.equal(indexedValue(fl, '2020-03-01', 250_000)!.from, '2026-08-31');
    // An anchor newer than the index keeps its own value.
    assert.deepEqual(indexedValue(az, '2026-11-01', 777_000), { value: 777_000, as_of: '2026-09-30', from: '2026-11-01', ratio: 1 });
    assert.equal(indexedValue([], '2020-01-01', 1), null);
  });
});

describe('revalueProperties', () => {
  it('values anchored properties, records history, and skips while the index is unchanged', async () => {
    const store = fresh();
    store.upsertAccount({ id: 'manual:az', connection_id: null, name: 'Phoenix house', type: 'property', balance: 400_000, balance_as_of: '2020-01-15' });
    store.updateAccount('manual:az', { zip: '85016', anchor_value: 400_000, anchor_date: '2020-01-15' });
    store.upsertAccount({ id: 'manual:cash', connection_id: null, name: 'Cash', type: 'depository', balance: 10, balance_as_of: '2026-01-01' });
    store.upsertAccount({ id: 'manual:none', connection_id: null, name: 'Lot with no ZIP', type: 'property', balance: 50_000, balance_as_of: '2026-01-01' });
    store.upsertAccount({ id: 'manual:gone', connection_id: null, name: 'Nowhere', type: 'property', balance: 1, balance_as_of: '2026-01-01' });
    store.updateAccount('manual:gone', { zip: '99999', anchor_value: 1, anchor_date: '2026-01-01' });
    assert.deepEqual(store.listProperties().map(p => p.id).sort((a, b) => a.localeCompare(b)), ['manual:az', 'manual:gone']);

    const calls: string[] = [];
    const r = await revalueProperties(store, logger, false, fakeFetch({ lastModified: 'Fri, 16 Oct 2026 01:55:43 GMT', calls }));
    assert.equal(r.skipped, null);
    assert.deepEqual(r.missing, ['99999']);
    assert.equal(r.valued.length, 1);
    const az = store.getAccount('manual:az')!;
    assert.equal(az.balance, Math.round(400_000 * 453000 / 300000));
    assert.equal(az.balance_as_of, '2026-09-30');
    assert.ok(store.balanceHistory('2026-09-01', '2026-09-30').some(h => h.account_id === 'manual:az' && h.balance === az.balance));
    assert.equal(store.getAccount('manual:cash')!.balance, 10, 'other accounts untouched');
    assert.deepEqual(calls, ['HEAD', 'GET']);

    const again = await revalueProperties(store, logger, false, fakeFetch({ lastModified: 'Fri, 16 Oct 2026 01:55:43 GMT', calls }));
    assert.equal(again.skipped, 'index unchanged');
    assert.deepEqual(calls, ['HEAD', 'GET', 'HEAD'], 'no download while the file is the one already applied');

    const forced = await revalueProperties(store, logger, true, fakeFetch({ lastModified: 'Fri, 16 Oct 2026 01:55:43 GMT', calls }));
    assert.equal(forced.valued.length, 1);
    assert.equal(calls.at(-1), 'GET');
  });

  it('does nothing at all without properties', async () => {
    const calls: string[] = [];
    const r = await revalueProperties(fresh(), logger, true, fakeFetch({ lastModified: 'x', calls }));
    assert.equal(r.skipped, 'no properties');
    assert.deepEqual(calls, []);
  });
});

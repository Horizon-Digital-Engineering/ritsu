import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb } from '../plugins/host.js';
import { migrate } from '../plugins/health/migrate.js';
import { buildHealthPipeline } from '../plugins/health/ingest.js';
import { StaticExtractor } from '../ingestion/extractors.js';
import { HealthStore } from '../plugins/health/store.js';
import { InsuranceStore } from '../plugins/health/insurance.js';
import { DocumentStore } from '../plugins/health/documents.js';

function db() {
  const d = new ScopedDb(openDatabase(':memory:'), 'health');
  migrate(d);
  return d;
}

describe('health ingestion doc types', () => {
  it('lab_report → observations (flagged), after review', async () => {
    const d = db();
    const p = buildHealthPipeline(d, new StaticExtractor([
      { label: 'LDL', value: 160, unit: 'mg/dL', ref_high: 100, date: '2026-07-01' },
      { label: 'HDL', value: 55, unit: 'mg/dL', ref_low: 40, date: '2026-07-01' },
    ]));
    const rec = await p.submit({ title: 'Quest labs', source: 'paste', text: 'LDL 160 HDL 55' }, 'lab_report');
    assert.equal(rec.status, 'pending');
    p.confirm(rec.id);

    const s = new HealthStore(d);
    assert.equal(s.series('LDL')[0].value, 160);
    assert.equal(s.series('LDL')[0].flag, 'high');   // 160 > 100
    assert.equal(s.series('HDL')[0].flag, 'normal');
  });

  it('sbc → insurance benefits + a searchable benefits document', async () => {
    const d = db();
    const p = buildHealthPipeline(d, new StaticExtractor({
      benefits: [
        { category: 'Specialist', cost_type: 'copay', amount: 50 },
        { category: 'ER', cost_type: 'coinsurance', amount: 20, after_deductible: true },
      ],
    }));
    const rec = await p.submit(
      { title: '2026 SBC', source: 'paste', text: 'Specialist $50 copay. ER 20% after deductible. Acupuncture is covered up to 12 visits per year.' },
      'sbc',
    );
    p.confirm(rec.id);

    const ins = new InsuranceStore(d);
    const plan = ins.activePlan();
    assert.ok(plan, 'a plan was created to hold the benefits');
    const cats = ins.benefitsFor(plan.id).map(b => b.category).sort();
    assert.deepEqual(cats, ['ER', 'Specialist']);

    // the raw doc is kept searchable for the long tail
    const docs = new DocumentStore(d);
    assert.ok(docs.all().some(x => x.category === 'benefits' && /Acupuncture/.test(x.text)));
  });
});

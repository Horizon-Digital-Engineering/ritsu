import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb, PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { migrate } from '../plugins/health/migrate.js';
import { HealthStore } from '../plugins/health/store.js';
import { trend, correlate } from '../plugins/health/report.js';
import { healthPlugin } from '../plugins/health/plugin.js';
import type { Observation } from '../plugins/health/store.js';

function store(): HealthStore {
  const db = new ScopedDb(openDatabase(':memory:'), 'health');
  migrate(db);
  return new HealthStore(db);
}

describe('HealthStore', () => {
  let s: HealthStore;
  beforeEach(() => { s = store(); });

  it('flags labs out of range and keeps a per-label series', () => {
    s.addObservation({ date: '2026-01-01', kind: 'lab', label: 'LDL', value: 160, unit: 'mg/dL', ref_high: 100 });
    s.addObservation({ date: '2026-04-01', kind: 'lab', label: 'LDL', value: 90, unit: 'mg/dL', ref_high: 100 });
    const series = s.series('LDL');
    assert.equal(series.length, 2);
    assert.equal(series[0].flag, 'high');   // 160 > 100
    assert.equal(series[1].flag, 'normal'); // 90 <= 100
  });

  it('latestPerLabel returns the newest value per label', () => {
    s.addObservation({ date: '2026-01-01', kind: 'weight', label: 'Weight', value: 190 });
    s.addObservation({ date: '2026-06-01', kind: 'weight', label: 'Weight', value: 182 });
    const latest = s.latestPerLabel();
    assert.equal(latest.find(o => o.label === 'Weight')?.value, 182);
  });

  it('medications: add, list active, stop marks inactive', () => {
    const id = s.addMedication({ name: 'Atorvastatin', dose: '20 mg', frequency: 'once daily', start_date: '2026-02-01' });
    assert.equal(s.listMedications(true).length, 1);
    assert.equal(s.stopMedication(id, '2026-07-01'), true);
    assert.equal(s.listMedications(true).length, 0);
    assert.equal(s.listMedications(false)[0].active, false);
  });
});

describe('health analysis', () => {
  const obs = (date: string, label: string, value: number): Observation =>
    ({ id: 0, date, kind: 'lab', label, value, unit: '', ref_low: null, ref_high: null, flag: '', source: 'manual', note: '', created_at: 0 });

  it('trend reports first→last change', () => {
    const t = trend([obs('2026-01-01', 'LDL', 160), obs('2026-04-01', 'LDL', 130), obs('2026-07-01', 'LDL', 100)]);
    assert.equal(t.count, 3);
    assert.equal(t.change, -60);
    assert.equal(t.first?.value, 160);
    assert.equal(t.last?.value, 100);
  });

  it('correlate finds an inverse relationship (weight up as LDL down, nearest-date paired)', () => {
    const weight = ['2026-01-02', '2026-04-02', '2026-07-02'].map((d, i) => obs(d, 'Weight', 200 - i * 10));
    const ldl = ['2026-01-01', '2026-04-01', '2026-07-01'].map((d, i) => obs(d, 'LDL', 100 + i * 20));
    const c = correlate(weight, ldl);
    assert.equal(c.n, 3);
    assert.ok(c.r !== null && c.r < -0.9); // weight falls while LDL rises → strong inverse
  });
});

describe('health plugin registration + tools', () => {
  it('registers and exposes read tools (fenced) + write tools (ungated)', () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db, new SecretStore(db));
    host.register(healthPlugin);
    const tools = Object.fromEntries(host.toolsFor('health').map(t => [t.name, t]));
    // reads are fenced
    for (const r of ['latest_labs', 'trend', 'correlate', 'list_medications', 'recent_observations']) {
      assert.equal(tools[r].untrustedOutput, true, `${r} should be fenced`);
    }
    // writes are ungated self-entry
    for (const w of ['log_weight', 'log_observation', 'add_medication']) {
      assert.ok(!tools[w].needsApproval, `${w} should not need approval`);
      assert.ok(!tools[w].untrustedOutput, `${w} is a write confirmation, not stored data`);
    }
  });

  it('log_weight then trend reads back through the shared cache', async () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db, new SecretStore(db));
    host.register(healthPlugin);
    const tools = Object.fromEntries(host.toolsFor('health').map(t => [t.name, t]));
    await tools.log_weight.handler({ value: 185, date: '2026-01-01' }, { agentId: 'x' });
    await tools.log_weight.handler({ value: 179, date: '2026-06-01' }, { agentId: 'x' });
    const out = await tools.trend.handler({ label: 'Weight' }, { agentId: 'x' });
    assert.match(out.content[0].text, /185.*179/s);
  });

  type ToolMap = Record<string, ReturnType<PluginHost['toolsFor']>[number]>;
  function tools(): ToolMap {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db, new SecretStore(db));
    host.register(healthPlugin);
    return Object.fromEntries(host.toolsFor('health').map(t => [t.name, t]));
  }
  const call = (t: ToolMap, name: string, args: Record<string, unknown>): Promise<string> =>
    Promise.resolve(t[name].handler(args, { agentId: 'x' })).then(r => r.content[0].text);

  it('observation + medication + labs + correlate tool handlers render their confirmations', async () => {
    const t = tools();
    // empty-state reads
    assert.match(await call(t, 'latest_labs', {}), /no lab results/);
    assert.match(await call(t, 'list_medications', {}), /no medications/);
    assert.match(await call(t, 'recent_observations', {}), /no observations/);
    assert.match(await call(t, 'trend', { label: 'Weight' }), /no data/);

    // writes echo the value back (exercises the String()-wrapped interpolations)
    assert.match(await call(t, 'log_observation', { label: 'LDL', value: 120, kind: 'lab', unit: 'mg/dL', ref_low: 0, ref_high: 100, date: '2026-01-01' }), /logged LDL = 120/);
    assert.match(await call(t, 'log_observation', { label: 'LDL', value: 90, kind: 'lab', date: '2026-06-01' }), /logged LDL/);
    assert.match(await call(t, 'add_medication', { name: 'Atorvastatin', dose: '20 mg', frequency: 'once daily' }), /added medication Atorvastatin/);

    // reads over the seeded data
    assert.match(await call(t, 'latest_labs', {}), /LDL/);
    assert.match(await call(t, 'list_medications', { active_only: true }), /Atorvastatin/);
    assert.match(await call(t, 'recent_observations', { label: 'LDL' }), /LDL/);
    assert.match(await call(t, 'trend', { label: 'LDL' }), /LDL/);

    // correlate needs two series → seed a second and pair them
    await call(t, 'log_observation', { label: 'Weight', value: 185, date: '2026-01-01' });
    await call(t, 'log_observation', { label: 'Weight', value: 179, date: '2026-06-01' });
    const corr = await call(t, 'correlate', { label_a: 'Weight', label_b: 'LDL' });
    assert.match(corr, /Weight vs LDL|Not enough overlapping/);
  });

  it('insurance + document tool handlers round-trip', async () => {
    const t = tools();
    assert.match(await call(t, 'insurance_summary', {}), /no active insurance/);
    const saved = await call(t, 'set_insurance_plan', { plan_year: 2026, carrier: 'Aetna', plan_name: 'PPO', deductible_individual: 1000, oop_max_individual: 5000 });
    assert.match(saved, /saved plan Aetna PPO \(id=(\d+)\)/);
    const planId = Number(/id=(\d+)/.exec(saved)![1]);
    assert.match(await call(t, 'insurance_summary', {}), /Aetna PPO/);
    assert.match(await call(t, 'add_benefit', { plan_id: planId, category: 'Specialist', cost_type: 'copay', amount: 40, network: 'in' }), /added benefit Specialist/);
    assert.match(await call(t, 'coverage_for', { service: 'Specialist' }), /Specialist/);
    assert.match(await call(t, 'update_deductible', { plan_id: planId, deductible_met: 250, oop_met: 250 }), /updated deductible/);
    assert.match(await call(t, 'update_deductible', { plan_id: 99999, deductible_met: 0, oop_met: 0 }), /no plan with id 99999/);

    assert.match(await call(t, 'add_benefits_document', { title: 'Plan Doc', text: 'acupuncture is covered up to 12 visits' }), /stored document "Plan Doc"/);
    assert.match(await call(t, 'search_benefits', { query: 'acupuncture' }), /acupuncture/);
    assert.match(await call(t, 'search_benefits', { query: 'zzzznope' }), /nothing found/);
  });
});

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb, PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { migrate } from '../plugins/health/migrate.js';
import { InsuranceStore, describeBenefit } from '../plugins/health/insurance.js';
import { DocumentStore, searchDocuments } from '../plugins/health/documents.js';
import { healthPlugin } from '../plugins/health/plugin.js';

function stores() {
  const db = new ScopedDb(openDatabase(':memory:'), 'health');
  migrate(db);
  return { ins: new InsuranceStore(db), docs: new DocumentStore(db) };
}

describe('InsuranceStore + coverage', () => {
  let ins: InsuranceStore;
  beforeEach(() => { ins = stores().ins; });

  it('tracks a plan, its benefits, and deductible progress', () => {
    const id = ins.addPlan({ plan_year: 2026, carrier: 'BlueCross', plan_name: 'PPO 3000', plan_type: 'PPO', deductible_individual: 3000, oop_max_individual: 8000 });
    ins.addBenefit({ plan_id: id, category: 'Specialist', cost_type: 'copay', amount: 50, after_deductible: false });
    ins.addBenefit({ plan_id: id, category: 'ER', cost_type: 'coinsurance', amount: 20, after_deductible: true });
    assert.equal(ins.activePlan()?.plan_name, 'PPO 3000');
    ins.setProgress(id, 1200, 1500);
    assert.equal(ins.activePlan()?.deductible_met, 1200);

    const spec = ins.findCoverage('specialist');
    assert.equal(spec.length, 1);
    assert.equal(describeBenefit(spec[0]), 'in-network: $50 copay');
    const er = ins.findCoverage('ER');
    assert.equal(describeBenefit(er[0]), 'in-network: 20% coinsurance after deductible');
  });

  it('findCoverage returns nothing for an unlisted service (falls back to docs at the tool layer)', () => {
    ins.addPlan({ plan_year: 2026, carrier: 'X', plan_name: 'Y' });
    assert.equal(ins.findCoverage('acupuncture').length, 0);
  });
});

describe('document dump + search', () => {
  it('finds the passage that answers a long-tail coverage question', () => {
    const { docs } = stores();
    docs.add({ category: 'benefits', title: 'SBC', source: 'paste', text: 'Routine dental is not covered.\n\nAcupuncture is covered up to 12 visits per year when medically necessary.\n\nChiropractic requires a referral.' });
    const hits = searchDocuments(docs.all(), 'acupuncture coverage');
    assert.ok(hits.length >= 1);
    assert.match(hits[0].snippet, /Acupuncture is covered up to 12 visits/);
  });
});

describe('health plugin — insurance tools', () => {
  it('coverage_for uses structured benefits AND quotes the dumped doc', async () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db, new SecretStore(db));
    host.register(healthPlugin);
    const tools = Object.fromEntries(host.toolsFor('health').map(t => [t.name, t]));

    const plan = await tools.set_insurance_plan.handler({ plan_year: 2026, carrier: 'BlueCross', plan_name: 'PPO 3000', deductible_individual: 3000 }, { agentId: 'x' });
    const planId = Number(/id=(\d+)/.exec(plan.content[0].text)![1]);
    await tools.add_benefit.handler({ plan_id: planId, category: 'Specialist', cost_type: 'copay', amount: 50 }, { agentId: 'x' });
    await tools.add_benefits_document.handler({ title: 'SBC', text: 'Acupuncture is covered up to 12 visits per year.' }, { agentId: 'x' });

    const spec = await tools.coverage_for.handler({ service: 'Specialist' }, { agentId: 'x' });
    assert.match(spec.content[0].text, /\$50 copay/);
    const acu = await tools.coverage_for.handler({ service: 'acupuncture' }, { agentId: 'x' });
    assert.match(acu.content[0].text, /12 visits/);   // quoted from the dumped doc

    // read tools fenced, writes not gated
    assert.equal(tools.coverage_for.untrustedOutput, true);
    assert.equal(tools.search_benefits.untrustedOutput, true);
    assert.ok(!tools.set_insurance_plan.needsApproval);
  });
});

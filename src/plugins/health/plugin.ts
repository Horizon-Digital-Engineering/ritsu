import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Plugin, PluginContext, PluginToolContext } from '../types.js';
import { migrate } from './migrate.js';
import { HealthStore } from './store.js';
import { trend, correlate } from './report.js';
import { InsuranceStore, describeBenefit } from './insurance.js';
import { DocumentStore, searchDocuments } from './documents.js';
import {
  ObservationSchema, MedicationSchema, StopMedSchema,
  PlanSchema, BenefitSchema, ProgressSchema, DocumentSchema,
} from './schema.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (v: number, unit: string) => `${v}${unit ? ` ${unit}` : ''}`;

// ---- agent tools (reads fenced; writes are benign self-entry, ungated) -----
function defineTools(ctx: PluginToolContext): void {
  const store = new HealthStore(ctx.db);
  const ins = new InsuranceStore(ctx.db);
  const docs = new DocumentStore(ctx.db);

  ctx.tool({
    name: 'log_weight',
    description: 'Record a body-weight measurement (defaults to today).',
    input: { value: z.number().positive(), unit: z.string().max(10).optional().describe('e.g. lb or kg, default lb'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    handler: (a) => {
      const id = store.addObservation({ date: (a.date as string) || today(), kind: 'weight', label: 'Weight', value: Number(a.value), unit: (a.unit as string) || 'lb' });
      return text(`logged weight ${fmt(Number(a.value), (a.unit as string) || 'lb')} (id=${id})`);
    },
  });

  ctx.tool({
    name: 'log_observation',
    description: 'Record any health measurement (a lab marker, a vital, etc.) as a time-series point. Include ref_low/ref_high for labs to auto-flag out-of-range.',
    input: {
      label: z.string().min(1).max(80).describe('e.g. "LDL", "BP Systolic", "A1C"'),
      value: z.number(),
      kind: z.enum(['weight', 'lab', 'vital', 'other']).optional(),
      unit: z.string().max(20).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      ref_low: z.number().optional(),
      ref_high: z.number().optional(),
      note: z.string().max(500).optional(),
    },
    handler: (a) => {
      const id = store.addObservation({
        date: (a.date as string) || today(), kind: (a.kind as string) || 'other', label: String(a.label), value: Number(a.value),
        unit: a.unit as string | undefined, ref_low: a.ref_low as number | undefined, ref_high: a.ref_high as number | undefined, note: a.note as string | undefined,
      });
      return text(`logged ${a.label} = ${fmt(Number(a.value), (a.unit as string) || '')} (id=${id})`);
    },
  });

  ctx.tool({
    name: 'add_medication',
    description: 'Add a medication / prescription to the list.',
    input: {
      name: z.string().min(1).max(120),
      dose: z.string().max(60).optional().describe('e.g. "20 mg"'),
      frequency: z.string().max(60).optional().describe('e.g. "once daily"'),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(500).optional(),
    },
    handler: (a) => {
      const id = store.addMedication({ name: String(a.name), dose: a.dose as string | undefined, frequency: a.frequency as string | undefined, start_date: (a.start_date as string) || today(), note: a.note as string | undefined });
      return text(`added medication ${a.name} (id=${id})`);
    },
  });

  ctx.tool({
    name: 'list_medications',
    description: 'List medications. Pass active_only to see only current ones.',
    input: { active_only: z.boolean().optional() },
    untrustedOutput: true,
    handler: (a) => {
      const meds = store.listMedications(a.active_only === true);
      if (!meds.length) return text('(no medications recorded)');
      return text(meds.map(m => `${m.name}${m.dose ? ` ${m.dose}` : ''}${m.frequency ? ` — ${m.frequency}` : ''}${m.active ? '' : ` [stopped ${m.end_date}]`}`).join('\n'));
    },
  });

  ctx.tool({
    name: 'latest_labs',
    description: 'Most recent value for each lab marker, with out-of-range flags.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const labs = store.latestPerLabel('lab');
      if (!labs.length) return text('(no lab results recorded)');
      return text(labs.map(o => `${o.label}: ${fmt(o.value, o.unit)}${o.flag && o.flag !== 'normal' ? ` (${o.flag.toUpperCase()})` : ''} — ${o.date}`).join('\n'));
    },
  });

  ctx.tool({
    name: 'trend',
    description: 'Trend for one measurement over its whole history: first vs latest, change, min/max/avg.',
    input: { label: z.string().min(1).max(80).describe('the measurement label, e.g. "Weight" or "LDL"') },
    untrustedOutput: true,
    handler: (a) => {
      const t = trend(store.series(String(a.label)));
      if (t.count === 0 || !t.first || !t.last) return text(`(no data for "${a.label}")`);
      const dir = t.change == null ? '' : t.change > 0 ? '▲' : t.change < 0 ? '▼' : '→';
      return text(`${t.label} (${t.count} points): ${fmt(t.first.value, t.unit)} (${t.first.date}) → ${fmt(t.last.value, t.unit)} (${t.last.date}) ${dir} ${t.change?.toFixed(1)}${t.pctChange != null ? ` (${t.pctChange.toFixed(1)}%)` : ''}\n  min ${t.min} · max ${t.max} · avg ${t.avg.toFixed(1)}`);
    },
  });

  ctx.tool({
    name: 'correlate',
    description: 'Correlation between two measurements over time (e.g. Weight vs LDL). Pairs each point of one with the nearest of the other within ~2 weeks.',
    input: { label_a: z.string().min(1).max(80), label_b: z.string().min(1).max(80) },
    untrustedOutput: true,
    handler: (a) => {
      const c = correlate(store.series(String(a.label_a)), store.series(String(a.label_b)));
      if (c.r == null) return text(`Not enough overlapping data to correlate ${a.label_a} and ${a.label_b} (paired ${c.n} points).`);
      const strength = Math.abs(c.r) > 0.7 ? 'strong' : Math.abs(c.r) > 0.4 ? 'moderate' : 'weak';
      return text(`${a.label_a} vs ${a.label_b}: r = ${c.r.toFixed(2)} (${strength} ${c.r < 0 ? 'inverse' : 'positive'}), ${c.n} paired points. Correlation ≠ causation.`);
    },
  });

  ctx.tool({
    name: 'recent_observations',
    description: 'Recent measurements, optionally filtered to one label; newest first.',
    input: { label: z.string().max(80).optional(), limit: z.number().int().min(1).max(200).optional() },
    untrustedOutput: true,
    handler: (a) => {
      const rows = store.recentObservations(a.label as string | undefined, typeof a.limit === 'number' ? a.limit : 30);
      if (!rows.length) return text('(no observations)');
      return text(rows.map(o => `${o.date} ${o.label}: ${fmt(o.value, o.unit)}${o.flag && o.flag !== 'normal' ? ` (${o.flag})` : ''}`).join('\n'));
    },
  });

  // ---- insurance (reads fenced; writes ungated self-entry) ----
  ctx.tool({
    name: 'insurance_summary',
    description: 'Your active insurance plan with deductible + out-of-pocket progress.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const p = ins.activePlan();
      if (!p) return text('(no active insurance plan on file)');
      const ded = p.deductible_individual != null ? `deductible: $${p.deductible_met} / $${p.deductible_individual}` : 'deductible: n/a';
      const oop = p.oop_max_individual != null ? `out-of-pocket: $${p.oop_met} / $${p.oop_max_individual}` : 'OOP max: n/a';
      return text(`${p.carrier} ${p.plan_name} (${p.plan_type || 'plan'}, ${p.plan_year})\n  member ${p.member_id || '—'}\n  ${ded}\n  ${oop}${p.premium_monthly != null ? `\n  premium: $${p.premium_monthly}/mo` : ''}`);
    },
  });

  ctx.tool({
    name: 'coverage_for',
    description: 'What a given service costs you under the active plan (copay/coinsurance/covered) — falls back to quoting the actual benefits document for anything not in the structured list (e.g. "acupuncture").',
    input: { service: z.string().min(1).max(80), network: z.enum(['in', 'out']).optional() },
    untrustedOutput: true,
    handler: (a) => {
      const net = (a.network as 'in' | 'out') || 'in';
      const hits = ins.findCoverage(String(a.service), net);
      const parts: string[] = [];
      if (hits.length) parts.push(hits.map(b => `${b.category} — ${describeBenefit(b)}`).join('\n'));
      const passages = searchDocuments(docs.all().filter(d => d.category === 'benefits'), String(a.service), 2);
      if (passages.length) parts.push('From your benefits document:\n' + passages.map(h => `  "${h.snippet}"`).join('\n'));
      return text(parts.length ? parts.join('\n\n') : `Nothing on file for "${a.service}" — add a benefit or dump your plan document.`);
    },
  });

  ctx.tool({
    name: 'search_benefits',
    description: 'Search your dumped insurance / benefits documents for a topic and return the relevant passages verbatim.',
    input: { query: z.string().min(1).max(120) },
    untrustedOutput: true,
    handler: (a) => {
      const hits = searchDocuments(docs.all(), String(a.query), 4);
      if (!hits.length) return text('(nothing found in your dumped documents)');
      return text(hits.map(h => `[${h.title}] "${h.snippet}"`).join('\n\n'));
    },
  });

  ctx.tool({
    name: 'set_insurance_plan',
    description: 'Record (or replace) your insurance plan basics: carrier, plan name, year, deductible + out-of-pocket max.',
    input: {
      plan_year: z.number().int().min(2000).max(2100),
      carrier: z.string().min(1).max(120),
      plan_name: z.string().min(1).max(160),
      plan_type: z.string().max(40).optional(),
      deductible_individual: z.number().nonnegative().optional(),
      oop_max_individual: z.number().nonnegative().optional(),
      premium_monthly: z.number().nonnegative().optional(),
    },
    handler: (a) => {
      const id = ins.addPlan({
        plan_year: Number(a.plan_year), carrier: String(a.carrier), plan_name: String(a.plan_name),
        plan_type: a.plan_type as string | undefined,
        deductible_individual: a.deductible_individual as number | undefined,
        oop_max_individual: a.oop_max_individual as number | undefined,
        premium_monthly: a.premium_monthly as number | undefined,
      });
      return text(`saved plan ${a.carrier} ${a.plan_name} (id=${id})`);
    },
  });

  ctx.tool({
    name: 'add_benefit',
    description: 'Add a coverage line to a plan: what a service category costs (copay/coinsurance/covered/not_covered), in- or out-of-network.',
    input: {
      plan_id: z.number().int().positive(),
      category: z.string().min(1).max(80).describe('e.g. "Specialist", "ER", "Generic Rx", "Imaging"'),
      cost_type: z.enum(['copay', 'coinsurance', 'covered', 'not_covered']),
      amount: z.number().nonnegative().optional().describe('$ for copay, % for coinsurance'),
      network: z.enum(['in', 'out']).optional(),
      after_deductible: z.boolean().optional(),
    },
    handler: (a) => {
      const id = ins.addBenefit({
        plan_id: Number(a.plan_id), category: String(a.category), cost_type: a.cost_type as 'copay' | 'coinsurance' | 'covered' | 'not_covered',
        amount: a.amount as number | undefined, network: a.network as 'in' | 'out' | undefined, after_deductible: a.after_deductible as boolean | undefined,
      });
      return text(`added benefit ${a.category} (id=${id})`);
    },
  });

  ctx.tool({
    name: 'add_benefits_document',
    description: 'Dump a benefits / plan document (paste its text) so the assistant can quote the actual coverage language later.',
    input: {
      title: z.string().min(1).max(200),
      text: z.string().min(1).max(500_000),
      category: z.string().max(40).optional().describe('default "benefits"; also "lab_report", "eob", "note"'),
    },
    handler: (a) => {
      const id = docs.add({ category: (a.category as string) || 'benefits', title: String(a.title), text: String(a.text), source: 'agent' });
      return text(`stored document "${a.title}" (id=${id})`);
    },
  });

  ctx.tool({
    name: 'update_deductible',
    description: "Update a plan's running deductible-met and out-of-pocket-met totals.",
    input: { plan_id: z.number().int().positive(), deductible_met: z.number().nonnegative(), oop_met: z.number().nonnegative() },
    handler: (a) => {
      const ok = ins.setProgress(Number(a.plan_id), Number(a.deductible_met), Number(a.oop_met));
      return text(ok ? `updated deductible/OOP for plan ${a.plan_id}` : `no plan with id ${a.plan_id}`);
    },
  });
}

// ---- admin routes ----------------------------------------------------------
function parse<T>(req: Request, res: Response, schema: z.ZodType<T>): T | null {
  const r = schema.safeParse(req.body);
  if (!r.success) { res.status(400).json({ error: 'invalid request body', issues: z.treeifyError(r.error) }); return null; }
  return r.data;
}

function register(ctx: PluginContext): void {
  const store = new HealthStore(ctx.db);
  const ins = new InsuranceStore(ctx.db);
  const docs = new DocumentStore(ctx.db);

  ctx.route('get', '/overview', (_req, res) => {
    res.json({
      vitals: store.latestPerLabel().filter(o => o.kind === 'weight' || o.kind === 'vital'),
      labs: store.latestPerLabel('lab'),
      medications: store.listMedications(true),
      labels: store.labels(),
    });
  });

  ctx.route('get', '/observations', (req, res) => {
    const label = typeof req.query.label === 'string' ? req.query.label : undefined;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ observations: store.recentObservations(label, limit) });
  });

  ctx.route('get', '/series', (req, res) => {
    const label = String(req.query.label ?? '');
    const s = store.series(label);
    res.json({ label, series: s, trend: trend(s) });
  });

  ctx.route('post', '/observations', (req, res) => {
    const b = parse(req, res, ObservationSchema); if (!b) return;
    const id = store.addObservation(b);
    res.status(201).json({ id });
  });

  ctx.route('delete', '/observations/:id', (req, res) => {
    res.status(store.deleteObservation(Number(req.params.id)) ? 204 : 404).end();
  });

  ctx.route('get', '/medications', (req, res) => {
    res.json({ medications: store.listMedications(req.query.active === '1') });
  });

  ctx.route('post', '/medications', (req, res) => {
    const b = parse(req, res, MedicationSchema); if (!b) return;
    res.status(201).json({ id: store.addMedication(b) });
  });

  ctx.route('post', '/medications/:id/stop', (req, res) => {
    const b = parse(req, res, StopMedSchema); if (!b) return;
    res.status(store.stopMedication(Number(req.params.id), b.end_date) ? 204 : 404).end();
  });

  ctx.route('delete', '/medications/:id', (req, res) => {
    res.status(store.deleteMedication(Number(req.params.id)) ? 204 : 404).end();
  });

  ctx.route('get', '/labels', (_req, res) => { res.json({ labels: store.labels() }); });

  ctx.route('get', '/correlate', (req, res) => {
    const a = String(req.query.a ?? '');
    const b = String(req.query.b ?? '');
    const seriesA = store.series(a);
    const seriesB = store.series(b);
    res.json({ a, b, correlation: correlate(seriesA, seriesB), seriesA, seriesB });
  });

  // --- insurance ---
  ctx.route('get', '/insurance', (_req, res) => {
    const active = ins.activePlan();
    res.json({ plans: ins.listPlans(), active, benefits: active ? ins.benefitsFor(active.id) : [] });
  });

  ctx.route('post', '/insurance/plans', (req, res) => {
    const b = parse(req, res, PlanSchema); if (!b) return;
    res.status(201).json({ id: ins.addPlan(b) });
  });

  ctx.route('delete', '/insurance/plans/:id', (req, res) => {
    res.status(ins.deletePlan(Number(req.params.id)) ? 204 : 404).end();
  });

  ctx.route('post', '/insurance/plans/:id/progress', (req, res) => {
    const b = parse(req, res, ProgressSchema); if (!b) return;
    res.status(ins.setProgress(Number(req.params.id), b.deductible_met, b.oop_met) ? 204 : 404).end();
  });

  ctx.route('get', '/insurance/plans/:id/benefits', (req, res) => {
    res.json({ benefits: ins.benefitsFor(Number(req.params.id)) });
  });

  ctx.route('post', '/insurance/benefits', (req, res) => {
    const b = parse(req, res, BenefitSchema); if (!b) return;
    res.status(201).json({ id: ins.addBenefit(b) });
  });

  ctx.route('delete', '/insurance/benefits/:id', (req, res) => {
    res.status(ins.deleteBenefit(Number(req.params.id)) ? 204 : 404).end();
  });

  // --- dumped documents (assistant reference material) ---
  ctx.route('get', '/documents', (req, res) => {
    res.json({ documents: docs.list(typeof req.query.category === 'string' ? req.query.category : undefined) });
  });

  ctx.route('get', '/documents/search', (req, res) => {
    res.json({ hits: searchDocuments(docs.all(), String(req.query.q ?? ''), 6) });
  });

  ctx.route('get', '/documents/:id', (req, res) => {
    const d = docs.get(Number(req.params.id));
    if (!d) { res.status(404).json({ error: 'not found' }); return; }
    res.json(d);
  });

  ctx.route('post', '/documents', (req, res) => {
    const b = parse(req, res, DocumentSchema); if (!b) return;
    res.status(201).json({ id: docs.add(b) });
  });

  ctx.route('delete', '/documents/:id', (req, res) => {
    res.status(docs.delete(Number(req.params.id)) ? 204 : 404).end();
  });
}

export const healthPlugin: Plugin = {
  manifest: {
    id: 'health',
    name: 'Health',
    version: '0.1.0',
    description: 'Personal health tracker: labs, meds, weight, and vitals on one timeline — trends + correlations. A tracker, not medical advice.',
    nav: [
      { id: 'health', label: 'Health', tabs: [
        { id: 'health-overview', label: 'Overview' },
        { id: 'health-log', label: 'Log' },
        { id: 'health-trends', label: 'Trends' },
        { id: 'health-insurance', label: 'Insurance' },
      ] },
    ],
  },
  migrate,
  defineTools,
  register,
  assetsDir: fileURLToPath(new URL('./ui', import.meta.url)),
};

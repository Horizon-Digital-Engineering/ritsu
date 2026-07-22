import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Plugin, PluginContext, PluginToolContext } from '../types.js';
import { migrate } from './migrate.js';
import { HealthStore } from './store.js';
import { trend, correlate } from './report.js';
import { ObservationSchema, MedicationSchema, StopMedSchema } from './schema.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (v: number, unit: string) => `${v}${unit ? ` ${unit}` : ''}`;

// ---- agent tools (reads fenced; writes are benign self-entry, ungated) -----
function defineTools(ctx: PluginToolContext): void {
  const store = new HealthStore(ctx.db);

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
}

// ---- admin routes ----------------------------------------------------------
function parse<T>(req: Request, res: Response, schema: z.ZodType<T>): T | null {
  const r = schema.safeParse(req.body);
  if (!r.success) { res.status(400).json({ error: 'invalid request body', issues: z.treeifyError(r.error) }); return null; }
  return r.data;
}

function register(ctx: PluginContext): void {
  const store = new HealthStore(ctx.db);

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
      ] },
    ],
  },
  migrate,
  defineTools,
  register,
  assetsDir: fileURLToPath(new URL('./ui', import.meta.url)),
};

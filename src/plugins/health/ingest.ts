/**
 * Health document types for the ingestion core: a lab report → observations,
 * and a benefits/SBC → insurance coverage (plus the raw text kept searchable).
 * The commit handlers route the reviewed data into the health stores.
 */
import { z } from 'zod';
import type { PluginDb } from '../types.js';
import { IngestionStore, IngestionPipeline, type Extractor } from '../../ingestion/pipeline.js';
import { SdkVisionExtractor } from '../../ingestion/extractors.js';
import { HealthStore } from './store.js';
import { InsuranceStore } from './insurance.js';
import { DocumentStore } from './documents.js';

const today = () => new Date().toISOString().slice(0, 10);

export const LabReportSchema = z.array(z.object({
  label: z.string().min(1),
  value: z.number(),
  unit: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  ref_low: z.number().nullable().optional(),
  ref_high: z.number().nullable().optional(),
}));

export const SbcSchema = z.object({
  benefits: z.array(z.object({
    category: z.string().min(1),
    network: z.enum(['in', 'out']).nullable().optional(),
    cost_type: z.enum(['copay', 'coinsurance', 'covered', 'not_covered']),
    amount: z.number().nullable().optional(),
    after_deductible: z.boolean().nullable().optional(),
  })),
});

export function buildHealthPipeline(db: PluginDb, extractor: Extractor = new SdkVisionExtractor()): IngestionPipeline {
  const health = new HealthStore(db);
  const ins = new InsuranceStore(db);
  const docs = new DocumentStore(db);
  const pipeline = new IngestionPipeline(new IngestionStore(db), extractor);

  pipeline.registerType({
    id: 'lab_report',
    label: 'Lab report',
    schema: LabReportSchema,
    instructions: 'Extract every lab result as an array of objects {label, value, unit, date (YYYY-MM-DD if shown), ref_low, ref_high}. One object per marker; use null when a field is absent.',
    commit: (data) => {
      for (const o of data as z.infer<typeof LabReportSchema>) {
        health.addObservation({
          date: o.date || today(), kind: 'lab', label: o.label, value: o.value,
          unit: o.unit ?? undefined, ref_low: o.ref_low ?? undefined, ref_high: o.ref_high ?? undefined, source: 'photo',
        });
      }
    },
  });

  pipeline.registerType({
    id: 'sbc',
    label: 'Benefits / SBC',
    schema: SbcSchema,
    instructions: "Extract the plan's cost-sharing as {benefits: [{category, network ('in'/'out'), cost_type ('copay'|'coinsurance'|'covered'|'not_covered'), amount ($ for copay, % for coinsurance), after_deductible}]}. Include PCP, Specialist, ER, Urgent care, Generic/Brand Rx, Imaging, Labs, and Preventive when present.",
    commit: (data, { record }) => {
      const parsed = data as z.infer<typeof SbcSchema>;
      let plan = ins.activePlan();
      if (!plan) {
        const id = ins.addPlan({ plan_year: new Date().getFullYear(), carrier: '', plan_name: record.title || 'Imported plan' });
        plan = ins.getPlan(id)!;
      }
      for (const b of parsed.benefits) {
        ins.addBenefit({
          plan_id: plan.id, category: b.category, network: b.network ?? 'in',
          cost_type: b.cost_type, amount: b.amount ?? 0, after_deductible: b.after_deductible ?? false,
        });
      }
      // Keep the raw doc searchable for the long tail (search_benefits).
      docs.add({ category: 'benefits', title: record.title || 'SBC', source: record.source, text: record.original });
    },
  });

  return pipeline;
}

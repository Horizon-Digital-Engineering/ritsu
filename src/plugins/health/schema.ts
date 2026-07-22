import { z } from 'zod';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

export const ObservationSchema = z.object({
  date: dateStr,
  kind: z.enum(['weight', 'lab', 'vital', 'other']).default('other'),
  label: z.string().trim().min(1).max(80),
  value: z.number(),
  unit: z.string().trim().max(20).optional(),
  ref_low: z.number().nullable().optional(),
  ref_high: z.number().nullable().optional(),
  note: z.string().trim().max(2000).optional(),
});

export const MedicationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dose: z.string().trim().max(60).optional(),
  frequency: z.string().trim().max(60).optional(),
  route: z.string().trim().max(40).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  prescriber: z.string().trim().max(120).optional(),
  rx_number: z.string().trim().max(60).optional(),
  pharmacy: z.string().trim().max(120).optional(),
  note: z.string().trim().max(2000).optional(),
});

export const StopMedSchema = z.object({ end_date: dateStr });

const nonNegNullable = z.number().nonnegative().nullable().optional();

export const PlanSchema = z.object({
  plan_year: z.number().int().min(2000).max(2100),
  carrier: z.string().trim().min(1).max(120),
  plan_name: z.string().trim().min(1).max(160),
  plan_type: z.string().trim().max(40).optional(),
  member_id: z.string().trim().max(80).optional(),
  group_number: z.string().trim().max(80).optional(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  premium_monthly: nonNegNullable,
  deductible_individual: nonNegNullable,
  deductible_family: nonNegNullable,
  oop_max_individual: nonNegNullable,
  oop_max_family: nonNegNullable,
  note: z.string().trim().max(2000).optional(),
});

export const BenefitSchema = z.object({
  plan_id: z.number().int().positive(),
  category: z.string().trim().min(1).max(80),
  network: z.enum(['in', 'out']).optional(),
  cost_type: z.enum(['copay', 'coinsurance', 'covered', 'not_covered']),
  amount: z.number().nonnegative().optional(),
  after_deductible: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

export const ProgressSchema = z.object({ deductible_met: z.number().nonnegative(), oop_met: z.number().nonnegative() });

export const DocumentSchema = z.object({
  category: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(500_000),
  ref_type: z.string().trim().max(40).optional(),
  ref_id: z.number().int().positive().nullable().optional(),
});

export const IngestSchema = z.object({
  doc_type: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  text: z.string().max(500_000).optional(),
  image: z.string().max(20_000_000).optional().describe('base64 image data'),
  media_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']).optional(),
}).refine(b => !!b.text || !!b.image, { message: 'text or image required' });

export const ConfirmSchema = z.object({ data: z.unknown().optional() });

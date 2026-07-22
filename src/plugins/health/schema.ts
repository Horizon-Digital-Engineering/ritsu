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

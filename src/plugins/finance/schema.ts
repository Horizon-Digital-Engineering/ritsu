import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM');
const idish = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().max(max);
const slug = z.string().trim().regex(/^[a-z0-9_]{1,40}$/, 'lowercase letters, digits, underscores');

export const ACCOUNT_TYPES = ['depository', 'credit', 'loan', 'investment', 'property', 'other'] as const;

// ---- connections ------------------------------------------------------------
export const PlaidConfigSchema = z.object({
  client_id: z.string().trim().min(1),
  secret: z.string().trim().min(1),
  env: z.enum(['sandbox', 'production']).default('sandbox'),
});
export const ExchangeSchema = z.object({ public_token: z.string().trim().min(1) });
export const SandboxLinkSchema = z.object({ institution_id: z.string().trim().optional() });
export const SimpleFinSetupSchema = z.object({ setup_token: z.string().trim().min(10).max(4000), label: text(80).optional() });

// ---- accounts ---------------------------------------------------------------
export const ManualAccountSchema = z.object({
  name: text(80).min(1),
  type: z.enum(ACCOUNT_TYPES),
  balance: z.number(),
  currency: z.string().trim().length(3).default('USD'),
  institution: text(80).default(''),
});
export const AccountPatchSchema = z.object({
  name: text(80).min(1).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  institution: text(80).optional(),
  hidden: z.boolean().optional(),
  closed: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});
export const BalanceSchema = z.object({ balance: z.number(), as_of: date.optional() });

// ---- transactions -----------------------------------------------------------
export const TxnQuerySchema = z.object({
  from: date.optional(), to: date.optional(), account_id: idish.optional(), category_id: idish.optional(),
  q: text(100).optional(), uncategorized: z.coerce.boolean().optional(), unreviewed: z.coerce.boolean().optional(),
  include_excluded: z.coerce.boolean().optional(), include_pending: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(), offset: z.coerce.number().int().min(0).optional(),
});
export const ManualTxnSchema = z.object({
  account_id: idish, date, payee: text(120).min(1), amount: z.number(),
  category_id: idish.nullable().optional(), notes: text(500).optional(),
});
export const TxnPatchSchema = z.object({
  payee: text(120).optional(), category_id: idish.nullable().optional(), notes: text(500).optional(),
  excluded: z.boolean().optional(), reviewed: z.boolean().optional(), date: date.optional(), amount: z.number().optional(),
  tags: z.array(text(30).min(1)).max(20).optional(),
});
export const SplitsSchema = z.object({
  splits: z.array(z.object({ category_id: idish.nullable(), amount: z.number(), notes: text(200).optional() })).max(30),
});
export const BulkSchema = z.object({
  ids: z.array(idish).min(1).max(500),
  category_id: idish.nullable().optional(), reviewed: z.boolean().optional(), excluded: z.boolean().optional(),
});

// ---- categories / rules -----------------------------------------------------
export const CategorySchema = z.object({ id: slug, name: text(60).min(1), group_name: text(60).min(1), kind: z.enum(['expense', 'income', 'transfer']).default('expense') });
export const CategoryPatchSchema = z.object({ name: text(60).min(1).optional(), group_name: text(60).optional(), kind: z.enum(['expense', 'income', 'transfer']).optional(), archived: z.boolean().optional(), sort: z.number().int().optional() });
export const CategoryMapSchema = z.object({ provider_category: text(80).min(1), category_id: idish });
export const RuleSchema = z.object({
  priority: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
  field: z.enum(['any', 'payee', 'description']).default('any'),
  op: z.enum(['contains', 'equals', 'starts_with']).default('contains'),
  pattern: text(120).min(1),
  amount_min: z.number().nonnegative().nullable().default(null),
  amount_max: z.number().nonnegative().nullable().default(null),
  account_id: idish.nullable().default(null),
  set_category_id: idish.nullable().default(null),
  set_payee: text(120).nullable().default(null),
  set_excluded: z.boolean().nullable().default(null),
  set_tags: z.array(text(30).min(1)).max(10).default([]),
  apply_to_existing: z.boolean().default(false),
});
export const RulePatchSchema = RuleSchema.partial().omit({ apply_to_existing: true });

// ---- budgets / recurring / goals -------------------------------------------
export const BudgetSchema = z.object({ category_id: idish, month: z.union([month, z.literal('*')]).default('*'), amount: z.number().nonnegative() });
export const RecurringCreateSchema = z.object({
  display_name: text(80).min(1), amount: z.number(), cadence: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']),
  next_date: date, category_id: idish.nullable().default(null), account_id: idish.nullable().default(null),
});
export const RecurringPatchSchema = z.object({
  status: z.enum(['detected', 'confirmed', 'dismissed']).optional(), amount: z.number().optional(),
  category_id: idish.nullable().optional(), cadence: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']).optional(),
  next_date: date.optional(), display_name: text(80).min(1).optional(),
});
export const GoalSchema = z.object({
  name: text(80).min(1), kind: z.enum(['save', 'payoff']).default('save'), target_amount: z.number().positive(),
  target_date: date.nullable().default(null), account_ids: z.array(idish).max(20).default([]),
});
export const GoalPatchSchema = GoalSchema.partial();

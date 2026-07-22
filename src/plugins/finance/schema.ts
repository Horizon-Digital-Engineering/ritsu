import { z } from 'zod';

/** Plaid app credentials the operator configures once. */
export const ConfigSchema = z.object({
  client_id: z.string().trim().min(1),
  secret: z.string().trim().min(1),
  env: z.enum(['sandbox', 'production']).default('sandbox'),
});

/** Manual public_token exchange (fallback / advanced). */
export const ExchangeSchema = z.object({ public_token: z.string().trim().min(1) });

/** Sandbox instant-link (no Link UI) for testing the pipeline. */
export const SandboxLinkSchema = z.object({ institution_id: z.string().trim().optional() });

/** A light per-category monthly spending target. */
export const TargetSchema = z.object({
  category: z.string().trim().min(1).max(64),
  monthly_limit: z.number().nonnegative(),
});

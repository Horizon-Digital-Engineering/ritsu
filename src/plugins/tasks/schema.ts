import { z } from 'zod';

export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const TagsSchema = z.array(z.string().min(1).max(40)).max(8);
export const StatusSchema = z.enum(['open', 'done', 'dropped']);

export const SessionCreateSchema = z.object({
  conversation_id: z.number().int().positive(),
  topic: z.string().max(120).default(''),
});

export const SessionPatchSchema = z.object({
  topic: z.string().max(120),
});

export const ItemCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(4000).default(''),
  tags: TagsSchema.default([]),
  due: DateSchema.nullable().default(null),
  priority: z.number().int().min(0).max(1).default(0),
  parent_id: z.number().int().positive().nullable().default(null),
  session_id: z.number().int().positive().nullable().default(null),
});

export const ItemPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(4000).optional(),
  tags: TagsSchema.optional(),
  due: DateSchema.nullable().optional(),
  priority: z.number().int().min(0).max(1).optional(),
  blocker: z.string().max(500).optional(),
  status: StatusSchema.optional(),
  reason: z.string().max(500).default(''),
  session_id: z.number().int().positive().nullable().default(null),
});

export const PullSchema = z.object({
  item_id: z.number().int().positive(),
});

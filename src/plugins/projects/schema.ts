import { z } from 'zod';

export const ProjectWriteSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase kebab-case').max(128),
  name: z.string().min(1).max(200),
  working_dir: z.string().max(512).default(''),
  description: z.string().max(4000).default(''),
  enabled: z.boolean().default(true),
});

export const TaskStatusSchema = z.enum(['backlog', 'doing', 'done', 'blocked']);

export const TaskCreateSchema = z.object({
  project_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'project_id must be lowercase kebab-case').max(128),
  title: z.string().min(1).max(200),
  status: TaskStatusSchema.default('backlog'),
  detail: z.string().max(4000).default(''),
});

export const TaskPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: TaskStatusSchema.optional(),
  detail: z.string().max(4000).optional(),
  position: z.number().int().optional(),
});

export type ProjectWriteInput = z.infer<typeof ProjectWriteSchema>;
export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskPatchInput = z.infer<typeof TaskPatchSchema>;

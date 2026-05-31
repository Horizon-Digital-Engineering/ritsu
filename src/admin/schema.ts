import { z } from 'zod';

export const DispatcherKindSchema = z.enum(['claude-direct', 'litellm']);
export const MemoryBackendSchema = z.enum(['sqlite', 'flashback']);

export const AgentDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase kebab-case'),
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  system_prompt: z.string().min(1),
  dispatcher: DispatcherKindSchema,
  model: z.string().min(1),
  /** Which memory backend this agent reads/writes. V1 supports 'sqlite'; 'flashback' is wired for the stub. */
  memory_backend: MemoryBackendSchema.default('sqlite'),
  tools_allowlist: z.array(z.string()).default([]),
  /** Agent ids this agent is allowed to ask_agent. Empty = cannot call any agent. */
  can_call: z.array(z.string()).default([]),
  /** Phase A (today): stored but not yet consumed. Phase B wires these into
   *  a new ritsu-agent runtime that uses an explicit provider + api key
   *  instead of the Claude Agent SDK's Max-plan session. NULL provider =
   *  legacy claude-sdk path (current default for all existing agents). */
  provider: z.enum(['anthropic', 'openai', 'openai-compat', 'litellm']).nullable().default(null),
  api_key_ref: z.number().int().positive().nullable().default(null),
  /** Free-form provider opts: temperature, max_tokens, base_url override, etc. */
  provider_options: z.record(z.string(), z.unknown()).default({}),
  /** Per-agent capabilities. 'manage_agents' unlocks agent-admin MCP tools
   *  (create/update/reload other agents). 'monitor_agents' unlocks read-only
   *  inspection across the whole swarm (conversations, messages, memories,
   *  state). Empty default — every agent stays scoped to its own surface. */
  capabilities: z.array(z.enum(['manage_agents', 'monitor_agents'])).default([]),
  /** Tool names this agent must get operator approval for before each use
   *  (e.g. ['Bash','Write']). The agent's turn blocks on a pending approval
   *  until the operator approves or rejects. Empty = no gating. */
  approval_tools: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  created_at: z.number().int().optional(),
  updated_at: z.number().int().optional(),
  /** One-step undo target. Populated by the store on save when system_prompt changes. */
  previous_system_prompt: z.string().nullable().optional(),
  previous_saved_at: z.number().int().nullable().optional(),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentDefinitionPatchSchema = AgentDefinitionSchema.partial().omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type AgentDefinitionPatch = z.infer<typeof AgentDefinitionPatchSchema>;

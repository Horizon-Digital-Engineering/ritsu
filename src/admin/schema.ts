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
   *  state). 'crm' unlocks the email tools (read_inbox/read_email/send_email,
   *  send always approval-gated). 'social' unlocks the X/Twitter tools
   *  (read_mentions/read_my_posts/post_tweet, post always gated). Empty
   *  default — every agent stays scoped to its own surface. */
  capabilities: z.array(z.enum(['manage_agents', 'monitor_agents', 'crm', 'social'])).default([]),
  /** Tool names this agent must get operator approval for before each use
   *  (e.g. ['Bash','Write']). The agent's turn blocks on a pending approval
   *  until the operator approves or rejects. Empty = no gating. */
  approval_tools: z.array(z.string()).default([]),
  /** Plugin ids this agent may use. Empty = no plugin access. Each id must be
   *  an installed, enabled plugin; the agent then gets that plugin's
   *  agent-facing tools (mutating ones stay approval-gated). Same allowlist
   *  pattern for every plugin — new plugins need no new wiring. */
  plugins: z.array(z.string()).default([]),
  /** When true, a capability-escalation ask_agent call (caller lacks a
   *  capability the target holds) is routed to the operator approval screen
   *  instead of being hard-denied. Default false = hard-deny (the safe
   *  baseline). IGNORED for injection-exposed agents (crm/social), which
   *  always hard-deny regardless — see the comms escalation guard. */
  escalation_approvable: z.boolean().default(false),
  /** When true, this agent's conversations and memory may be read by an agent
   *  holding the `monitor_agents` capability. Default false = opaque: the
   *  monitor capability alone grants nothing; each target must opt in. A
   *  monitor can always read its OWN data regardless of this flag. */
  allow_monitor_read: z.boolean().default(false),
  enabled: z.boolean().default(true),
  created_at: z.number().int().optional(),
  updated_at: z.number().int().optional(),
  /** One-step undo target. Populated by the store on save when system_prompt changes. */
  previous_system_prompt: z.string().nullable().optional(),
  previous_saved_at: z.number().int().nullable().optional(),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Capabilities an AGENT may grant another agent via the agent-admin tools.
 *  'crm' and 'social' unlock external-world access + stored credentials
 *  (mailbox, social accounts), so they are OPERATOR-ONLY — settable only via
 *  the admin API, never agent-to-agent. Otherwise a `manage_agents` agent
 *  could self-grant inbox access (read_inbox is ungated) with no approval. */
export const AGENT_GRANTABLE_CAPABILITIES = ['manage_agents', 'monitor_agents'] as const;

/** Throw if a capability list (from an agent-initiated create/update) includes
 *  an operator-only capability. Call from every agent-admin write surface. */
export function assertGrantableCapabilities(caps: readonly string[] | undefined): void {
  if (!caps) return;
  const forbidden = caps.filter(c => !(AGENT_GRANTABLE_CAPABILITIES as readonly string[]).includes(c));
  if (forbidden.length) {
    throw new Error(`capabilities [${forbidden.join(', ')}] are operator-only and cannot be granted by an agent`);
  }
}

export const AgentDefinitionPatchSchema = AgentDefinitionSchema.partial().omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type AgentDefinitionPatch = z.infer<typeof AgentDefinitionPatchSchema>;

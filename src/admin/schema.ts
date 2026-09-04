import { z } from 'zod';

/** The two-tier runtime model.
 *  - `direct`: the vendor's own agent runtime, riding a subscription
 *    (claude today; chatgpt/gemini/grok land as their dispatchers ship).
 *  - `api`: ritsu's own tool loop against a metered model API. */
export const RuntimeSchema = z.enum(['direct', 'api']);

/** Vendors available under the `direct` runtime. Grows one entry per
 *  vendor-runtime dispatcher we ship. */
export const DIRECT_PROVIDERS = ['claude'] as const;

/** Providers available under the `api` runtime. anthropic/openai/gemini use
 *  official SDKs; xai's documented path is its OpenAI-compatible API;
 *  openrouter/litellm/custom share the generic wire client. */
export const API_PROVIDERS = ['anthropic', 'openai', 'gemini', 'xai', 'openrouter', 'litellm', 'custom'] as const;

/** api-runtime providers that may run keyless (local proxy / custom
 *  endpoint); every other api provider requires an api_key_ref. */
export const KEYLESS_API_PROVIDERS: readonly string[] = ['litellm', 'custom'];

/** Per-agent memory backend. Only sqlite exists: the flashback value is a
 *  leftover from the abandoned pluggable-MemoryStore design, and its store
 *  throws on construction — accepting it here persisted a row that killed
 *  every subsequent boot. The remote store is reached through the
 *  MemoryService seam instead, configured once for the whole server. */
export const MemoryBackendSchema = z.enum(['sqlite']);

const AgentDefinitionBase = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase kebab-case'),
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  system_prompt: z.string().min(1),
  runtime: RuntimeSchema.default('direct'),
  model: z.string().min(1),
  /** Which memory backend this agent reads/writes. V1 supports 'sqlite'; 'flashback' is wired for the stub. */
  memory_backend: MemoryBackendSchema.default('sqlite'),
  tools_allowlist: z.array(z.string()).default([]),
  /** Agent ids this agent is allowed to ask_agent. Empty = cannot call any agent. */
  can_call: z.array(z.string()).default([]),
  /** Vendor/provider under the chosen runtime; the runtime decides which set
   *  is valid (DIRECT_PROVIDERS vs API_PROVIDERS — see the superRefine). */
  provider: z.string().min(1).default('claude'),
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

/** Cross-field rules the runtime/provider split introduces. Kept out of the
 *  base object so the Patch schema can stay a plain .partial(). */
function refineRuntimeProvider(def: { runtime: 'direct' | 'api'; provider: string; api_key_ref: number | null; provider_options: Record<string, unknown> }, ctx: z.RefinementCtx): void {
  if (def.runtime === 'direct') {
    if (!(DIRECT_PROVIDERS as readonly string[]).includes(def.provider)) {
      ctx.addIssue({ code: 'custom', path: ['provider'], message: `direct runtime supports: ${DIRECT_PROVIDERS.join(', ')}` });
    }
    return;
  }
  if (!(API_PROVIDERS as readonly string[]).includes(def.provider)) {
    ctx.addIssue({ code: 'custom', path: ['provider'], message: `api runtime supports: ${API_PROVIDERS.join(', ')}` });
    return;
  }
  if (def.api_key_ref === null && !KEYLESS_API_PROVIDERS.includes(def.provider)) {
    ctx.addIssue({ code: 'custom', path: ['api_key_ref'], message: `provider '${def.provider}' requires an api_key_ref` });
  }
  if (def.provider === 'custom' && typeof def.provider_options.base_url !== 'string') {
    ctx.addIssue({ code: 'custom', path: ['provider_options'], message: "provider 'custom' requires provider_options.base_url" });
  }
}

export const AgentDefinitionSchema = AgentDefinitionBase.superRefine(refineRuntimeProvider);

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * Fields only an operator may set, on any agent-initiated or MCP-initiated
 * write. Two distinct dangers:
 *
 *   api_key_ref + provider_options — together an exfiltration primitive.
 *     One names a stored credential by a small integer id, the other carries
 *     the base_url the decrypted key is sent to. A caller who can set both
 *     enumerates every key straight to a host it controls.
 *
 *   capabilities, approval_tools, escalation_approvable, allow_monitor_read —
 *     privilege and gating. An agent that can rewrite these on a peer can
 *     strip that peer's operator approval, or make it readable by monitors.
 *
 * The admin API is deliberately NOT filtered: an operator setting these is
 * the supported path.
 */
export const OPERATOR_ONLY_FIELDS = [
  'api_key_ref', 'provider_options', 'capabilities',
  'approval_tools', 'escalation_approvable', 'allow_monitor_read',
] as const;

/** Zero the operator-only fields on a newly-created definition. */
export function clearOperatorOnlyFields(def: AgentDefinition): void {
  def.api_key_ref = null;
  def.provider_options = {};
  def.capabilities = [];
  def.approval_tools = [];
  def.escalation_approvable = false;
  def.allow_monitor_read = false;
}

/** Carry the operator-only fields over from the stored definition, so a patch
 *  cannot change them however it was shaped. */
export function preserveOperatorOnlyFields(current: AgentDefinition, next: AgentDefinition): void {
  next.api_key_ref = current.api_key_ref;
  next.provider_options = current.provider_options;
  next.capabilities = current.capabilities;
  next.approval_tools = current.approval_tools;
  next.escalation_approvable = current.escalation_approvable;
  next.allow_monitor_read = current.allow_monitor_read;
}

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

export const AgentDefinitionPatchSchema = AgentDefinitionBase.partial().omit({
  id: true,
  created_at: true,
  updated_at: true,
});

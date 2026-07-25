/**
 * Per-agent in-process MCP server exposing AGENT-MANAGEMENT tools.
 *
 * Gated by the caller's `capabilities` list including `'manage_agents'`.
 * The capability check happens at the AgentHost / dispatcher layer — if
 * this MCP server is wired into a turn, the caller IS authorized; no
 * second check needed inside each tool.
 *
 * Tools (each prefixed `mcp__agent_admin__` when reaching the model):
 *
 *   create_agent(...)    Mint a new agent definition + wire it live.
 *   update_agent(...)    Patch fields on an existing agent + rewire it.
 *   reload_agent(...)    Rebuild an agent's live instance from its DB row.
 *
 * Mirrors the external MCP server's create/update/reload exactly — same
 * Zod schema, same error semantics — but exposed inside the in-process
 * MCP for agent-initiated calls. Intentional asymmetry: an agent with
 * this capability CAN create another agent; it CANNOT delete one (delete
 * has bigger blast radius and stays operator-only).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  AgentDefinitionSchema,
  AgentDefinitionPatchSchema,
  RuntimeSchema,
  MemoryBackendSchema,
  assertGrantableCapabilities,
} from '../../admin/schema.js';
import type { AgentDefinitionStore } from '../../agent-definition-store.js';
import { logger } from '../../util/log.js';

export const ADMIN_MCP_NAME = 'agent_admin';
export const ADMIN_TOOL_NAMES = [
  `mcp__${ADMIN_MCP_NAME}__create_agent`,
  `mcp__${ADMIN_MCP_NAME}__update_agent`,
  `mcp__${ADMIN_MCP_NAME}__reload_agent`,
] as const;

/** Minimal AgentHost surface so this module doesn't import the full class. */
export interface AdminHost {
  addOrReplace(def: import('../../admin/schema.js').AgentDefinition): void;
}

export interface AgentAdminDeps {
  defStore: AgentDefinitionStore;
  host: AdminHost;
}

export function buildAgentAdminMcp(callerAgentId: string, deps: AgentAdminDeps) {
  return createSdkMcpServer({
    name: ADMIN_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'create_agent',
        'Create a new agent and wire it live. The new agent is immediately callable via ask_agent ' +
          '(if your can_call list includes its id, or after an admin edit adds it). Choose a stable ' +
          'lowercase kebab-case id — it cannot be changed later.',
        {
          id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/)
            .describe('Stable kebab-case identifier. Cannot be changed later.'),
          type: z.string().default('generic').describe('Agent class key (almost always "generic").'),
          name: z.string().describe('Human-readable name.'),
          description: z.string().describe('Short description of what the agent does.'),
          system_prompt: z.string().describe("System prompt defining the agent's persona and rules."),
          runtime: RuntimeSchema.default('direct').describe("Runtime tier: 'direct' (vendor runtime, provider 'claude') or 'api' (ritsu loop against a metered provider)."),
          provider: z.string().default('claude').describe('Provider under the runtime (direct: claude; api: anthropic/openai/gemini/xai/openrouter/litellm/custom).'),
          model: z.string().describe('Model name passed to the provider.'),
          memory_backend: MemoryBackendSchema.default('sqlite'),
          tools_allowlist: z.array(z.string()).default([])
            .describe('SDK tool names this agent may use (Read, Bash, etc.). Empty = no tools.'),
          can_call: z.array(z.string()).default([])
            .describe('Agent ids the new agent may ask_agent. Empty = no inter-agent calls.'),
          capabilities: z.array(z.enum(['manage_agents', 'monitor_agents'])).default([])
            .describe('Per-agent capabilities. Empty by default — DO NOT grant manage_agents to a new agent without a clear reason.'),
          enabled: z.boolean().default(true),
        },
        async (args) => {
          const validated = AgentDefinitionSchema.parse(args);
          // Defense-in-depth: the inline enum already blocks crm/social, but
          // assert again so the rule holds if that schema ever loosens.
          assertGrantableCapabilities(validated.capabilities);
          const existing = await deps.defStore.read(validated.id);
          if (existing) {
            return { content: [{ type: 'text', text: `error: agent ${validated.id} already exists; use update_agent` }] };
          }
          const saved = await deps.defStore.upsert(validated);
          deps.host.addOrReplace(saved);
          logger.info('agent-admin.create', { by: callerAgentId, id: saved.id });
          return { content: [{ type: 'text', text: `created ${saved.id}` }] };
        },
      ),
      tool(
        'update_agent',
        'Update one or more fields on an existing agent. Only the fields you pass in `patch` change. ' +
          'Pass {enabled: false} to disable an agent without deleting it.',
        {
          agent_id: z.string().describe('Stable id of the agent to update.'),
          patch: z.object({
            type: z.string().optional(),
            name: z.string().optional(),
            description: z.string().optional(),
            system_prompt: z.string().optional(),
            runtime: RuntimeSchema.optional(),
            provider: z.string().optional(),
            model: z.string().optional(),
            memory_backend: MemoryBackendSchema.optional(),
            tools_allowlist: z.array(z.string()).optional(),
            can_call: z.array(z.string()).optional(),
            capabilities: z.array(z.enum(['manage_agents', 'monitor_agents'])).optional(),
            enabled: z.boolean().optional(),
          }).describe('Partial definition; only the fields you want to change.'),
        },
        async ({ agent_id, patch }) => {
          // Self-modification via agent-admin is operator-only.
          if (agent_id === callerAgentId) {
            return { content: [{ type: 'text', text: 'error: an agent cannot modify itself via agent-admin (operator-only)' }] };
          }
          const current = await deps.defStore.read(agent_id);
          if (!current) return { content: [{ type: 'text', text: `error: agent ${agent_id} not found` }] };
          const validPatch = AgentDefinitionPatchSchema.parse(patch);
          assertGrantableCapabilities(validPatch.capabilities);
          const merged = AgentDefinitionSchema.parse({ ...current, ...validPatch, id: current.id });
          const saved = await deps.defStore.upsert(merged);
          deps.host.addOrReplace(saved);
          logger.info('agent-admin.update', { by: callerAgentId, id: saved.id, fields: Object.keys(validPatch) });
          return { content: [{ type: 'text', text: `updated ${saved.id}` }] };
        },
      ),
      tool(
        'reload_agent',
        "Rebuild an agent's live instance from its current DB row. Useful after out-of-band changes " +
          'or to force a fresh memory read.',
        {
          agent_id: z.string().describe('Stable id of the agent to reload.'),
        },
        async ({ agent_id }) => {
          const def = await deps.defStore.read(agent_id);
          if (!def) return { content: [{ type: 'text', text: `error: agent ${agent_id} not found` }] };
          deps.host.addOrReplace(def);
          logger.info('agent-admin.reload', { by: callerAgentId, id: def.id });
          return { content: [{ type: 'text', text: `reloaded ${def.id}` }] };
        },
      ),
    ],
  });
}

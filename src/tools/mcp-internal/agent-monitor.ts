/**
 * Per-agent in-process MCP server exposing READ-ONLY SWARM INSPECTION tools.
 *
 * Gated by the caller's `capabilities` list including `'monitor_agents'`.
 * Wired into the agent's MCP surface by AgentHost only when the capability
 * is set — if the server is present in a turn, the caller IS authorized.
 *
 * Tools (each prefixed `mcp__agent_monitor__` when reaching the model):
 *
 *   list_agents()                        Every agent (id, name, description, enabled),
 *                                        not just can_call-filtered.
 *   list_conversations(agent_id?, kind?) Recent conversations involving the given agent,
 *                                        or across the whole swarm if agent_id omitted.
 *   read_conversation(id, limit?)        Read messages from a conversation. Caller-label
 *                                        attribution preserved so the monitor can see
 *                                        who said what.
 *   read_memory(agent_id, limit?)        Read another agent's active memories.
 *
 * No write surface — monitoring is observation only. If the manager needs to
 * intervene, it should ask_agent (with appropriate can_call) or carry the
 * manage_agents capability separately.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentDefinitionStore } from '../../agent-definition-store.js';
import type { ConversationStore } from '../../conversation-store.js';
import type { MemoryStore } from '../../memory-store.js';
import { logger } from '../../util/log.js';

export const MONITOR_MCP_NAME = 'agent_monitor';
export const MONITOR_TOOL_NAMES = [
  `mcp__${MONITOR_MCP_NAME}__list_agents`,
  `mcp__${MONITOR_MCP_NAME}__list_conversations`,
  `mcp__${MONITOR_MCP_NAME}__read_conversation`,
  `mcp__${MONITOR_MCP_NAME}__read_memory`,
] as const;

export interface AgentMonitorDeps {
  defStore: AgentDefinitionStore;
  conversations: ConversationStore;
  memory: MemoryStore;
}

/**
 * Whether a `monitor_agents`-capable caller may read the target agent's
 * conversations/memory. Default-DENY: the monitor capability alone grants
 * nothing — each target agent must set `allow_monitor_read`. A monitor can
 * always read its OWN data (targetId === callerId), which isn't a cross-agent
 * read. Shared by both runtimes (MCP here, ritsu-agent's builtin tools).
 */
export async function monitorReadAllowed(
  defStore: AgentDefinitionStore,
  callerAgentId: string,
  targetAgentId: string,
): Promise<boolean> {
  if (targetAgentId === callerAgentId) return true;
  const def = await defStore.read(targetAgentId);
  return !!def?.allow_monitor_read;
}

/** Uniform opt-out message the model sees when a target hasn't opted in. */
export function monitorOptOutMessage(targetAgentId: string): string {
  return `agent '${targetAgentId}' has not opted into monitor reads ` +
    '(its allow_monitor_read is off), so its conversations and memory are opaque to you.';
}

export function buildAgentMonitorMcp(callerAgentId: string, deps: AgentMonitorDeps) {
  return createSdkMcpServer({
    name: MONITOR_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'list_agents',
        'List every agent registered on this server (id, name, description, enabled, dispatcher). ' +
          'Unlike mcp__agent_comms__list_agents, this is NOT filtered to your can_call allowlist — ' +
          'monitoring sees the whole swarm.',
        {},
        async () => {
          const all = await deps.defStore.list();
          const text = all.length === 0
            ? '(no agents registered)'
            : all
                .map(a => {
                  const readable = a.allow_monitor_read || a.id === callerAgentId ? 'readable' : 'opaque';
                  return `[${a.id}] ${a.name} (${a.enabled ? 'enabled' : 'disabled'}, ${a.runtime}:${a.provider}/${a.model}, monitor:${readable}) — ${a.description}`;
                })
                .join('\n');
          logger.info('agent-monitor.list_agents', { by: callerAgentId, count: all.length });
          return { content: [{ type: 'text', text }] };
        },
      ),
      tool(
        'list_conversations',
        'List recent conversations. Pass agent_id to filter to threads where that agent is on ' +
          'either side (it received OR it called). Omit agent_id to see the whole swarm. `kind` ' +
          "filters: 'human' (operator ↔ agent), 'agent' (agent ↔ agent), 'all' (default).",
        {
          agent_id: z.string().optional().describe('Filter to threads involving this agent (either side).'),
          kind: z.enum(['human', 'agent', 'all']).default('all'),
          limit: z.number().int().positive().max(200).default(50),
        },
        async ({ agent_id, kind, limit }) => {
          // Targeted: the named agent must have opted in. Swarm-wide: keep only
          // conversations whose primary agent opted in (or the caller's own).
          if (agent_id && !(await monitorReadAllowed(deps.defStore, callerAgentId, agent_id))) {
            return { content: [{ type: 'text', text: monitorOptOutMessage(agent_id) }] };
          }
          const raw = deps.conversations.listSummaries(undefined, limit, kind, agent_id);
          const all = await deps.defStore.list();
          const readable = new Set(all.filter(a => a.allow_monitor_read || a.id === callerAgentId).map(a => a.id));
          const summaries = raw.filter(s => readable.has(s.agent_id));
          if (summaries.length === 0) {
            return { content: [{ type: 'text', text: '(no conversations match, or none from agents that opted into monitor reads)' }] };
          }
          const text = summaries
            .map(s => {
              const side = s.caller_agent_id ? `${s.caller_agent_id} → ${s.agent_id}` : `human → ${s.agent_id}`;
              const status = s.ended_at ? 'ended' : 'open';
              return `[${s.id}] ${side} · ${s.message_count} msg · ${status} · ${s.title || '(no title)'}`;
            })
            .join('\n');
          logger.info('agent-monitor.list_conversations', {
            by: callerAgentId, target: agent_id ?? null, count: summaries.length,
          });
          return { content: [{ type: 'text', text }] };
        },
      ),
      tool(
        'read_conversation',
        'Read messages from a conversation. Returns the most recent `limit` messages in chronological ' +
          'order with caller attribution preserved so you can see who said what.',
        {
          conversation_id: z.number().int().positive(),
          limit: z.number().int().positive().max(500).default(50),
        },
        async ({ conversation_id, limit }) => {
          const owner = deps.conversations.agentIdOf(conversation_id);
          if (owner === null) {
            return { content: [{ type: 'text', text: `(conversation ${conversation_id} not found)` }] };
          }
          if (!(await monitorReadAllowed(deps.defStore, callerAgentId, owner))) {
            return { content: [{ type: 'text', text: monitorOptOutMessage(owner) }] };
          }
          const msgs = deps.conversations.recent(conversation_id, limit);
          if (msgs.length === 0) {
            return { content: [{ type: 'text', text: '(no messages in this conversation)' }] };
          }
          const text = msgs
            .map(m => {
              const who = m.role === 'assistant'
                ? 'assistant'
                : m.caller_label ?? m.role;
              return `[${who}] ${m.content}`;
            })
            .join('\n\n');
          logger.info('agent-monitor.read_conversation', {
            by: callerAgentId, conv: conversation_id, count: msgs.length,
          });
          return { content: [{ type: 'text', text }] };
        },
      ),
      tool(
        'read_memory',
        "Read another agent's active memories. Read-only: this tool can't write, update, or forget — " +
          'use it to understand what an agent currently knows.',
        {
          agent_id: z.string().describe('Target agent whose memories to read.'),
          limit: z.number().int().positive().max(500).default(50),
        },
        async ({ agent_id, limit }) => {
          if (!(await monitorReadAllowed(deps.defStore, callerAgentId, agent_id))) {
            return { content: [{ type: 'text', text: monitorOptOutMessage(agent_id) }] };
          }
          const mems = await deps.memory.list(agent_id, limit);
          if (mems.length === 0) {
            return { content: [{ type: 'text', text: `(agent ${agent_id} has no active memories)` }] };
          }
          const text = mems.map(m => `[${m.id}] ${m.content}`).join('\n');
          logger.info('agent-monitor.read_memory', { by: callerAgentId, target: agent_id, count: mems.length });
          return { content: [{ type: 'text', text }] };
        },
      ),
    ],
  });
}

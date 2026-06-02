/**
 * Per-agent in-process MCP server exposing memory tools to the Claude SDK
 * that's running the agent's turn. The agent_id is closed over so each
 * tool call is automatically scoped to "this agent" — no risk of an
 * agent writing to another agent's memory by passing a different id.
 *
 * Tools (each prefixed `mcp__memory__` when reaching the model):
 *
 *   remember(content)            persist a fact across turns/conversations
 *   update_memory(id, content)   supersede an existing memory with a new version
 *   forget(id)                   tombstone a memory (won't show in active list)
 *   list_memories(limit?)        read this agent's active memories
 *
 * Memories also get prepended to the system prompt at every turn via
 * agent_base.loadContext() — these tools let the agent (or one of its
 * sub-tools) GROW that context deliberately.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { MemoryStore } from '../../memory-store.js';
import { logger } from '../../util/log.js';
import { gateMcpTool, type McpGateContext } from './approval-gate.js';

export const MEMORY_MCP_NAME = 'memory';

export const MEMORY_TOOL_NAMES = [
  `mcp__${MEMORY_MCP_NAME}__remember`,
  `mcp__${MEMORY_MCP_NAME}__update_memory`,
  `mcp__${MEMORY_MCP_NAME}__forget`,
  `mcp__${MEMORY_MCP_NAME}__list_memories`,
] as const;

export function buildAgentMemoryMcp(agentId: string, store: MemoryStore, gate: McpGateContext | null = null) {
  return createSdkMcpServer({
    name: MEMORY_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'remember',
        'Save a fact / preference / context note so future conversations with this same agent will see it. ' +
          'Use sparingly — these go into every future turn\'s system prompt. Prefer short, durable, true-tomorrow notes ' +
          '("user prefers metric units", "the audit deadline is 2026-07-15"); not transient state ("currently writing section 3").',
        {
          content: z.string().min(1).max(4000)
            .describe('The fact to remember. One self-contained sentence is ideal.'),
        },
        async ({ content }) => gateMcpTool(gate, MEMORY_TOOL_NAMES[0], { content }, async () => {
          const id = await store.write({ agent_id: agentId, content });
          logger.info('memory.remember', { agent_id: agentId, id, content_len: content.length });
          return { content: [{ type: 'text', text: `remembered (id=${id})` }] };
        }),
      ),
      tool(
        'update_memory',
        'Replace an existing memory with an updated version. The old version is preserved in the lineage chain; ' +
          'only the new version shows in the active list. Use when a fact changed (deadline moved, preference flipped).',
        {
          id: z.number().int().positive().describe('id of the memory to supersede'),
          content: z.string().min(1).max(4000).describe('the new content'),
        },
        async ({ id, content }) => gateMcpTool(gate, MEMORY_TOOL_NAMES[1], { id, content }, async () => {
          const newId = await store.write({ agent_id: agentId, content, supersedes: id });
          logger.info('memory.update', { agent_id: agentId, old_id: id, new_id: newId });
          return { content: [{ type: 'text', text: `updated (old id=${id}, new id=${newId})` }] };
        }),
      ),
      tool(
        'forget',
        'Tombstone a memory so it no longer appears in the active list. Use when something is no longer true or relevant. ' +
          'The row stays in the lineage history but is hidden from future turns.',
        {
          id: z.number().int().positive().describe('id of the memory to forget'),
        },
        async ({ id }) => gateMcpTool(gate, MEMORY_TOOL_NAMES[2], { id }, async () => {
          const ok = await store.delete(id);
          logger.info('memory.forget', { agent_id: agentId, id, ok });
          return {
            content: [{ type: 'text', text: ok ? `forgotten (id=${id})` : `nothing to forget (id=${id} not active)` }],
          };
        }),
      ),
      tool(
        'list_memories',
        'List this agent\'s active memories. Each memory is already injected into the system prompt at every turn — ' +
          'use this only when you need ids (e.g. to call update_memory or forget).',
        {
          limit: z.number().int().positive().max(500).optional()
            .describe('max number of memories to return (default 50)'),
        },
        async ({ limit }) => {
          const memories = await store.list(agentId, limit ?? 50);
          const text = memories.length === 0
            ? '(no active memories)'
            : memories.map(m => `[${m.id}] ${m.content}`).join('\n');
          return { content: [{ type: 'text', text }] };
        },
      ),
    ],
  });
}

/**
 * Workspace tools (in-process MCP) for the direct runtime:
 *
 *   mcp__skills__view_skill(name)          load a bound skill's instructions
 *   mcp__history__search_chats(query)      search this agent's own past chats
 *   mcp__history__view_chat(id, limit?)    read one of its own transcripts
 *
 * view_skill is operator-authored content — trusted, never fenced. History is
 * the opposite: a transcript can contain text that arrived through a channel,
 * so everything read back is fenced — a prompt injected last month must not
 * re-execute as fresh instructions when recalled today.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ConversationStore } from '../../conversation-store.js';
import { gateMcpTool, type McpGateContext } from './approval-gate.js';
import { fenceUntrusted } from '../../util/untrusted.js';
import { logger } from '../../util/log.js';

export const SKILLS_MCP_NAME = 'skills';
export const SKILLS_TOOL_NAMES = [`mcp__${SKILLS_MCP_NAME}__view_skill`] as const;
export const HISTORY_MCP_NAME = 'history';
export const HISTORY_TOOL_NAMES = [
  `mcp__${HISTORY_MCP_NAME}__search_chats`,
  `mcp__${HISTORY_MCP_NAME}__view_chat`,
] as const;

export interface SkillsLookup {
  content: (name: string) => string | null;
  manifest: () => Array<{ name: string; description: string }>;
}

export function buildAgentSkillsMcp(agentId: string, skills: SkillsLookup, gate: McpGateContext | null = null) {
  return createSdkMcpServer({
    name: SKILLS_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'view_skill',
        'Load the full instructions of one of your bound skills by name (your system context lists them). ' +
          'Call this when a task matches a skill\'s description, then follow the loaded instructions.',
        { name: z.string().min(1).max(120).describe('the skill name from your manifest') },
        async ({ name }) => gateMcpTool(gate, SKILLS_TOOL_NAMES[0], { name }, async () => {
          const body = skills.content(name);
          if (body === null) {
            const known = skills.manifest().map(s => s.name).join(', ') || '(none bound)';
            return { content: [{ type: 'text', text: `no bound skill named "${name}". Bound skills: ${known}` }] };
          }
          logger.info('skills.view', { agent_id: agentId, name });
          return { content: [{ type: 'text', text: body }] };
        }),
      ),
    ],
  });
}

/** Render a hit list the model can act on (ids it can pass to view_chat). */
export function formatSearchHits(hits: Array<{ id: number; title: string; snippet: string }>): string {
  if (!hits.length) return 'no chats matched.';
  return hits
    .map(h => {
      const snippet = h.snippet ? `\n    ${h.snippet}` : '';
      return `[chat ${h.id}] ${h.title || '(untitled)'}${snippet}`;
    })
    .join('\n');
}

export function formatTranscript(rows: Array<{ role: string; content: string }>): string {
  return rows
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role}: ${m.content}`)
    .join('\n\n');
}

export function buildAgentHistoryMcp(
  agentId: string,
  conversations: ConversationStore,
  gate: McpGateContext | null = null,
) {
  return createSdkMcpServer({
    name: HISTORY_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'search_chats',
        'Search your own past conversations by keywords (titles and message bodies; multi-word queries must all ' +
          'match somewhere in a chat). Returns chat ids + snippets — read one in full with view_chat.',
        { query: z.string().min(2).max(200).describe('keywords to search for') },
        async ({ query }) => gateMcpTool(gate, HISTORY_TOOL_NAMES[0], { query }, async () => {
          const hits = conversations.searchSummaries(agentId, query, 15);
          logger.info('history.search', { agent_id: agentId, q_len: query.length, hits: hits.length });
          // Titles/snippets can carry channel-borne text — fence the listing.
          return { content: [{ type: 'text', text: fenceUntrusted('own chat history search', formatSearchHits(hits)) }] };
        }),
      ),
      tool(
        'view_chat',
        'Read one of your own past conversations in full by its id (from search_chats).',
        {
          conversation_id: z.number().int().positive().describe('the chat id'),
          limit: z.number().int().min(1).max(200).optional().describe('most recent N messages (default 100)'),
        },
        async ({ conversation_id, limit }) => gateMcpTool(gate, HISTORY_TOOL_NAMES[1], { conversation_id, limit }, async () => {
          // Own history only: a guessed id belonging to another agent reads as absent.
          if (conversations.agentIdOf(conversation_id) !== agentId) {
            return { content: [{ type: 'text', text: `no chat ${conversation_id} in your history` }] };
          }
          const rows = conversations.recent(conversation_id, limit ?? 100);
          logger.info('history.view', { agent_id: agentId, conv: conversation_id, rows: rows.length });
          return {
            content: [{
              type: 'text',
              text: fenceUntrusted(`own past conversation ${conversation_id}`, formatTranscript(rows)),
            }],
          };
        }),
      ),
    ],
  });
}

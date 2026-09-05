/**
 * Native-loop twins of the direct runtime's skills + history MCP tools —
 * same behaviors, function-call names: view_skill, history_search_chats,
 * history_view_chat. History output is fenced for the same reason as the MCP
 * side: recalled transcripts can carry channel-borne text.
 */
import type { RaTool } from '../../model/ritsu-agent/types.js';
import type { ConversationStore } from '../../conversation-store.js';
import type { SkillsLookup } from '../mcp-internal/workspace-tools.js';
import { formatSearchHits, formatTranscript } from '../mcp-internal/workspace-tools.js';
import { fenceUntrusted } from '../../util/untrusted.js';
import { asString, asNumber } from '../../util/cast.js';
import { logger } from '../../util/log.js';

export function buildSkillTools(agentId: string, skills: SkillsLookup): RaTool[] {
  return [{
    name: 'view_skill',
    description:
      'Load the full instructions of one of your bound skills by name (your system context lists them). ' +
      'Call this when a task matches a skill\'s description, then follow the loaded instructions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1, maxLength: 120, description: 'the skill name from your manifest' } },
    },
    handler: async (args) => {
      const name = asString(args.name).trim();
      const body = skills.content(name);
      if (body === null) {
        const known = skills.manifest().map(s => s.name).join(', ') || '(none bound)';
        return `no bound skill named "${name}". Bound skills: ${known}`;
      }
      logger.info('skills.view', { agent_id: agentId, name });
      return body;
    },
  }];
}

export function buildHistoryTools(agentId: string, conversations: ConversationStore): RaTool[] {
  return [
    {
      name: 'history_search_chats',
      description:
        'Search your own past conversations by keywords (titles and message bodies; every word must match ' +
        'somewhere in a chat). Returns chat ids + snippets — read one in full with history_view_chat.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: { query: { type: 'string', minLength: 2, maxLength: 200 } },
      },
      handler: async (args) => {
        const query = asString(args.query).trim();
        if (query.length < 2) return 'error: query too short';
        const hits = conversations.searchSummaries(agentId, query, 15);
        logger.info('history.search', { agent_id: agentId, q_len: query.length, hits: hits.length });
        return fenceUntrusted('own chat history search', formatSearchHits(hits));
      },
    },
    {
      name: 'history_view_chat',
      description: 'Read one of your own past conversations in full by its id (from history_search_chats).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['conversation_id'],
        properties: {
          conversation_id: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
      handler: async (args) => {
        const cid = asNumber(args.conversation_id);
        if (cid == null || cid < 1) return 'error: conversation_id required';
        if (conversations.agentIdOf(Math.floor(cid)) !== agentId) {
          return `no chat ${cid} in your history`;
        }
        const limit = asNumber(args.limit);
        const rows = conversations.recent(Math.floor(cid), limit ? Math.min(Math.max(Math.floor(limit), 1), 200) : 100);
        logger.info('history.view', { agent_id: agentId, conv: cid, rows: rows.length });
        return fenceUntrusted(`own past conversation ${cid}`, formatTranscript(rows));
      },
    },
  ];
}

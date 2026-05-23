/**
 * Per-agent in-process MCP server exposing inter-agent messaging tools.
 *
 * Tools (each prefixed `mcp__agent_comms__` when reaching the model):
 *
 *   ask_agent(agent_id, message, conversation_id?)
 *     Send a message to another agent and get its reply. Enforced against
 *     the caller's `can_call` allowlist (re-read every call so admin edits
 *     take effect immediately). Loop-guarded by AsyncLocalStorage call
 *     depth (max MAX_CALL_DEPTH).
 *
 *   list_agents()
 *     Names of agents the caller is allowed to ask_agent.
 *
 * Conversation continuity: when conversation_id is omitted, the call lands
 * on the canonical (caller, target) thread so each agent pairing keeps one
 * long-running thread. An explicit conversation_id overrides.
 *
 * The caller's agent_id is closed over so each tool call is scoped to "this
 * agent is asking" — no risk of a target agent impersonating a different
 * caller by passing a different id.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentDefinitionStore } from '../../agent-definition-store.js';
import type { ConversationStore } from '../../conversation-store.js';
import { logger } from '../../util/log.js';

export const COMMS_MCP_NAME = 'agent_comms';
export const COMMS_TOOL_NAMES = [
  `mcp__${COMMS_MCP_NAME}__ask_agent`,
  `mcp__${COMMS_MCP_NAME}__list_agents`,
] as const;

/**
 * Max depth of a single ask_agent call chain. A → B → C is depth 3; a 4th
 * hop is refused. Tunable but kept conservative: most real-world coordination
 * patterns fit in 2-3 hops; deeper chains are usually a loop in disguise.
 */
export const MAX_CALL_DEPTH = 3;

interface CallContext {
  depth: number;
  /** Caller chain so far, including the current agent. Used only for error messages. */
  chain: string[];
}

const callContext = new AsyncLocalStorage<CallContext>();

export function currentCallContext(): CallContext | undefined {
  return callContext.getStore();
}

export function runInCallContext<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  return callContext.run(ctx, fn);
}

/** Minimal AgentHost surface — typed inline so this module doesn't import the
 *  full AgentHost class and create a cycle through claude-direct-dispatcher. */
export interface CommsHost {
  get(id: string): { onMessage(req: { message: string; conversation_id?: number; caller_label?: string | null }): Promise<{ reply: string; conversation_id: number }> };
}

export interface AgentCommsDeps {
  host: CommsHost;
  defStore: AgentDefinitionStore;
  conversations: ConversationStore;
}

/** Levenshtein edit distance — used to spot a typo'd agent id. */
function editDistance(a: string, b: string): number {
  const row: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * Builds the error returned when ask_agent targets an id outside the
 * caller's can_call allowlist. It lists what the caller CAN reach and, when
 * the target is a near-miss (edit distance ≤ 2 of an allowed id), names the
 * likely intended agent — so a model that typo'd an id self-corrects on its
 * next turn instead of repeating the mistake.
 */
export function buildDenialMessage(caller: string, target: string, allowed: string[]): string {
  if (allowed.length === 0) {
    return `denied: ${caller} has no agents in its can_call allowlist. ` +
      `Add agents to ${caller}'s "can_call" list in the admin UI to enable inter-agent calls.`;
  }
  let suggestion: string | null = null;
  let bestDist = 3; // only suggest within edit distance 2
  for (const id of allowed) {
    const d = editDistance(target, id);
    if (d < bestDist) {
      bestDist = d;
      suggestion = id;
    }
  }
  let msg = `denied: "${target}" is not in ${caller}'s can_call allowlist. ` +
    `You can call: ${allowed.join(', ')}.`;
  if (suggestion && suggestion !== target) {
    msg += ` Did you mean "${suggestion}"?`;
  }
  return msg;
}

export function buildAgentCommsMcp(callerAgentId: string, deps: AgentCommsDeps) {
  return createSdkMcpServer({
    name: COMMS_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'ask_agent',
        'Send a message to another agent and get its reply. Only agents in your `can_call` ' +
          "allowlist are reachable. Omit conversation_id to land in the canonical (you, target) " +
          "thread — this keeps related back-and-forth in one place so the target sees its history " +
          'with you. Pass an explicit conversation_id only when you specifically want a different thread.',
        {
          agent_id: z.string().describe('id of the target agent to call'),
          message: z.string().min(1).describe('what to say to the target'),
          conversation_id: z.number().int().positive().optional()
            .describe('optional: specific conversation to use; omit for the default (caller, target) thread'),
        },
        async ({ agent_id: target, message, conversation_id }) => {
          // Re-read the caller's definition at call time so admin edits to the
          // can_call list take effect immediately, not just on next agent reload.
          const def = await deps.defStore.read(callerAgentId);
          const allowed = def?.can_call ?? [];
          if (!allowed.includes(target)) {
            logger.warn('comms.denied', { caller: callerAgentId, target, reason: 'not_in_allowlist' });
            return {
              content: [{
                type: 'text',
                text: buildDenialMessage(callerAgentId, target, allowed),
              }],
            };
          }
          const ctx = currentCallContext() ?? { depth: 0, chain: [callerAgentId] };
          if (ctx.depth >= MAX_CALL_DEPTH) {
            const chain = [...ctx.chain, target].join(' → ');
            logger.warn('comms.depth-exceeded', { caller: callerAgentId, target, chain });
            return {
              content: [{
                type: 'text',
                text: `call depth exceeded (max ${MAX_CALL_DEPTH}): ${chain}. Stop and answer with what you already know.`,
              }],
            };
          }
          const nextCtx: CallContext = { depth: ctx.depth + 1, chain: [...ctx.chain, target] };
          const convoId = conversation_id ?? deps.conversations.findOrStartInterAgentThread(callerAgentId, target);
          logger.info('comms.ask', {
            caller: callerAgentId, target, conv: convoId, depth: nextCtx.depth, chain: nextCtx.chain.join('->'),
          });
          try {
            const r = await runInCallContext(nextCtx, async () =>
              deps.host.get(target).onMessage({
                message,
                conversation_id: convoId,
                // Tag the user turn with the caller's agent id so the admin UI
                // shows "from: agent-three" instead of an unlabelled user message.
                caller_label: callerAgentId,
              }),
            );
            return { content: [{ type: 'text', text: r.reply }] };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('comms.error', { caller: callerAgentId, target, error: msg });
            return { content: [{ type: 'text', text: `error calling ${target}: ${msg}` }] };
          }
        },
      ),
      tool(
        'list_agents',
        "List the agents you can call via ask_agent — filtered to your `can_call` allowlist. " +
          'Returns id, name, and one-line description for each.',
        {},
        async () => {
          const def = await deps.defStore.read(callerAgentId);
          const allowed = new Set(def?.can_call ?? []);
          if (allowed.size === 0) {
            return { content: [{ type: 'text', text: '(no callable agents — your can_call list is empty)' }] };
          }
          const all = await deps.defStore.list();
          const visible = all.filter(a => a.enabled && allowed.has(a.id));
          if (visible.length === 0) {
            return { content: [{ type: 'text', text: '(your allowed agents are all disabled or missing)' }] };
          }
          const text = visible.map(a => `[${a.id}] ${a.name} — ${a.description}`).join('\n');
          return { content: [{ type: 'text', text }] };
        },
      ),
    ],
  });
}

/**
 * Per-agent in-process MCP server exposing inter-agent messaging tools.
 *
 * Tools (each prefixed `mcp__agent_comms__` when reaching the model):
 *
 *   ask_agent(agent_id, message)
 *     Send a message to another agent and get its reply. Enforced against
 *     the caller's `can_call` allowlist (re-read every call so admin edits
 *     take effect immediately). Loop-guarded by AsyncLocalStorage call
 *     depth (max MAX_CALL_DEPTH).
 *
 *   list_agents()
 *     Names of agents the caller is allowed to ask_agent.
 *
 * Conversation continuity: the call ALWAYS lands on the canonical (caller,
 * target) thread, derived server-side from the two ids. The model cannot
 * pass a conversation_id — a model-supplied thread id was a spoofing vector
 * (plant a message / approval card in an unrelated conversation's panel), and
 * one stable thread per agent pairing is the only behavior anyone needs.
 *
 * The caller's agent_id is closed over so each tool call is scoped to "this
 * agent is asking" — no risk of a target agent impersonating a different
 * caller by passing a different id.
 *
 * Optional gate: a caller that reads untrusted content (crm/social) has
 * ask_agent gated, so a prompt-injected message can't be laundered to a peer
 * with an ungated egress path without the operator approving the relay.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentDefinitionStore } from '../../agent-definition-store.js';
import type { ConversationStore } from '../../conversation-store.js';
import { gateMcpTool, type McpGateContext } from './approval-gate.js';
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

/**
 * Per-agent ceiling on simultaneous in-flight ask_agent calls. Without
 * this, a prompt-injected agent can fan out 50 parallel asks and rack up
 * model-token cost / wedge the host. Two is enough for legitimate
 * parallel coordination ("ask agent-A and agent-B simultaneously") while
 * making spray attacks pointless.
 */
const MAX_PER_CALLER_INFLIGHT = 2;

/** Per-caller-id in-flight count. Cleared back to zero on every call's
 *  finally — never grows past the number of LIVE callers. */
const inflightPerCaller = new Map<string, number>();

/**
 * Capabilities the callee has but caller does not = escalation. Refuse
 * the call to close the confused-deputy attack: caller can't borrow
 * callee's manage_agents to mint a wider-permission agent. Exported so the
 * ritsu-agent native runtime shares the exact same guard.
 */
export function callerEscalatesTo(
  callerCaps: ReadonlyArray<string>,
  calleeCaps: ReadonlyArray<string>,
): string[] {
  const callerSet = new Set(callerCaps);
  return calleeCaps.filter(c => !callerSet.has(c));
}

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

export function buildAgentCommsMcp(callerAgentId: string, deps: AgentCommsDeps, gate: McpGateContext | null = null) {
  return createSdkMcpServer({
    name: COMMS_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'ask_agent',
        'Send a message to another agent and get its reply. Only agents in your `can_call` ' +
          'allowlist are reachable. The reply lands in the canonical (you, target) thread so related ' +
          'back-and-forth stays in one place and the target sees its history with you.',
        {
          agent_id: z.string().describe('id of the target agent to call'),
          message: z.string().min(1).describe('what to say to the target'),
        },
        async ({ agent_id: target, message }) => {
          // Re-read the caller's definition at call time so admin edits to the
          // can_call list take effect immediately, not just on next agent reload.
          const callerDef = await deps.defStore.read(callerAgentId);
          const allowed = callerDef?.can_call ?? [];
          if (!allowed.includes(target)) {
            logger.warn('comms.denied', { caller: callerAgentId, target, reason: 'not_in_allowlist' });
            return {
              content: [{ type: 'text', text: buildDenialMessage(callerAgentId, target, allowed) }],
            };
          }

          // Confused-deputy guard: refuse to route through an agent with
          // capabilities the caller doesn't already have. Otherwise A could
          // prompt-inject B (which has manage_agents) into minting a new
          // agent with whatever permissions A wanted.
          const targetDef = await deps.defStore.read(target);
          const escalated = callerEscalatesTo(callerDef?.capabilities ?? [], targetDef?.capabilities ?? []);
          if (escalated.length > 0) {
            logger.warn('comms.denied', { caller: callerAgentId, target, reason: 'escalation', escalated });
            return {
              content: [{
                type: 'text',
                text: `denied: ${target} holds capabilities (${escalated.join(', ')}) that ${callerAgentId} does not. ` +
                  `Calls that would let the callee act with elevated capabilities on the caller's behalf are refused.`,
              }],
            };
          }

          const ctx = currentCallContext() ?? { depth: 0, chain: [callerAgentId] };

          // Cycle guard: if `target` is already in the chain, we're about to
          // loop. The depth cap eventually breaks this but only after burning
          // tokens on the way down. Refuse up front.
          if (ctx.chain.includes(target)) {
            const chain = [...ctx.chain, target].join(' → ');
            logger.warn('comms.cycle', { caller: callerAgentId, target, chain });
            return {
              content: [{
                type: 'text',
                text: `call cycle detected: ${chain}. Stop and answer with what you already know.`,
              }],
            };
          }

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

          // Concurrency cap on the caller. Refuse if this agent already has
          // MAX_PER_CALLER_INFLIGHT outstanding calls; a single agent can't
          // fan out a denial-of-billing attack.
          const inflight = inflightPerCaller.get(callerAgentId) ?? 0;
          if (inflight >= MAX_PER_CALLER_INFLIGHT) {
            logger.warn('comms.inflight-exceeded', { caller: callerAgentId, target, inflight });
            return {
              content: [{
                type: 'text',
                text: `too many concurrent ask_agent calls in flight (${inflight}/${MAX_PER_CALLER_INFLIGHT}). ` +
                  `Wait for one to return before issuing another.`,
              }],
            };
          }
          inflightPerCaller.set(callerAgentId, inflight + 1);

          const nextCtx: CallContext = { depth: ctx.depth + 1, chain: [...ctx.chain, target] };
          // Canonical (caller, target) thread, derived server-side from the
          // two ids — never model-supplied.
          const convoId = deps.conversations.findOrStartInterAgentThread(callerAgentId, target);
          logger.info('comms.ask', {
            caller: callerAgentId, target, conv: convoId, depth: nextCtx.depth, chain: nextCtx.chain.join('->'),
          });
          try {
            // Gate the relay when the caller reads untrusted content: a
            // prompt-injected message must not reach a peer (possibly one with
            // an ungated egress tool) without the operator approving it.
            return await gateMcpTool(gate, COMMS_TOOL_NAMES[0], { agent_id: target, message }, async () => {
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
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('comms.error', { caller: callerAgentId, target, error: msg });
            return { content: [{ type: 'text', text: `error calling ${target}: ${msg}` }] };
          } finally {
            const n = (inflightPerCaller.get(callerAgentId) ?? 1) - 1;
            if (n <= 0) inflightPerCaller.delete(callerAgentId);
            else inflightPerCaller.set(callerAgentId, n);
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

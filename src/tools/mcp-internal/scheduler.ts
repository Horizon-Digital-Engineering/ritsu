/**
 * Per-agent in-process MCP server exposing SCHEDULING tools, so an agent can
 * set its own follow-ups — "check back in an hour", "remind me every morning"
 * — instead of every schedule being an operator config edit.
 *
 * Tools (each prefixed `mcp__scheduler__` when reaching the model):
 *
 *   schedule_create(...)   create or replace a job you own
 *   schedule_list(...)     list jobs with their next run and stop reason
 *   schedule_remove(id)    delete a job you own, and its history
 *   schedule_pause(id)     stop or resume a job you own
 *
 * Parity with the native tool loop's version: both call the same operations in
 * `scheduler/agent-ops`, so ownership rules cannot drift between the two.
 *
 * The agent_id is closed over, so a job is always created as this agent and can
 * only be modified by it. There is deliberately no `script` payload — arbitrary
 * commands on a timer is a blast radius an agent should not be able to open.
 *
 * Suppressed entirely during a scheduled run: without that, one fire can create
 * a job per tool round, each of them a paid model call, with no cap.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { gateMcpTool, type McpGateContext } from './approval-gate.js';
import type { JobStore } from '../../scheduler/store.js';
import { createJob, listJobs, removeJob, pauseJob } from '../../scheduler/agent-ops.js';
import { logger } from '../../util/log.js';

export const SCHEDULER_MCP_NAME = 'scheduler';

export const SCHEDULER_TOOL_NAMES = [
  `mcp__${SCHEDULER_MCP_NAME}__schedule_create`,
  `mcp__${SCHEDULER_MCP_NAME}__schedule_list`,
  `mcp__${SCHEDULER_MCP_NAME}__schedule_remove`,
  `mcp__${SCHEDULER_MCP_NAME}__schedule_pause`,
] as const;

/**
 * Bounded quantifier, not `*`. Some providers reject a tool schema containing
 * an unbounded pattern outright, and the rejection takes the whole toolbelt
 * with it rather than just the offending field.
 */
const JOB_ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase kebab-case, max 64 chars');

export function buildAgentSchedulerMcp(
  agentId: string,
  store: JobStore,
  gate: McpGateContext | null = null,
) {
  return createSdkMcpServer({
    name: SCHEDULER_MCP_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'schedule_create',
        'Schedule future work. kind "at" runs once ("2h" from now, or an ISO timestamp); ' +
          '"every" repeats on an interval ("30m", "1d"); "cron" is a wall-clock time ' +
          '("0 9 * * 1" is 9am Mondays). A notify job delivers your text verbatim and costs nothing. ' +
          'An agent_turn job wakes you with the message so you can act on it and interpret any reply — ' +
          'recurring ones keep a single conversation, so you will see the earlier check-ins. ' +
          'Reusing an id replaces that job.',
        {
          id: JOB_ID.describe('Stable kebab-case identifier.'),
          name: z.string().min(1).max(200).describe('Human-readable, shown in listings.'),
          kind: z.enum(['at', 'every', 'cron']),
          spec: z.string().min(1).max(200)
            .describe('at: "2h" or an ISO timestamp. every: "30m". cron: a 5-field expression.'),
          tz: z.string().max(64).optional()
            .describe('IANA timezone for cron and at, e.g. America/New_York. Omit for UTC.'),
          payload: z.enum(['notify', 'agent_turn'])
            .describe('notify sends text and costs nothing; agent_turn wakes an agent.'),
          message: z.string().min(1).max(4000).describe('Text to send, or the prompt to wake with.'),
          channel_ids: z.array(z.number().int()).max(20).optional()
            .describe('Channels to deliver to. Omit to use every running channel.'),
        },
        async (args) => gateMcpTool(gate, SCHEDULER_TOOL_NAMES[0], args, async () => {
          const text = createJob(store, agentId, args);
          logger.info('scheduler.agent-create', { agent_id: agentId, job: args.id, kind: args.kind });
          return { content: [{ type: 'text', text }] };
        }),
      ),
      tool(
        'schedule_list',
        'List scheduled jobs with their next run time and, if one has stopped, why. ' +
          'Use before changing or removing a job.',
        {
          include_others: z.boolean().optional()
            .describe('Also list jobs you did not create. Names and times only.'),
        },
        async ({ include_others }) => ({
          content: [{ type: 'text', text: listJobs(store, agentId, include_others === true) }],
        }),
      ),
      tool(
        'schedule_remove',
        'Delete a job you created, and its run history. To stop one temporarily, use schedule_pause.',
        { id: JOB_ID },
        async ({ id }) => gateMcpTool(gate, SCHEDULER_TOOL_NAMES[2], { id }, async () => {
          const text = removeJob(store, agentId, id);
          logger.info('scheduler.agent-remove', { agent_id: agentId, job: id });
          return { content: [{ type: 'text', text }] };
        }),
      ),
      tool(
        'schedule_pause',
        'Stop a job firing without deleting it. Pass resume: true to start it again.',
        { id: JOB_ID, resume: z.boolean().optional() },
        async ({ id, resume }) => gateMcpTool(gate, SCHEDULER_TOOL_NAMES[3], { id, resume }, async () => ({
          content: [{ type: 'text', text: pauseJob(store, agentId, id, resume === true) }],
        })),
      ),
    ],
  });
}

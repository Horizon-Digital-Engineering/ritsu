/**
 * Scheduling tools. Let an agent set its own follow-ups — "check back in an
 * hour", "remind me every morning" — instead of every schedule being a config
 * edit an operator has to make.
 *
 * Two rails, both deliberate:
 *
 *  - **No shell.** An agent can create `notify` and `agent_turn` jobs, never
 *    `script`. Arbitrary commands on a timer is a blast radius nobody asked
 *    for, and the operator can still create those directly.
 *  - **No recursion.** `insideJobRun` suppresses these tools during a scheduled
 *    turn, so one fire cannot create more work. The dispatcher sets it from the
 *    `scheduler:<jobId>` caller label. Without it a scheduled turn could create
 *    a job per tool round, every round, with no cap.
 *
 * Schema patterns are bounded (`{0,63}`, not `*`). Some providers reject tool
 * schemas containing unbounded quantifiers outright, and the failure surfaces
 * as an opaque 422 with the whole toolbelt rejected, not just the offending
 * field.
 */
import type { RaTool } from '../../model/ritsu-agent/types.js';
import type { JobStore } from '../../scheduler/store.js';
import { nextRun } from '../../scheduler/schedule.js';
import type { Schedule } from '../../scheduler/types.js';

export interface SchedulerToolDeps {
  agentId: string;
  jobs?: JobStore;
  /**
   * True while running as a scheduled job. Set by the runner, and the only
   * thing that suppresses these tools.
   */
  insideJobRun?: boolean;
}

/** Human summary of a job, for list output and create confirmations. */
function describe(store: JobStore, id: string): string {
  const job = store.read(id);
  if (!job) return `${id} (missing)`;
  const state = store.state(id);
  const next = state?.next_run_at ? new Date(state.next_run_at).toISOString() : 'not scheduled';
  const status = state?.disabled_reason ? ` [stopped: ${state.disabled_reason}]` : '';
  return `${job.id} — ${job.name} — ${job.schedule.kind} "${job.schedule.spec}" — next ${next}${status}`;
}

export function buildSchedulerTools(deps: SchedulerToolDeps): RaTool[] {
  const { agentId, jobs, insideJobRun } = deps;
  if (!jobs || insideJobRun) return [];

  return [
    {
      name: 'schedule_create',
      description:
        'Schedule future work. Use kind "at" for one-shot ("2h" from now, or an ISO timestamp), ' +
        '"every" for a fixed interval ("30m", "1d"), or "cron" for a wall-clock time ' +
        '("0 9 * * 1" is 9am Mondays). A notify job delivers your text verbatim and costs nothing; ' +
        'an agent_turn job wakes you with the message so you can act and interpret the reply. ' +
        'Recurring agent_turn jobs keep one conversation, so you will see the earlier check-ins.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'kind', 'spec', 'payload', 'message'],
        properties: {
          id: {
            type: 'string',
            pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
            description: 'Stable kebab-case identifier. Reusing one replaces that job.',
          },
          name: { type: 'string', maxLength: 200, description: 'Human-readable, shown in listings.' },
          kind: { type: 'string', enum: ['at', 'every', 'cron'] },
          spec: {
            type: 'string',
            maxLength: 100,
            description: 'For at: "2h" or an ISO timestamp. For every: "30m". For cron: a 5-field expression.',
          },
          tz: {
            type: 'string',
            maxLength: 64,
            description: 'IANA timezone for cron and at, e.g. America/New_York. Omit for UTC.',
          },
          payload: {
            type: 'string',
            enum: ['notify', 'agent_turn'],
            description: 'notify sends text and costs nothing; agent_turn wakes an agent.',
          },
          message: { type: 'string', maxLength: 4000, description: 'Text to send, or the prompt to wake with.' },
          channel_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Channels to deliver to. Omit to use every running channel.',
          },
        },
      },
      handler: async (args) => {
        const a = args as {
          id: string; name: string; kind: Schedule['kind']; spec: string; tz?: string;
          payload: 'notify' | 'agent_turn'; message: string; channel_ids?: number[];
        };
        try {
          // Checked here, not only on remove: upsert overwrites every column
          // including `owner`, so without this an agent could claim an
          // operator's job and then legitimately delete it.
          const existing = jobs.read(a.id);
          if (existing && existing.owner !== `agent:${agentId}`) {
            return `Refused: "${a.id}" already exists and is not yours. Pick a different id.`;
          }

          const schedule: Schedule = {
            kind: a.kind, spec: a.spec, tz: a.tz ?? null, stagger_ms: 0,
          };
          // Validate before storing. A schedule that cannot be computed would
          // otherwise sit in the table looking scheduled and never fire, which
          // is far harder to notice than a rejected call.
          const first = nextRun(schedule, Date.now());
          if (first === null) {
            return `Refused: that schedule will never fire. Check the spec: "${a.spec}".`;
          }

          jobs.upsert({
            id: a.id,
            name: a.name,
            schedule,
            payload: a.payload === 'notify'
              ? { kind: 'notify', text: a.message }
              : { kind: 'agent_turn', agent_id: agentId, message: a.message, conversation_id: null },
            delivery: {
              channel_ids: a.channel_ids ?? [],
              failure_channel_id: null,
              failure_cooldown_s: 3600,
            },
            owner: `agent:${agentId}`,
          });
          jobs.setNextRun(a.id, first);
          return `Scheduled. ${describe(jobs, a.id)}`;
        } catch (err) {
          return `Could not schedule: ${(err as Error).message}`;
        }
      },
    },

    {
      name: 'schedule_list',
      description: 'List scheduled jobs with their next run time. Use before editing or removing one.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: {
          include_others: {
            type: 'boolean',
            default: false,
            description: 'Also list jobs you did not create. Names and times only.',
          },
        },
      },
      handler: async (args) => {
        const a = args as { include_others?: boolean };
        const all = jobs.list(true);
        // Defaults to the caller's own. Enumerating every job by default hands
        // an agent a map of the operator's automation for free.
        const rows = a.include_others === true
          ? all
          : all.filter(j => j.owner === `agent:${agentId}`);
        if (rows.length === 0) return 'No scheduled jobs.';
        return rows.map(j => describe(jobs, j.id)).join('\n');
      },
    },

    {
      name: 'schedule_remove',
      description: 'Delete a scheduled job and its history. Use schedule_pause instead to stop it temporarily.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
        },
      },
      handler: async (args) => {
        const a = args as { id: string };
        const job = jobs.read(a.id);
        if (!job) return `No job "${a.id}".`;
        // An agent removing an operator's job would be a surprising amount of
        // authority for a tool the model reaches for casually.
        if (job.owner !== `agent:${agentId}`) {
          return `Refused: "${a.id}" was not created by you. Ask the operator to remove it.`;
        }
        jobs.delete(a.id);
        return `Removed "${a.id}".`;
      },
    },

    {
      name: 'schedule_pause',
      description: 'Stop a job firing without deleting it. Pass resume: true to start it again.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
          resume: { type: 'boolean', default: false },
        },
      },
      handler: async (args) => {
        const a = args as { id: string; resume?: boolean };
        const job = jobs.read(a.id);
        if (!job) return `No job "${a.id}".`;
        if (job.owner !== `agent:${agentId}`) {
          return `Refused: "${a.id}" was not created by you.`;
        }
        const resuming = a.resume === true;
        jobs.setEnabled(a.id, resuming);
        if (resuming) {
          // Resuming has to re-arm the timer: a paused job's next run is stale
          // or null, and enabling alone would leave it silently inert.
          try { jobs.setNextRun(a.id, nextRun(job.schedule, Date.now(), jobs.state(a.id)?.last_run_at ?? null)); }
          catch (err) { return `Resumed but could not reschedule: ${(err as Error).message}`; }
        }
        return resuming ? `Resumed. ${describe(jobs, a.id)}` : `Paused "${a.id}".`;
      },
    },
  ];
}

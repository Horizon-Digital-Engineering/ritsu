/**
 * Scheduled jobs — time- and event-triggered work that can wake an agent,
 * deliver to a channel, and capture the reply.
 *
 * Core, not a plugin: domains register jobs against this rather than each
 * growing its own timer. The hardcoded sweeps in `index.ts` (approvals,
 * backup, proposal polling) are the shape this replaces.
 *
 * The payload split is what keeps it affordable. Most scheduled work needs no
 * model — a reminder is static text, a watchdog is a shell command. Only work
 * that must interpret a reply pays for an agent turn.
 */
import { z } from 'zod';

/**
 * `at` fires once. `every` and `cron` recur. Kept as an enum from the start so
 * event-driven kinds can be added without rewriting the tick loop — retrofitting
 * those into a time-only scheduler means reworking how due-ness is computed.
 */
export const ScheduleKindSchema = z.enum(['at', 'every', 'cron']);

export const ScheduleSchema = z.object({
  kind: ScheduleKindSchema,
  /** ISO timestamp for `at`, duration like `30m` for `every`, 5-field expression for `cron`. */
  spec: z.string().min(1),
  /** IANA zone. Only meaningful for `cron` and `at`; an interval has no wall-clock anchor. */
  tz: z.string().nullable().default(null),
  /** Jitter in ms, so jobs sharing an hour boundary don't all fire together. */
  stagger_ms: z.number().int().min(0).default(0),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/**
 * `notify` and `script` never call a model; `agent_turn` does. Splitting these
 * is the difference between a reminder costing nothing and costing a turn.
 */
export const PayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('notify'),
    /** Delivered verbatim. No interpretation, no reply handling. */
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal('script'),
    command: z.string().min(1),
    /**
     * Empty stdout delivers nothing — silence means healthy, which is what
     * stops a watchdog reporting daily that nothing is wrong. Non-zero exit
     * raises a failure alert instead.
     */
    timeout_s: z.number().int().positive().max(3600).default(300),
    max_output_bytes: z.number().int().positive().max(1_048_576).default(65536),
  }),
  z.object({
    kind: z.literal('agent_turn'),
    agent_id: z.string().min(1),
    message: z.string().min(1),
    /**
     * Null means a fresh conversation each run. Set means the job keeps one
     * conversation across runs, so the agent can say "you missed yesterday
     * too". Assigned on first run and persisted.
     */
    conversation_id: z.number().int().nullable().default(null),
  }),
]);

export const DeliverySchema = z.object({
  /** Channel row ids. Resolved at fire time so channels added later are picked up. */
  channel_ids: z.array(z.number().int()).default([]),
  /**
   * Where failures go. Separate from the normal target and rate-limited, so a
   * job that fails every tick can't flood the channel it was meant to post to.
   */
  failure_channel_id: z.number().int().nullable().default(null),
  failure_cooldown_s: z.number().int().min(0).default(3600),
});

/**
 * Cheap gate in front of an expensive payload. Returns `{ fire, message?, state? }`.
 *
 * `state` persisting between evaluations is the whole point — without it a
 * trigger can only ask "is this over a threshold", never "has this changed
 * since last time", and the second is usually what's wanted.
 */
export const TriggerSchema = z.object({
  command: z.string().min(1),
  timeout_s: z.number().int().positive().max(3600).default(30),
});

/**
 * Trigger state lives in the job's state row, never in its definition. Keeping a
 * copy in the definition meant two columns claiming the same value that never
 * agreed, and an initial state set at creation was silently ignored.
 */
export type Trigger = z.infer<typeof TriggerSchema>;

export const JobSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  schedule: ScheduleSchema,
  payload: PayloadSchema,
  delivery: DeliverySchema.default({ channel_ids: [], failure_channel_id: null, failure_cooldown_s: 3600 }),
  trigger: TriggerSchema.nullable().default(null),
  /**
   * Job ids whose most recent output is prepended to this job's payload at
   * fire time. A collector and a summarizer chain without either knowing about
   * the other, and without a workflow engine.
   */
  context_from: z.array(z.string()).default([]),
  /** Set by whichever plugin or subsystem owns the job; null for user-created. */
  owner: z.string().nullable().default(null),
});
export type Job = z.infer<typeof JobSchema>;

/**
 * `running` is written when a run starts and replaced when it ends. Without a
 * non-terminal state, a process killed mid-run leaves a row claiming success.
 * `gate_error` separates "the trigger declined" from "the trigger is broken" —
 * conflating them let a typo'd command silence a job forever while resetting
 * its failure streak.
 */
export type RunStatus = 'running' | 'ok' | 'error' | 'skipped' | 'gate_error';

/** Statuses that count toward the consecutive-failure budget. */
/** Mutable per-job state. Kept apart from the definition so a job can be edited without losing history. */
export interface JobState {
  job_id: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: RunStatus | null;
  consecutive_failures: number;
  /** Set when auto-disabled; cleared by an explicit enable. */
  disabled_reason: string | null;
}

export interface JobRun {
  id: number;
  job_id: string;
  started_at: number;
  finished_at: number | null;
  status: RunStatus;
  /** Trimmed to the payload's byte cap. Used by `context_from` on downstream jobs. */
  output: string | null;
  error: string | null;
}

/**
 * A job stops firing after this many consecutive failures. A broken job must
 * not hammer a channel indefinitely; clearing it is a deliberate re-enable.
 */
export const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Why the scheduler stopped a job on its own. Persisted, because a null
 * `next_run_at` alone means five different things and an operator cannot tell
 * "gave up after failures" from "one-shot finished" or "never armed".
 */
export type DisabledReason =
  | 'consecutive-failures'
  | 'uncomputable-schedule'
  | 'exhausted'
  /** The stored definition no longer parses — usually a row from an older build. */
  | 'unreadable';

/** Trigger state is capped so a runaway script can't grow the row without bound. */
export const MAX_TRIGGER_STATE_BYTES = 16_384;

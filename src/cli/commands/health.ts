/**
 * `ritsu health` — ask the running service how each of its parts is doing.
 *
 * Reads the open /readyz on the admin port, so it needs no token. Scripts
 * use `--wait` after a restart: systemd calls the unit started before ritsu
 * listens, and a boot may write a pre-upgrade backup first.
 */
import type { Command, CommandContext } from '../registry.js';
import type { HealthSummary, Part, PartStatus } from '../../health/types.js';
import { resolveBaseUrl } from '../api.js';

export interface Timing {
  retryMs: number;
  /** After a failing answer, how long parts get to come up before it counts. */
  settleMs: number;
  tryMs: number;
}

export interface HealthOptions {
  base: string;
  waitMs: number;
  json: boolean;
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const TIMING: Timing = { retryMs: 1_000, settleMs: 15_000, tryMs: 5_000 };
const MARK: Record<PartStatus, string> = { ok: '✓', warn: '!', fail: '✗', off: '–' };
const PART_STATUSES = new Set<unknown>(['ok', 'warn', 'fail', 'off']);
const SUMMARY_STATUSES = new Set<unknown>(['ok', 'warn', 'fail']);

type Probe = { summary: HealthSummary } | { miss: string };

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function verdict(s: HealthSummary): string {
  const count = (st: PartStatus): number => s.parts.filter(p => p.status === st).length;
  if (s.status === 'ok') return 'all parts up';
  if (s.status === 'warn') {
    const n = count('warn');
    return `up, ${n} warning${n === 1 ? '' : 's'}`;
  }
  return `${count('fail')} failing`;
}

export function formatSummary(s: HealthSummary): string[] {
  const width = Math.max(0, ...s.parts.map(p => p.label.length));
  return [
    `ritsu ${s.version} · up ${formatUptime(s.uptime_s)}`,
    ...s.parts.map(p => `  ${MARK[p.status]}  ${p.label.padEnd(width)}  ${p.note}`),
    '',
    `  ${verdict(s)}`,
  ];
}

function isPart(v: unknown): v is Part {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.label === 'string' && typeof p.note === 'string' && PART_STATUSES.has(p.status);
}

function isSummary(v: unknown): v is HealthSummary {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return s.name === 'ritsu' && SUMMARY_STATUSES.has(s.status)
    && typeof s.version === 'string' && typeof s.uptime_s === 'number'
    && Array.isArray(s.parts) && s.parts.every(isPart);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function missReason(err: unknown, tryMs: number): string {
  const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
  if (e.name === 'TimeoutError') return `no reply within ${tryMs / 1000} s`;
  const code = e.cause?.code;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
  // fetch's own message is just "fetch failed"; the cause says why.
  const why = e.cause?.message ?? e.message;
  return typeof why === 'string' && why ? why : String(err);
}

async function probe(url: string, tryMs: number): Promise<Probe> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(tryMs) });
    const body = parseJson(await res.text());
    return isSummary(body) ? { summary: body } : { miss: `HTTP ${res.status}, not a health summary` };
  } catch (err) {
    return { miss: missReason(err, tryMs) };
  }
}

interface Outcome { summary: HealthSummary | null; miss: string }

function waitingLine(base: string, settling: boolean, leftMs: number): string {
  const secs = Math.ceil(leftMs / 1000);
  return settling
    ? `  a part is failing; checking again for up to ${secs} s`
    : `  waiting for ritsu at ${base} (up to ${secs} s)`;
}

/** Asks until an answer that isn't failing, or until the wait (or the settle window) runs out. */
async function poll(opts: HealthOptions, io: Io, timing: Timing): Promise<Outcome> {
  const url = `${opts.base}/readyz`;
  const deadline = Date.now() + opts.waitMs;
  const out: Outcome = { summary: null, miss: '' };
  let settleBy = 0;
  let announced = false;
  for (;;) {
    const r = await probe(url, timing.tryMs);
    if ('miss' in r) out.miss = r.miss;
    else if (r.summary.status === 'fail') {
      out.summary = r.summary;
      settleBy ||= Math.min(Date.now() + timing.settleMs, deadline);
    } else return { summary: r.summary, miss: '' };
    const left = (settleBy || deadline) - Date.now();
    if (left <= 0) return out;
    if (!announced) io.err(waitingLine(opts.base, settleBy > 0, left));
    announced = true;
    await new Promise(resolve => setTimeout(resolve, Math.min(timing.retryMs, left)));
  }
}

/** Exit code: 0 up (warnings included), 1 a part failing, 3 no answer; 2 stays the CLI's usage error. */
export async function runHealth(opts: HealthOptions, io: Io, timing: Timing = TIMING): Promise<number> {
  const { summary, miss } = await poll(opts, io, timing);
  if (!summary) {
    const within = opts.waitMs > 0 ? ` within ${Math.round(opts.waitMs / 1000)} s` : '';
    io.err(`ritsu health: no answer from ${opts.base}/readyz${within} (${miss})`);
    return 3;
  }
  const lines = opts.json ? [JSON.stringify(summary, null, 2)] : formatSummary(summary);
  for (const line of lines) io.out(line);
  return summary.status === 'fail' ? 1 : 0;
}

export const healthCommand: Command = {
  name: 'health',
  summary: 'ask the running service how each part is doing',
  needsRoot: false,
  help: () => [
    'ritsu health — how each part of the running service is doing',
    '',
    '  ritsu health               ask once',
    '  ritsu health --wait 120    keep asking for up to 120 s until it answers',
    '  ritsu health --json        the summary as JSON',
    '  ritsu health --url <base>  another admin address (default: from the env file)',
    '',
    'Exit 0 up (warnings included), 1 a part is failing, 2 usage error, 3 no answer.',
  ].join('\n'),
  run: async (ctx: CommandContext) => {
    const wait = ctx.flags.wait ?? '0';
    if (typeof wait !== 'string' || !/^\d+$/.test(wait)) {
      console.error('ritsu health: --wait takes a whole number of seconds');
      return 2;
    }
    let base: string;
    try {
      base = resolveBaseUrl(ctx.flags.url);
    } catch (err) {
      console.error(`ritsu health: ${(err as Error).message}`);
      return 2;
    }
    return runHealth(
      { base, waitMs: Number(wait) * 1000, json: Boolean(ctx.flags.json) },
      { out: line => console.log(line), err: line => console.error(line) },
    );
  },
};

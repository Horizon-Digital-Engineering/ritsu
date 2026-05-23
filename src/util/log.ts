import { eventBus, type LogEvent } from '../event-bus.js';

/**
 * Tiny JSON-line logger.
 *
 * Policy: log enough to troubleshoot, never enough to leak secrets.
 *   - Sensitive key names (see SENSITIVE_KEYS) are redacted recursively.
 *   - Don't pass raw system_prompt, message content, or DB rows in `extra` —
 *     log identifiers and shapes instead (agent_id, msg_len, status).
 *   - The logger appends every entry to the EventBus ring so the admin UI
 *     can live-tail it. stdout still gets the JSON line for journald.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

export const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'];
let currentLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

/**
 * Field-name matchers for redaction. Each entry is matched
 * case-insensitively. The split between EXACT and CONTAINS exists
 * because a pure substring match on short tokens like "key" wrongly
 * redacts benign names like `monkey` or `keyboard_shortcut`, while a
 * pure exact match misses real secrets stored under names like
 * `admin_token` or `bot_token`.
 *
 *   EXACT     — match key === entry  (low-false-positive names)
 *   CONTAINS  — substring match (broad — for names that come in many
 *               compounds like `bot_token` / `refresh_token`).
 */
const SENSITIVE_EXACT = new Set([
  'key',
  'plaintext',
  'bearer',
  'auth_tag',
  'master_key',
]);
const SENSITIVE_CONTAINS = [
  'token',
  'password',
  'passwd',
  'secret',
  'api_key',
  'apikey',
  'authorization',
  'credential',
  'session',
  'private_key',
  'cookie',
];

const REDACT = '[redacted]';

function isSensitive(key: string): boolean {
  const k = key.toLowerCase();
  if (SENSITIVE_EXACT.has(k)) return true;
  return SENSITIVE_CONTAINS.some(s => k.includes(s));
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitive(k) ? REDACT : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const safeExtra = extra ? (redact(extra) as Record<string, unknown>) : undefined;
  const entry: LogEvent = {
    t: new Date().toISOString(),
    level,
    msg,
    ...safeExtra,
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + '\n');
  eventBus.push(entry);
}

export const logger = {
  debug: (m: string, e?: Record<string, unknown>) => log('debug', m, e),
  info:  (m: string, e?: Record<string, unknown>) => log('info', m, e),
  warn:  (m: string, e?: Record<string, unknown>) => log('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => log('error', m, e),

  /** Runtime log-level change. Called by the admin endpoint. */
  setLevel(level: Level): void {
    minLevel = LEVELS[level];
    currentLevel = level;
    log('info', 'log.level.changed', { level });
  },
  getLevel(): Level {
    return currentLevel;
  },
};

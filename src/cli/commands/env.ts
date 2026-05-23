/**
 * `ritsu env` — read/write /etc/ritsu/env. Dotenv format.
 *
 * Mutating commands (set / unset / edit) auto-restart the service so the
 * change actually takes effect. Get is read-only and doesn't need root,
 * but the file's mode 0600 ownership by ritsu means we re-exec under
 * sudo anyway via needsRoot=true.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from '../../util/safe-spawn.js';
import type { Command, CommandContext } from '../registry.js';
import { restartService } from '../systemd.js';

const ENV_FILE = '/etc/ritsu/env';

interface Line { kind: 'kv'; key: string; value: string; raw: string }
interface Other { kind: 'other'; raw: string }
type EntryLine = Line | Other;

function parse(content: string): EntryLine[] {
  return content.split('\n').map((raw): EntryLine => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return { kind: 'other', raw };
    const eq = raw.indexOf('=');
    if (eq < 0) return { kind: 'other', raw };
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    return { kind: 'kv', key, value, raw };
  });
}

function serialize(entries: EntryLine[]): string {
  return entries.map(e => e.raw).join('\n');
}

async function cmdGet(ctx: CommandContext): Promise<number> {
  if (!existsSync(ENV_FILE)) { console.error(`missing: ${ENV_FILE}`); return 1; }
  const entries = parse(readFileSync(ENV_FILE, 'utf8'));
  const key = ctx.positional[0];
  if (!key) {
    // dump all
    for (const e of entries) if (e.kind === 'kv') console.log(`${e.key}=${e.value}`);
    return 0;
  }
  const match = entries.find(e => e.kind === 'kv' && e.key === key);
  if (match?.kind !== 'kv') { console.error(`${key} not set`); return 1; }
  console.log(match.value);
  return 0;
}

async function cmdSet(ctx: CommandContext): Promise<number> {
  const arg = ctx.positional[0];
  if (!arg?.includes('=')) { console.error('usage: ritsu env set KEY=VALUE'); return 2; }
  const eq = arg.indexOf('=');
  const key = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  const entries = parse(existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '');
  const idx = entries.findIndex(e => e.kind === 'kv' && e.key === key);
  if (idx >= 0) {
    entries[idx] = { kind: 'kv', key, value, raw: `${key}=${value}` };
  } else {
    if (entries.length > 0 && entries[entries.length - 1].raw !== '') entries.push({ kind: 'other', raw: '' });
    entries.push({ kind: 'kv', key, value, raw: `${key}=${value}` });
  }
  writeFileSync(ENV_FILE, serialize(entries), { mode: 0o600 });
  console.log(`set ${key}=${value}`);
  if (ctx.flags['no-restart'] !== true) restartService();
  return 0;
}

async function cmdUnset(ctx: CommandContext): Promise<number> {
  const key = ctx.positional[0];
  if (!key) { console.error('usage: ritsu env unset KEY'); return 2; }
  if (!existsSync(ENV_FILE)) return 0;
  const entries = parse(readFileSync(ENV_FILE, 'utf8'));
  const filtered = entries.filter(e => e.kind !== 'kv' || e.key !== key);
  if (filtered.length === entries.length) { console.log(`${key} was not set`); return 0; }
  writeFileSync(ENV_FILE, serialize(filtered), { mode: 0o600 });
  console.log(`unset ${key}`);
  if (ctx.flags['no-restart'] !== true) restartService();
  return 0;
}

async function cmdEdit(ctx: CommandContext): Promise<number> {
  const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
  const r = spawnSync(editor, [ENV_FILE], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('editor exited non-zero'); return r.status ?? 1; }
  if (ctx.flags['no-restart'] !== true) restartService();
  return 0;
}

export const envCommand: Command = {
  name: 'env',
  summary: 'read/write /etc/ritsu/env (auto-restarts the service on change)',
  needsRoot: true,
  help: () => [
    'ritsu env — manage /etc/ritsu/env',
    '',
    '  ritsu env get [KEY]        print one key (or all kv pairs if KEY omitted)',
    '  ritsu env set KEY=VALUE    upsert; restarts ritsu unless --no-restart',
    '  ritsu env unset KEY        remove; restarts ritsu unless --no-restart',
    '  ritsu env edit             open $EDITOR (default: nano) on the file',
    '',
    'Common keys: PORT, MCP_HOST, ADMIN_HOST, MCP_REQUIRE_AUTH,',
    'RITSU_PUBLIC_URL, RITSU_ALLOWED_HOSTS, LOG_LEVEL.',
  ].join('\n'),
  run: async (ctx: CommandContext) => {
    switch (ctx.subcommand) {
      case 'get':   case null: return cmdGet(ctx);
      case 'set':   return cmdSet(ctx);
      case 'unset': return cmdUnset(ctx);
      case 'edit':  return cmdEdit(ctx);
      default:
        console.error(`unknown subcommand: ${ctx.subcommand}`);
        return 2;
    }
  },
};

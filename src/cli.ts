#!/usr/bin/env node
/**
 * `ritsu` — operator CLI.
 *
 * Two op classes:
 *
 *   1. **Runtime / state ops** — talk to the running ritsu admin API
 *      (tokens, agents, etc). Need the admin token; don't need root.
 *
 *   2. **Host / service ops** — touch /etc/ritsu, /etc/systemd/system,
 *      run systemctl. Need root. The CLI auto-reexecs itself with sudo
 *      when a subcommand declares it needs root, matching `tailscale`'s
 *      and `openclaw`'s UX. Run as root directly or sudo it — same thing.
 *
 * Add new subcommands in src/cli/commands/<name>.ts and register them
 * in COMMANDS below.
 */
import { spawnSync } from './util/safe-spawn.js';
import { ALL_COMMANDS, type Command } from './cli/registry.js';
import pkg from '../package.json' with { type: 'json' };

interface ParsedArgs {
  command: string;
  subcommand: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  const command    = positional.shift() ?? '';
  const subcommand = positional[0]?.startsWith('-') ? null : (positional.shift() ?? null);
  return { command, subcommand, positional, flags };
}

function topLevelHelp(): string {
  const groups = ALL_COMMANDS.map(c => `  ${c.name.padEnd(14)}${c.summary}`).join('\n');
  return [
    'ritsu — operator CLI',
    '',
    `Version: ${pkg.version}`,
    '',
    'Usage: ritsu <command> [subcommand] [args] [flags]',
    '',
    'Commands:',
    groups,
    '',
    'Flags (most commands):',
    '  --token <tok>     admin token (default: read from /opt/ritsu/data/.admin-token)',
    '  --url   <url>     admin API base URL (default: http://127.0.0.1:7334)',
    '  --json            machine-readable output',
    '  --help            show command-specific help',
    '',
    'Env vars: RITSU_ADMIN_TOKEN, RITSU_URL',
    '',
    'Run `ritsu <command> --help` for subcommand details.',
  ].join('\n');
}

function reexecWithSudo(): never {
  // Re-invoke ourselves under sudo, preserving env vars the CLI honors so
  // the operator doesn't have to re-type --token / --url.
  const passEnv = ['RITSU_ADMIN_TOKEN', 'RITSU_URL', 'RITSU_NONINTERACTIVE']
    .filter(k => process.env[k] !== undefined)
    .map(k => `${k}=${process.env[k]}`);
  const args = ['-E', ...passEnv, process.execPath, ...process.argv.slice(1)];
  const r = spawnSync('sudo', args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'version' || args.flags.version === true || args.flags.V === true) {
    console.log(`ritsu ${pkg.version}`);
    process.exit(0);
  }

  if (!args.command || args.command === 'help' || args.flags.help === true) {
    if (!args.subcommand) {
      console.log(topLevelHelp());
      process.exit(0);
    }
    // ritsu help <cmd> — fall through with command = subcommand, --help set
    args.command = args.subcommand;
    args.subcommand = null;
    args.flags.help = true;
  }

  const cmd: Command | undefined = ALL_COMMANDS.find(c => c.name === args.command);
  if (!cmd) {
    console.error(`ritsu: unknown command '${args.command}'`);
    console.error(`run 'ritsu help' to see available commands`);
    process.exit(2);
  }

  if (args.flags.help === true) {
    console.log(cmd.help());
    process.exit(0);
  }

  if (cmd.needsRoot && process.getuid?.() !== 0) {
    reexecWithSudo();
  }

  try {
    const code = await cmd.run({
      subcommand: args.subcommand,
      positional: args.positional,
      flags: args.flags,
    });
    process.exit(code);
  } catch (err) {
    console.error(`ritsu: ${(err as Error).message}`);
    process.exit(1);
  }
}

void main();

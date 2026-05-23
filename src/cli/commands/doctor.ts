/**
 * `ritsu doctor` — sanity checks for an installed ritsu deployment.
 *
 * Each check returns a Result so we can render a tidy table and exit
 * non-zero if anything's broken — useful as a post-install / post-update
 * verification AND for `update-ritsu` to invoke automatically.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from '../../util/safe-spawn.js';
import type { Command, CommandContext } from '../registry.js';
import { SERVICE_NAME } from '../systemd.js';
import { loadConfig } from '../../config.js';

type Status = 'ok' | 'warn' | 'fail';
interface Check { name: string; status: Status; detail: string }

function checkServiceActive(): Check {
  const r = spawnSync('systemctl', ['is-active', SERVICE_NAME], { encoding: 'utf8' });
  const out = r.stdout.trim();
  return out === 'active'
    ? { name: 'service active',  status: 'ok',   detail: SERVICE_NAME }
    : { name: 'service active',  status: 'fail', detail: `${SERVICE_NAME} is '${out}'` };
}

function checkListening(port: number, label: string): Check {
  const r = spawnSync('ss', ['-Hltn', `sport = :${port}`], { encoding: 'utf8' });
  return r.stdout.trim()
    ? { name: `${label} listening`, status: 'ok',   detail: `port ${port}` }
    : { name: `${label} listening`, status: 'fail', detail: `nothing on port ${port}` };
}

function checkAdminTokenFile(tokenFile: string): Check {
  if (!existsSync(tokenFile)) {
    return { name: 'admin token file', status: 'fail', detail: `missing: ${tokenFile}` };
  }
  const st = statSync(tokenFile);
  if ((st.mode & 0o777) !== 0o600) {
    return { name: 'admin token file', status: 'warn', detail: `mode is ${(st.mode & 0o777).toString(8)} (expected 600)` };
  }
  return { name: 'admin token file', status: 'ok', detail: tokenFile };
}

function checkDbWritable(): Check {
  const dbDir = '/opt/ritsu/data';
  if (!existsSync(dbDir)) return { name: 'db dir',         status: 'fail', detail: `missing: ${dbDir}` };
  const r = spawnSync('sudo', ['-u', 'ritsu', 'touch', `${dbDir}/.doctor-write`], { encoding: 'utf8' });
  if (r.status !== 0) return { name: 'db dir writable',    status: 'fail', detail: `ritsu cannot write ${dbDir}` };
  spawnSync('rm', ['-f', `${dbDir}/.doctor-write`]);
  return { name: 'db dir writable',                       status: 'ok',   detail: dbDir };
}

function checkClaudeSession(): Check {
  const file = '/home/ritsu/.claude/.credentials.json';
  if (!existsSync(file)) {
    return { name: 'claude-direct session', status: 'warn',
      detail: `${file} missing — claude-direct agents won't dispatch until 'sudo -u ritsu -H claude login'` };
  }
  return { name: 'claude-direct session', status: 'ok', detail: file };
}

function checkTailscale(): Check {
  if (!commandExists('tailscale')) {
    return { name: 'tailscale', status: 'warn', detail: 'not installed (skipping serve check)' };
  }
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (r.status !== 0) return { name: 'tailscale', status: 'warn', detail: 'not authenticated' };
  return { name: 'tailscale', status: 'ok', detail: 'reachable' };
}

function checkSandboxPaths(): Check {
  const f = '/etc/ritsu/sandbox-paths.list';
  if (!existsSync(f)) return { name: 'sandbox paths', status: 'ok', detail: '(none declared)' };
  const lines = readFileSync(f, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const missing = lines.filter(p => !existsSync(p));
  if (missing.length === 0) return { name: 'sandbox paths', status: 'ok', detail: `${lines.length} declared, all present` };
  return { name: 'sandbox paths', status: 'warn', detail: `missing: ${missing.join(', ')}` };
}

function commandExists(cmd: string): boolean {
  // Use `which` rather than the shell builtin `command -v` so we don't need
  // `{ shell: true }` (which would propagate the calling shell's settings).
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'run health checks against the installed ritsu deployment',
  needsRoot: true, // db writability + admin token file inspection
  help: () => 'ritsu doctor — run a set of post-install sanity checks',
  run: async (ctx: CommandContext) => {
    const cfg = loadConfig();

    const checks: Check[] = [
      checkServiceActive(),
      checkListening(cfg.mcpPort,   'mcp'),
      checkListening(cfg.adminPort, 'admin'),
      checkAdminTokenFile(cfg.adminTokenFile),
      checkDbWritable(),
      checkClaudeSession(),
      checkSandboxPaths(),
      checkTailscale(),
    ];

    if (ctx.flags.json) { console.log(JSON.stringify({ checks }, null, 2)); return checks.some(c => c.status === 'fail') ? 1 : 0; }

    const symbol = (s: Status): string => {
      if (s === 'ok') return '✓';
      return s === 'warn' ? '!' : '✗';
    };
    const width = Math.max(...checks.map(c => c.name.length));
    for (const c of checks) {
      console.log(`  ${symbol(c.status)}  ${c.name.padEnd(width)}  ${c.detail}`);
    }
    const failed = checks.filter(c => c.status === 'fail').length;
    const warned = checks.filter(c => c.status === 'warn').length;
    console.log('');
    if (failed === 0 && warned === 0) console.log('  all green');
    else console.log(`  ${failed} failed, ${warned} warnings`);
    return failed > 0 ? 1 : 0;
  },
};


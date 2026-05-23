/**
 * `ritsu admin-token` — manage the bootstrap admin token specifically.
 *
 * This token lives at /opt/ritsu/data/.admin-token (mode 0600 owned by
 * ritsu) and is what configure.sh prints loudly on first install. It's
 * also what every other `ritsu` subcommand reads by default to auth
 * against the admin API.
 *
 * Subcommands:
 *   show              print it (requires confirmation unless --yes)
 *   rotate            mint a new admin token, write it to the file,
 *                     revoke the previous one. The new token is shown ONCE.
 *
 * For minting ADDITIONAL admin tokens (e.g. one per operator workstation),
 * use `ritsu token mint <name> --scope admin` — those don't touch the file.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, chownSync } from 'node:fs';
import { spawnSync } from '../../util/safe-spawn.js';
import { createInterface } from 'node:readline/promises';
import type { Command, CommandContext } from '../registry.js';
import { resolveAdminToken, resolveBaseUrl, apiCall, DEFAULT_ADMIN_TOKEN_FILE } from '../api.js';

interface TokenRow {
  id: number;
  name: string;
  scope: 'mcp' | 'admin';
  token_prefix: string;
  revoked_at: number | null;
}

interface MintedToken {
  token: string;
  id: number;
  name: string;
  prefix: string;
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function cmdShow(ctx: CommandContext): Promise<number> {
  if (!existsSync(DEFAULT_ADMIN_TOKEN_FILE)) {
    console.error(`admin token file missing: ${DEFAULT_ADMIN_TOKEN_FILE}`);
    console.error(`run 'ritsu admin-token rotate' to mint one`);
    return 1;
  }
  if (ctx.flags.yes !== true) {
    const ok = await confirm('Print the admin token to the terminal? (it will appear in scrollback)');
    if (!ok) { console.error('aborted'); return 1; }
  }
  process.stdout.write(readFileSync(DEFAULT_ADMIN_TOKEN_FILE, 'utf8'));
  if (!readFileSync(DEFAULT_ADMIN_TOKEN_FILE, 'utf8').endsWith('\n')) console.log();
  return 0;
}

async function cmdRotate(ctx: CommandContext): Promise<number> {
  const baseUrl = resolveBaseUrl(ctx.flags.url);
  const current = resolveAdminToken(ctx.flags.token);

  if (ctx.flags.yes !== true) {
    const ok = await confirm(
      'Rotate the admin token? The current bootstrap token will be revoked\n' +
      '  and replaced. Any client using the OLD token (CLI, admin UI session,\n' +
      '  shell history) will need the new value.',
    );
    if (!ok) { console.error('aborted'); return 1; }
  }

  // Mint a new admin token through the API so it lives in the DB consistently.
  const minted = await apiCall<MintedToken>({
    method: 'POST',
    path: '/admin/api/tokens',
    body: { name: 'bootstrap', scope: 'admin' },
    token: current,
    baseUrl,
  });

  // Look up the OLD bootstrap admin token's id so we can revoke it. Match by
  // (scope=admin, name=bootstrap, not revoked, not the one we just minted).
  const list = await apiCall<{ tokens: TokenRow[] }>({
    method: 'GET',
    path: '/admin/api/tokens?scope=admin',
    token: current,
    baseUrl,
  });
  const oldRows = list.tokens.filter(t => !t.revoked_at && t.name === 'bootstrap' && t.id !== minted.id);

  // Write new plaintext to the on-disk file BEFORE revoking the old one — if
  // anything below fails we still have a valid token on disk.
  writeAdminTokenFile(minted.token);

  for (const row of oldRows) {
    try {
      await apiCall({ method: 'POST', path: `/admin/api/tokens/${row.id}/revoke`, token: minted.token, baseUrl });
    } catch (err) {
      console.error(`warning: failed to revoke old token id=${row.id}: ${(err as Error).message}`);
    }
  }

  if (ctx.flags.json) { console.log(JSON.stringify(minted, null, 2)); return 0; }
  console.log('');
  console.log('  new admin token (shown ONCE — already written to disk):');
  console.log('');
  console.log(`    ${minted.token}`);
  console.log('');
  console.log(`  file: ${DEFAULT_ADMIN_TOKEN_FILE}`);
  console.log(`  prefix: ${minted.prefix}`);
  console.log(`  ${oldRows.length} previous bootstrap admin token(s) revoked`);
  console.log('');
  return 0;
}

function writeAdminTokenFile(token: string): void {
  writeFileSync(DEFAULT_ADMIN_TOKEN_FILE, token + '\n', { mode: 0o600 });
  chmodSync(DEFAULT_ADMIN_TOKEN_FILE, 0o600);
  // Restore ritsu user ownership. Without this, the file ends up owned by
  // root (the user running the rotate CLI) and ritsu can't read it on next
  // bootstrap.
  try {
    const ritsuStat = spawnSync('id', ['-u', 'ritsu'], { encoding: 'utf8' });
    const ritsuGid = spawnSync('id', ['-g', 'ritsu'], { encoding: 'utf8' });
    if (ritsuStat.status === 0 && ritsuGid.status === 0) {
      const uid = Number.parseInt(ritsuStat.stdout.trim(), 10);
      const gid = Number.parseInt(ritsuGid.stdout.trim(), 10);
      if (Number.isFinite(uid) && Number.isFinite(gid)) chownSync(DEFAULT_ADMIN_TOKEN_FILE, uid, gid);
    }
  } catch { /* best-effort */ }
}

export const adminTokenCommand: Command = {
  name: 'admin-token',
  summary: 'manage the bootstrap admin token (print or rotate)',
  needsRoot: true, // reads/writes /opt/ritsu/data/.admin-token (mode 0600)
  help: () => [
    'ritsu admin-token — manage the bootstrap admin token',
    '',
    '  ritsu admin-token show [--yes]     print the token (prompts to confirm)',
    '  ritsu admin-token rotate [--yes]   mint a new one, revoke old, write to file',
    '',
    'The bootstrap token is what every CLI command and the admin UI default to.',
    'To mint ADDITIONAL admin tokens (e.g. per device), use',
    '  ritsu token mint <name> --scope admin',
  ].join('\n'),
  run: async (ctx: CommandContext) => {
    switch (ctx.subcommand) {
      case 'show':   case null: return cmdShow(ctx);
      case 'rotate': return cmdRotate(ctx);
      default:
        console.error(`unknown subcommand: ${ctx.subcommand}`);
        return 2;
    }
  },
};

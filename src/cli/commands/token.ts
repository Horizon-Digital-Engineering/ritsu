/**
 * `ritsu token` — manage MCP and admin bearer tokens via the running
 * service's admin API. The TokenStore remains the single source of truth;
 * the CLI is a thin client.
 */
import type { Command, CommandContext } from '../registry.js';
import { resolveAdminToken, resolveBaseUrl, apiCall } from '../api.js';

interface TokenRow {
  id: number;
  name: string;
  scope: 'mcp' | 'admin';
  token_prefix: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  revoked_at: number | null;
}

interface MintedToken {
  token: string;
  id: number;
  name: string;
  scope: 'mcp' | 'admin';
  prefix: string;
  created_at: number;
}

async function cmdMint(ctx: CommandContext): Promise<number> {
  const name = ctx.positional[0];
  if (!name) { console.error('usage: ritsu token mint <name> [--scope mcp|admin]'); return 2; }
  const scope = (typeof ctx.flags.scope === 'string' ? ctx.flags.scope : 'mcp') as 'mcp' | 'admin';
  if (scope !== 'mcp' && scope !== 'admin') {
    console.error('--scope must be mcp or admin'); return 2;
  }
  const token = resolveAdminToken(ctx.flags.token);
  const baseUrl = resolveBaseUrl(ctx.flags.url);
  // Admin server's POST /admin/api/tokens currently hardcodes scope='mcp';
  // expose --scope by passing through and letting the API decide. (If the
  // server hasn't been updated yet, this falls back to mcp.)
  const minted = await apiCall<MintedToken>({
    method: 'POST',
    path: '/admin/api/tokens',
    body: { name, scope },
    token,
    baseUrl,
  });
  if (ctx.flags.json) { console.log(JSON.stringify(minted, null, 2)); return 0; }
  console.log('');
  console.log(`  token (shown ONCE — save now):`);
  console.log('');
  console.log(`    ${minted.token}`);
  console.log('');
  console.log(`  id:     ${minted.id}`);
  console.log(`  name:   ${minted.name}`);
  console.log(`  scope:  ${minted.scope}`);
  console.log(`  prefix: ${minted.prefix}`);
  console.log('');
  return 0;
}

async function cmdList(ctx: CommandContext): Promise<number> {
  const token = resolveAdminToken(ctx.flags.token);
  const baseUrl = resolveBaseUrl(ctx.flags.url);
  const scopeArg = (typeof ctx.flags.scope === 'string' ? ctx.flags.scope : null) as 'mcp' | 'admin' | null;
  const resp = await apiCall<{ tokens: TokenRow[] }>({
    method: 'GET',
    path: scopeArg ? `/admin/api/tokens?scope=${scopeArg}` : '/admin/api/tokens',
    token,
    baseUrl,
  });
  if (ctx.flags.json) { console.log(JSON.stringify(resp.tokens, null, 2)); return 0; }
  if (resp.tokens.length === 0) { console.log('(no tokens)'); return 0; }
  const header = ['ID', 'SCOPE', 'NAME', 'PREFIX', 'USE', 'LAST USED', 'STATUS'];
  const rows = resp.tokens.map(t => [
    String(t.id),
    t.scope,
    t.name,
    t.token_prefix,
    String(t.use_count),
    t.last_used_at ? new Date(t.last_used_at * 1000).toISOString().slice(0, 19) : '—',
    t.revoked_at ? 'revoked' : 'active',
  ]);
  printTable([header, ...rows]);
  return 0;
}

async function cmdRevoke(ctx: CommandContext): Promise<number> {
  const idOrPrefix = ctx.positional[0];
  if (!idOrPrefix) { console.error('usage: ritsu token revoke <id|prefix>'); return 2; }
  const token = resolveAdminToken(ctx.flags.token);
  const baseUrl = resolveBaseUrl(ctx.flags.url);
  let id: number;
  if (/^\d+$/.test(idOrPrefix)) {
    id = Number(idOrPrefix);
  } else {
    const list = await apiCall<{ tokens: TokenRow[] }>({
      method: 'GET', path: '/admin/api/tokens', token, baseUrl,
    });
    const match = list.tokens.filter(t => t.token_prefix.startsWith(idOrPrefix) && !t.revoked_at);
    if (match.length === 0) { console.error(`no active token matches prefix '${idOrPrefix}'`); return 1; }
    if (match.length > 1) { console.error(`ambiguous prefix — matches ${match.length} tokens`); return 1; }
    id = match[0].id;
  }
  await apiCall({ method: 'POST', path: `/admin/api/tokens/${id}/revoke`, token, baseUrl });
  console.log(`revoked token id=${id}`);
  return 0;
}

function printTable(rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => (r[i] ?? '').length)));
  for (const r of rows) {
    console.log(r.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  '));
  }
}

export const tokenCommand: Command = {
  name: 'token',
  summary: 'mint / list / revoke bearer tokens (MCP or admin scope)',
  needsRoot: false,
  help: () => [
    'ritsu token — manage MCP and admin tokens',
    '',
    '  ritsu token mint <name> [--scope mcp|admin]     mint a new token',
    '  ritsu token list [--scope mcp|admin]            list tokens (table)',
    '  ritsu token revoke <id|prefix>                  revoke by id or unique prefix',
    '',
    'Flags:',
    '  --json   machine-readable output',
    '',
    'Auth: reads /opt/ritsu/data/.admin-token by default. Override with',
    '--token or RITSU_ADMIN_TOKEN. For remote use also pass --url or set',
    'RITSU_URL (default http://127.0.0.1:7334).',
  ].join('\n'),
  run: async (ctx: CommandContext) => {
    switch (ctx.subcommand) {
      case 'mint':   return cmdMint(ctx);
      case 'list':   case null: return cmdList(ctx);
      case 'revoke': return cmdRevoke(ctx);
      default:
        console.error(`unknown subcommand: ${ctx.subcommand}`);
        return 2;
    }
  },
};

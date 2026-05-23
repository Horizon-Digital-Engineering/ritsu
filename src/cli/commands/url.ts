/**
 * `ritsu url` — print the URLs an operator actually uses (admin UI + MCP).
 * Derived from /etc/ritsu/env so it always matches the running service.
 */
import { readFileSync, existsSync } from 'node:fs';
import type { Command, CommandContext } from '../registry.js';

const ENV_FILE = '/etc/ritsu/env';

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export const urlCommand: Command = {
  name: 'url',
  summary: 'print the operator-facing URLs (admin UI, MCP, OAuth discovery)',
  needsRoot: true, // ENV_FILE is mode 0600 owned by ritsu
  help: () => [
    'ritsu url — print URLs',
    '',
    '  ritsu url            human-readable',
    '  ritsu url --json     machine-readable',
  ].join('\n'),
  run: async (ctx: CommandContext) => {
    const env = loadEnv();
    const publicUrl = env.RITSU_PUBLIC_URL ?? '';
    const adminHost = env.ADMIN_HOST ?? '127.0.0.1';
    const adminPort = env.ADMIN_PORT ?? '7334';
    const mcpHost   = env.MCP_HOST   ?? '127.0.0.1';
    const mcpPort   = env.PORT       ?? '7333';

    const urls = {
      admin: publicUrl ? `https://${new URL(publicUrl).host.replace(/:\d+$/, '')}:8443/admin` : `http://${adminHost}:${adminPort}/admin`,
      mcp:   publicUrl ? `${publicUrl}/mcp` : `http://${mcpHost}:${mcpPort}/mcp`,
      oauth_prm: publicUrl ? `${publicUrl}/.well-known/oauth-protected-resource` : null,
      local_admin: `http://${adminHost}:${adminPort}/admin`,
      local_mcp:   `http://${mcpHost}:${mcpPort}/mcp`,
    };

    if (ctx.flags.json) { console.log(JSON.stringify(urls, null, 2)); return 0; }
    console.log(`  admin UI:  ${urls.admin}`);
    console.log(`  MCP:       ${urls.mcp}`);
    if (urls.oauth_prm) console.log(`  OAuth PRM: ${urls.oauth_prm}`);
    if (urls.admin !== urls.local_admin) {
      console.log('');
      console.log(`  (local:    ${urls.local_admin})`);
      console.log(`  (local:    ${urls.local_mcp})`);
    }
    return 0;
  },
};

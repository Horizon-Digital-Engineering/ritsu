/**
 * `ritsu url` — print the URLs an operator actually uses (admin UI + MCP).
 * Derived from the same config the service loads, so it always matches the
 * running deployment.
 */
import type { Command, CommandContext } from '../registry.js';
import { loadConfig } from '../../config.js';

export const urlCommand: Command = {
  name: 'url',
  summary: 'print the operator-facing URLs (admin UI, MCP, OAuth discovery)',
  needsRoot: true, // /etc/ritsu/env is mode 0600 owned by ritsu in prod
  help: () => [
    'ritsu url — print URLs',
    '',
    '  ritsu url            human-readable',
    '  ritsu url --json     machine-readable',
  ].join('\n'),
  run: async (ctx: CommandContext) => {
    const cfg = loadConfig();
    const publicUrl = cfg.publicUrl ?? '';

    const urls = {
      admin: publicUrl
        ? `https://${new URL(publicUrl).host.replace(/:\d+$/, '')}:8443/admin`
        : `http://${cfg.adminHost}:${cfg.adminPort}/admin`,
      mcp: publicUrl
        ? `${publicUrl}/mcp`
        : `http://${cfg.mcpHost}:${cfg.mcpPort}/mcp`,
      oauth_prm: publicUrl ? `${publicUrl}/.well-known/oauth-protected-resource` : null,
      local_admin: `http://${cfg.adminHost}:${cfg.adminPort}/admin`,
      local_mcp:   `http://${cfg.mcpHost}:${cfg.mcpPort}/mcp`,
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

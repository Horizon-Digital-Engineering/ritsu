import { loadDotenv } from './util/dotenv-lite.js';
loadDotenv();
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { openDatabase } from './db.js';
import { SqliteMemoryStore } from './memory-store.js';
import { SqliteConversationStore } from './conversation-store.js';
import { SqliteAgentDefinitionStore, seedIfEmpty } from './agent-definition-store.js';
import { WorkspaceStore } from './workspace-store.js';
import { TokenStore } from './auth/token-store.js';
import { ApiKeyStore } from './auth/api-key-store.js';
import { OAuthStore } from './auth/oauth-store.js';
import { AgentHost } from './agent-host.js';
import { createMcpServer, parseAuthMode } from './mcp-server.js';
import { createAdminApp } from './admin/server.js';
import { SqliteChannelStore } from './channels/channel-store.js';
import { ChannelRegistry } from './channels/registry.js';
import { logger } from './util/log.js';
import { stripTrailingSlashes } from './util/path-utils.js';

const ADMIN_TOKEN_FILE = '/opt/ritsu/data/.admin-token';

/**
 * If no admin-scoped token exists yet, mint one and write the plaintext to
 * ADMIN_TOKEN_FILE (mode 0600, owned by the running user). The operator
 * (configure.sh or by hand) reads this file once and treats it as a secret.
 * Re-run safe: if admin tokens already exist, this is a no-op.
 */
function bootstrapAdminToken(tokens: TokenStore): void {
  if (tokens.hasAnyActive('admin')) {
    logger.debug('admin.token.exists');
    return;
  }
  const minted = tokens.mint('bootstrap', 'admin');
  try {
    writeFileSync(ADMIN_TOKEN_FILE, minted.token + '\n', { mode: 0o600 });
    logger.warn('admin.token.bootstrapped', { path: ADMIN_TOKEN_FILE, prefix: minted.prefix });
  } catch (err) {
    logger.error('admin.token.write-failed', {
      path: ADMIN_TOKEN_FILE,
      err: (err as Error).message,
      hint: 'admin token minted in DB but plaintext not saved — read it from journal once or revoke + restart to retry',
    });
  }
}

const PORT             = Number(process.env.PORT ?? 7333);
const MCP_HOST         = process.env.MCP_HOST ?? '127.0.0.1';
const ADMIN_PORT       = Number(process.env.ADMIN_PORT ?? 7334);
const ADMIN_HOST       = process.env.ADMIN_HOST ?? '127.0.0.1';
const DB_PATH          = resolve(process.env.DB_PATH ?? './data/ritsu.db');
const AUTH_MODE        = parseAuthMode(process.env.MCP_REQUIRE_AUTH);
// Extra Host header values to accept on /mcp (for reverse proxies like
// Tailscale Serve that forward a public hostname in Host).
const ALLOWED_HOSTS    = (process.env.RITSU_ALLOWED_HOSTS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
// Canonical public origin (no trailing slash). Required for OAuth.
// e.g. https://your-host.your-tailnet.ts.net:9443
const PUBLIC_URL       = stripTrailingSlashes(process.env.RITSU_PUBLIC_URL ?? '') || undefined;
// Single source of truth for the version: package.json. Anything that bumps
// the npm version (npm version, manual edit) flows through to the running
// service's /version endpoint, admin UI, and CLI `ritsu --version`.
const VERSION          = pkg.version;

async function main(): Promise<void> {
  const db = openDatabase(DB_PATH);
  const memory = new SqliteMemoryStore(db);
  const conversations = new SqliteConversationStore(db);
  const defStore = new SqliteAgentDefinitionStore(db);
  const tokens = new TokenStore(db);
  const apiKeys = new ApiKeyStore(db);
  const oauth = new OAuthStore(db);
  const workspaces = new WorkspaceStore(db);

  bootstrapAdminToken(tokens);
  await seedIfEmpty(defStore);

  const host = new AgentHost(db, conversations, defStore, workspaces, apiKeys);
  await host.loadAll();

  // Comm channels (Telegram + future Discord/Slack). Each enabled row in
  // `channels` becomes a running long-poll instance pinned to one agent.
  const channelStore = new SqliteChannelStore(db);
  const channels = new ChannelRegistry(channelStore, {
    get: (id: string) => host.get(id),
  });
  await channels.loadAll();

  const mcpApp = createMcpServer({
    host,
    memory,
    defStore,
    tokens,
    oauth,
    authMode: AUTH_MODE,
    bindHost: MCP_HOST,
    allowedHosts: ALLOWED_HOSTS,
    publicUrl: PUBLIC_URL,
    version: VERSION,
  });

  const adminApp = createAdminApp({
    defStore,
    host,
    tokens,
    apiKeys,
    workspaces,
    memory,
    conversations,
    channels: channelStore,
    channelRegistry: channels,
    oauth,
    version: VERSION,
    authMode: AUTH_MODE,
    mcpUrl: `http://${MCP_HOST === '0.0.0.0' ? '127.0.0.1' : MCP_HOST}:${PORT}`,
  });

  const mcpServer = mcpApp.listen(PORT, MCP_HOST, () => {
    logger.info('mcp.listening', {
      host: MCP_HOST,
      port: PORT,
      auth_mode: AUTH_MODE,
    });
  });

  const adminServer = adminApp.listen(ADMIN_PORT, ADMIN_HOST, () => {
    logger.info('admin.listening', {
      host: ADMIN_HOST,
      port: ADMIN_PORT,
      url: `http://${ADMIN_HOST}:${ADMIN_PORT}/admin`,
    });
  });

  const shutdown = (): void => {
    logger.info('server.shutdown');
    // Stop channels first so their loops finish before the DB closes.
    channels.shutdown()
      .catch(err => logger.warn('channel.shutdown-error', { err: (err as Error).message }))
      .finally(() => {
        mcpServer.close();
        adminServer.close();
        db.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  await main();
} catch (err) {
  logger.error('fatal', { err: (err as Error).stack ?? String(err) });
  process.exit(1);
}

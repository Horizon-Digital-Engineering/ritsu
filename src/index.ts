import { hydrateEnv, loadConfig, assertAdminTokenFileWritable } from './config.js';
hydrateEnv();
import pkg from '../package.json' with { type: 'json' };
import { bootstrapAdminToken } from './bootstrap-admin-token.js';
import { openDatabase } from './db.js';
import { SqliteMemoryStore } from './memory-store.js';
import { SqliteConversationStore } from './conversation-store.js';
import { SqliteAgentDefinitionStore, seedIfEmpty } from './agent-definition-store.js';
import { WorkspaceStore } from './workspace-store.js';
import { TokenStore } from './auth/token-store.js';
import { ApiKeyStore } from './auth/api-key-store.js';
import { OAuthStore } from './auth/oauth-store.js';
import { AgentHost } from './agent-host.js';
import { createMcpServer } from './mcp-server.js';
import { createAdminApp } from './admin/server.js';
import { SqliteChannelStore } from './channels/channel-store.js';
import { ChannelRegistry } from './channels/registry.js';
import { logger } from './util/log.js';

const cfg = loadConfig();
// Single source of truth for the version: package.json. Anything that bumps
// the npm version (npm version, manual edit) flows through to the running
// service's /version endpoint, admin UI, and CLI `ritsu --version`.
const VERSION = pkg.version;

async function main(): Promise<void> {
  // Refuse to start if the bootstrap path isn't a sane place for a 0600 file.
  // Runs BEFORE openDatabase so a bad config doesn't even touch the DB.
  assertAdminTokenFileWritable(cfg);

  const db = openDatabase(cfg.dbPath);
  const memory = new SqliteMemoryStore(db);
  const conversations = new SqliteConversationStore(db);
  const defStore = new SqliteAgentDefinitionStore(db);
  const tokens = new TokenStore(db);
  const apiKeys = new ApiKeyStore(db);
  const oauth = new OAuthStore(db);
  const workspaces = new WorkspaceStore(db);

  bootstrapAdminToken(tokens, cfg);
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
    authMode: cfg.authMode,
    bindHost: cfg.mcpHost,
    allowedHosts: [...cfg.allowedHosts],
    publicUrl: cfg.publicUrl,
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
    authMode: cfg.authMode,
    mcpUrl: `http://${cfg.mcpHost === '0.0.0.0' ? '127.0.0.1' : cfg.mcpHost}:${cfg.mcpPort}`,
  });

  const mcpServer = mcpApp.listen(cfg.mcpPort, cfg.mcpHost, () => {
    logger.info('mcp.listening', {
      host: cfg.mcpHost,
      port: cfg.mcpPort,
      auth_mode: cfg.authMode,
    });
  });

  const adminServer = adminApp.listen(cfg.adminPort, cfg.adminHost, () => {
    logger.info('admin.listening', {
      host: cfg.adminHost,
      port: cfg.adminPort,
      url: `http://${cfg.adminHost}:${cfg.adminPort}/admin`,
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
  // Config errors get the message printed plainly so the operator can
  // read it without parsing a structured log line. Everything else takes
  // the normal structured-log path with full stack.
  if ((err as Error)?.name === 'ConfigError') {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(78); // EX_CONFIG
  }
  logger.error('fatal', { err: (err as Error).stack ?? String(err) });
  process.exit(1);
}

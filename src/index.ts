import { hydrateEnv, loadConfig, assertAdminTokenFileWritable } from './config.js';
hydrateEnv();
import pkg from '../package.json' with { type: 'json' };
import { bootstrapAdminToken } from './bootstrap-admin-token.js';
import { openDatabase } from './db.js';
import { SqliteMemoryStore } from './memory-store.js';
import { SqliteConversationStore } from './conversation-store.js';
import { SqliteAgentDefinitionStore, seedIfEmpty } from './agent-definition-store.js';
import { WorkspaceStore } from './workspace-store.js';
import { ApprovalStore } from './approval-store.js';
import { PluginHost } from './plugins/host.js';
import { discoverPlugins } from './plugins/discover.js';
import { CommsDenialStore } from './comms-denial-store.js';
import { SecretStore } from './auth/secret-store.js';
import { TokenStore } from './auth/token-store.js';
import { ApiKeyStore } from './auth/api-key-store.js';
import { OAuthStore } from './auth/oauth-store.js';
import { AgentHost } from './agent-host.js';
import { loadMemoryConfig } from './memory/config.js';
import { buildMemoryService } from './memory/factory.js';
import { FlashbackProposalClient, ProposalAdapter } from './memory/proposal-adapter.js';
import { BackupManager } from './backup.js';
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
  const approvals = new ApprovalStore(db);
  const secrets = new SecretStore(db);
  const pluginHost = new PluginHost(db, secrets);
  for (const plugin of await discoverPlugins()) pluginHost.register(plugin);
  // Close out any approvals left pending by a prior process — their agent
  // turns died with that process and can never resume.
  approvals.reconcileOnBoot();
  // Periodic sweep: reap pending approvals whose turn was abandoned mid-await
  // (SDK tool-timeout, dropped socket) so the resolver map + the rows don't
  // grow unbounded between restarts. 24h matches "agents can hang a while".
  const APPROVAL_TTL_S = Number(process.env.RITSU_APPROVAL_TTL_S ?? 86400) || 86400;
  const approvalSweep = setInterval(() => {
    try { approvals.sweepStale(APPROVAL_TTL_S); }
    catch (err) { logger.warn('approval.sweep-error', { err: (err as Error).message }); }
  }, 3_600_000); // hourly
  approvalSweep.unref();
  const commsDenials = new CommsDenialStore(db);

  // Data safety: a consistent DB snapshot on boot (pre-deploy safety) + daily,
  // keeping the newest N. Best-effort — a backup failure never blocks startup.
  const backup = new BackupManager(db, cfg.dbPath, process.env.RITSU_BACKUP_DIR?.trim() || undefined);
  const BACKUP_KEEP = Number(process.env.RITSU_BACKUP_KEEP ?? 14) || 14;
  const runBackup = (): void => {
    try { backup.createBackup(); backup.prune(BACKUP_KEEP); }
    catch (err) { logger.warn('backup.error', { err: (err as Error).message }); }
  };
  runBackup();
  const backupSweep = setInterval(runBackup, 24 * 3_600_000);
  backupSweep.unref();

  bootstrapAdminToken(tokens, cfg);
  await seedIfEmpty(defStore);

  const host = new AgentHost(db, conversations, defStore, workspaces, apiKeys, approvals, secrets, commsDenials);
  host.setPluginHost(pluginHost);

  // Flow-level memory over the MemoryBackend seam. Default MEMORY_BACKEND=sqlite
  // => today's behavior exactly. flashback/dual opt this install into the remote
  // store (sqlite stays the on-box backstop). Built here so it's wired before
  // any agent is constructed.
  const memoryConfig = loadMemoryConfig();
  const memoryService = buildMemoryService(db, memoryConfig);
  host.setMemoryService(memoryService);
  logger.info('memory.wired', { mode: memoryConfig.mode, remote: !!memoryConfig.flashback });

  // Proposal adapter: when flashback is configured, surface its proposed
  // actions into the existing approval gate and report operator decisions back.
  // Skipped entirely in sqlite mode. Fully best-effort — a flashback outage
  // never touches ritsu's own approval flow.
  let proposalSweep: NodeJS.Timeout | undefined;
  if (memoryConfig.flashback) {
    const proposalClient = new FlashbackProposalClient({
      endpoint: memoryConfig.flashback.endpoint,
      token: memoryConfig.flashback.token,
      timeoutMs: memoryConfig.flashback.timeoutMs,
    });
    const proposals = new ProposalAdapter({ client: proposalClient, approvals });
    proposals.start(); // subscribe to the approval bus for decision reporting
    const PROPOSAL_POLL_MS = Number(process.env.FLASHBACK_PROPOSAL_POLL_MS ?? 60000) || 60000;
    const pollProposals = (): void => {
      proposals.sync().catch(err =>
        logger.warn('proposal.sync-error', { err: (err as Error).message }));
    };
    pollProposals();
    proposalSweep = setInterval(pollProposals, PROPOSAL_POLL_MS);
    proposalSweep.unref();
  }

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
    pluginHost,
    memory,
    conversations,
    approvals,
    commsDenials,
    secrets,
    backup,
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
    if (proposalSweep) clearInterval(proposalSweep);
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

  // Survive a stray rejection. A long-lived multi-agent server must not die
  // because one floating promise (a channel poll, a connector call) rejected
  // without a local catch — log it and keep serving.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { err: err.message });
  });
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

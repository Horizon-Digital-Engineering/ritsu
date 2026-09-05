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
import { SettingsStore } from './settings-store.js';
import { masterKeyStatus } from './util/secret-crypto.js';
import { CLAUDE_NS } from './model/claude-direct-dispatcher.js';
import { FlashbackProposalClient, ProposalAdapter } from './memory/proposal-adapter.js';
import { BackupManager, snapshotPreMigration } from './backup.js';
import { ProjectStore } from './project-store.js';
import { SkillStore } from './skill-store.js';
import { PromptStore } from './prompt-store.js';
import { createMcpServer } from './mcp-server.js';
import { createAdminApp } from './admin/server.js';
import { SqliteChannelStore } from './channels/channel-store.js';
import { ChannelRegistry } from './channels/registry.js';
import { SqliteJobStore } from './scheduler/store.js';
import { SchedulerRunner } from './scheduler/runner.js';
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

  // Snapshot BEFORE the migrations, so the newest backup is always a copy of
  // the database as it was before this boot touched it. Best-effort.
  const backupDirOverride = process.env.RITSU_BACKUP_DIR?.trim() || undefined;
  try { snapshotPreMigration(cfg.dbPath, backupDirOverride); }
  catch (err) { logger.warn('backup.pre-migration-failed', { err: (err as Error).message }); }

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
  const projects = new ProjectStore(db);
  const skills = new SkillStore(db);
  const promptLib = new PromptStore(db);
  const pluginHost = new PluginHost(db, secrets);
  for (const plugin of await discoverPlugins()) pluginHost.register(plugin);
  // Close out any approvals left pending by a prior process — their agent
  // turns died with that process and can never resume.
  approvals.reconcileOnBoot();
  // Periodic sweep: reap pending approvals whose turn was abandoned mid-await
  // (SDK tool-timeout, dropped socket) so the resolver map + the rows don't
  // grow unbounded between restarts. 24h matches "agents can hang a while".
  // Operator-tunable knobs (retention, sweep windows, rate limits, the search
  // backend). Security switches deliberately stay in the env file — see
  // settings-store.ts.
  const settings = new SettingsStore(db);
  const APPROVAL_TTL_S = settings.getNumber('approvals.ttl_seconds', 86400);
  const approvalSweep = setInterval(() => {
    try { approvals.sweepStale(APPROVAL_TTL_S); }
    catch (err) { logger.warn('approval.sweep-error', { err: (err as Error).message }); }
  }, 3_600_000); // hourly
  approvalSweep.unref();
  const commsDenials = new CommsDenialStore(db);

  // Data safety: a consistent DB snapshot on boot (pre-deploy safety) + daily,
  // keeping the newest N. Best-effort — a backup failure never blocks startup.
  const backup = new BackupManager(db, cfg.dbPath, backupDirOverride);
  const BACKUP_KEEP = settings.getNumber('backups.keep', 14);
  const runBackup = (): void => {
    try { backup.createBackup(); backup.prune(BACKUP_KEEP); }
    catch (err) { logger.warn('backup.error', { err: (err as Error).message }); }
  };
  // Trim scheduler history before the snapshot, not after: the backup copies
  // whatever is on disk and keeps fourteen of them, so unbounded run rows are
  // stored fifteen times over.
  let pruneRuns: (() => void) | undefined;
  const dailyMaintenance = (): void => { pruneRuns?.(); runBackup(); };
  const backupSweep = setInterval(dailyMaintenance, 24 * 3_600_000);
  backupSweep.unref();

  // Secrets are unusable without a key, and the failure would otherwise first
  // appear as a 500 when an operator saves a credential.
  const keyState = masterKeyStatus();
  if (keyState.ok) logger.info('crypto.master-key.available', { source: keyState.source });
  else logger.warn('crypto.master-key.missing', { detail: keyState.detail });

  // Direct-runtime agents dispatch through a subscription token. Say at boot
  // when there isn't one, rather than letting it surface as a failed turn.
  if (!secrets.get(CLAUDE_NS, 'oauth_token')?.trim() && !process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    logger.warn('claude.token.missing', {
      hint: 'direct-runtime agents cannot dispatch — generate one with `claude setup-token` and save it under API Keys',
    });
  }

  bootstrapAdminToken(tokens, cfg);
  await seedIfEmpty(defStore);

  const host = new AgentHost(db, conversations, defStore, workspaces, apiKeys, approvals, secrets, commsDenials);
  host.setPluginHost(pluginHost);
  // Before loadAll: agent tool sets are built as each agent loads, so a store
  // handed over afterwards reaches nobody.
  const jobStore = new SqliteJobStore(db);
  host.setJobStore(jobStore);
  // Plugins declare their periodic work during mountApi, which needs the store.
  pluginHost.setJobStore(jobStore);

  // Flow-level memory over the MemoryBackend seam. Configured from the encrypted
  // SecretStore (namespace 'flashback', set in the admin Secrets UI); with no
  // credentials it stays sqlite-only — today's behavior exactly. Built here so
  // it's wired before any agent is constructed.
  const memoryConfig = loadMemoryConfig(secrets);
  const memoryService = buildMemoryService(db, memoryConfig);
  host.setMemoryService(memoryService);
  host.setSettings(settings);
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
    const PROPOSAL_POLL_MS = memoryConfig.flashback.proposalPollMs;
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

  // Scheduled jobs. Started after channels so a job firing on the first tick
  // has somewhere to deliver — a reminder that races channel startup would
  // fail for no reason the operator could act on.
  const scheduler = new SchedulerRunner({
    store: jobStore,
    delivery: channels,
    agents: { get: (id: string) => host.get(id) },
  });
  scheduler.start();
  pruneRuns = () => scheduler.prune();
  // Trim scheduler history now rather than a day later — a service redeployed
  // daily would otherwise never prune at all. The boot snapshot is already
  // taken (pre-migration, above), so this only prunes; taking a second one
  // here would halve backup retention on every restart.
  pruneRuns();
  try { backup.prune(BACKUP_KEEP); }
  catch (err) { logger.warn('backup.error', { err: (err as Error).message }); }

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
    settings,
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
    projects,
    skills,
    prompts: promptLib,
    channels: channelStore,
    channelRegistry: channels,
    jobs: jobStore,
    oauth,
    version: VERSION,
    authMode: cfg.authMode,
    mcpUrl: `http://${cfg.mcpHost === '0.0.0.0' ? '127.0.0.1' : cfg.mcpHost}:${cfg.mcpPort}`,
    memoryBoot: { mode: memoryConfig.mode, remote: memoryConfig.flashback?.endpoint ?? null },
    settings,
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
    // Before channels: a tick that started mid-shutdown would otherwise try to
    // deliver through a registry that's already stopping.
    scheduler.stop();
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

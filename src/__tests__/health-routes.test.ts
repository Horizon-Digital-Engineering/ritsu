/**
 * The open health routes over real HTTP. They answer without a login, so the
 * test seeds the data with the kind of names, paths and addresses a real
 * install holds and checks that none of them reach the body.
 */
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { TokenStore } from '../auth/token-store.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { OAuthStore } from '../auth/oauth-store.js';
import { WorkspaceStore } from '../workspace-store.js';
import { ApprovalStore } from '../approval-store.js';
import { SecretStore } from '../auth/secret-store.js';
import { PluginHost } from '../plugins/host.js';
import { CommsDenialStore } from '../comms-denial-store.js';
import { AgentHost, type DispatcherFactory } from '../agent-host.js';
import { SqliteChannelStore } from '../channels/channel-store.js';
import { ChannelRegistry } from '../channels/registry.js';
import type { CommChannel, ChannelRow } from '../channels/types.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { SchedulerRunner } from '../scheduler/runner.js';
import { createAdminApp } from '../admin/server.js';
import { ProjectStore } from '../project-store.js';
import { SkillStore } from '../skill-store.js';
import { PromptStore } from '../prompt-store.js';
import { SettingsStore } from '../settings-store.js';
import { BackupManager, _setScryptWorkFactorForTests } from '../backup.js';
import { SpeechService, storeSources } from '../speech/index.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';
import type { AgentDefinition } from '../admin/schema.js';
import type { HealthSummary } from '../health/types.js';

_setScryptWorkFactorForTests(10);

const stubFactory: DispatcherFactory = (def) => ({
  kind: 'claude-direct',
  defaultModel: def.model,
  async chat() { return { content: 'stub', model: def.model, raw: null }; },
});

class IdleRegistry extends ChannelRegistry {
  protected override build(row: ChannelRow): CommChannel {
    return { channelId: row.id, start: async () => undefined, stop: async () => undefined, send: async () => undefined };
  }
}

function agent(id: string, name: string, runtime: 'direct' | 'api'): AgentDefinition {
  return {
    id, type: 'generic', name, description: 'keeps the household budget', system_prompt: 'be brief',
    runtime, provider: runtime === 'direct' ? 'claude' : 'litellm', model: 'some-model', memory_backend: 'sqlite',
    tools_allowlist: [], can_call: [], api_key_ref: null, provider_options: {}, capabilities: [],
    approval_tools: [], plugins: [], enabled: true, escalation_approvable: false, allow_monitor_read: false,
  };
}

const SENSITIVE = [
  'household-ledger', 'Household Ledger', 'garden-planner', 'Garden Planner',
  'nightly-ledger-sync', 'Nightly ledger sync',
  'family-telegram', '987654321', 'bot-tok',
  'work-gateway', 'gw-live-0123456789abcdef', 'oauth-token-for-the-test',
  'acme-ledger', 'Acme Ledger',
  'whisper.lan.example', '8080', '/inference',
  'studio-mac-2', 'backups-share', 'ritsu.db', '.age',
];

describe('open health routes', () => {
  let db: Db;
  let tmp: string;
  let server: Server;
  let base = '';
  let mcpUp = true;
  let scheduler: SchedulerRunner;

  const get = async (path: string): Promise<{ status: number; cache: string | null; text: string; body: HealthSummary }> => {
    const res = await fetch(`${base}${path}`);
    const text = await res.text();
    return { status: res.status, cache: res.headers.get('cache-control'), text, body: JSON.parse(text) as HealthSummary };
  };

  before(async () => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    tmp = mkdtempSync(join(tmpdir(), 'ritsu-health-routes-'));
    const dbPath = join(tmp, 'data', 'ritsu.db');
    db = openDatabase(dbPath);

    const defStore = new SqliteAgentDefinitionStore(db);
    const conversations = new SqliteConversationStore(db);
    const workspaces = new WorkspaceStore(db);
    const apiKeys = new ApiKeyStore(db);
    const approvals = new ApprovalStore(db);
    const secrets = new SecretStore(db);
    const commsDenials = new CommsDenialStore(db);
    const tokens = new TokenStore(db);
    const settings = new SettingsStore(db);
    const pluginHost = new PluginHost(db, secrets);
    pluginHost.register({ manifest: { id: 'acme-ledger', name: 'Acme Ledger', version: '1.0.0' } });
    const host = new AgentHost(db, conversations, defStore, workspaces, apiKeys, approvals, secrets, commsDenials, stubFactory);
    host.setPluginHost(pluginHost);

    await defStore.upsert(agent('household-ledger', 'Household Ledger', 'direct'));
    await defStore.upsert(agent('garden-planner', 'Garden Planner', 'api'));
    await host.loadAll();
    secrets.set('claude', 'oauth_token', 'oauth-token-for-the-test');
    apiKeys.mint('work-gateway', 'custom', 'gw-live-0123456789abcdef');
    settings.set('speech.engine', 'local');
    settings.set('speech.whisper_url', 'http://whisper.lan.example:8080/inference');

    const channelStore = new SqliteChannelStore(db);
    channelStore.create({
      name: 'family-telegram', kind: 'telegram', operator_agent_id: 'household-ledger',
      config: { bot_token: 'bot-tok', chat_id: 987654321 },
    });
    const channels = new IdleRegistry(channelStore, { get: (id: string) => host.get(id) });
    await channels.loadAll();

    const jobs = new SqliteJobStore(db);
    jobs.upsert({
      id: 'nightly-ledger-sync', name: 'Nightly ledger sync', owner: 'plugin:acme-ledger',
      schedule: { kind: 'every', spec: '24h' }, payload: { kind: 'notify', text: 'balance check' },
    });
    scheduler = new SchedulerRunner({ store: jobs, delivery: channels, agents: { get: (id: string) => host.get(id) } });
    scheduler.start();

    const backup = new BackupManager(db, dbPath, join(tmp, 'backups-share'), { host: 'studio-mac-2' });
    backup.setPassword('a sentence that is long enough');
    await backup.createBackup('daily');

    const app = createAdminApp({
      db, defStore, host, tokens, apiKeys, workspaces, pluginHost,
      memory: new SqliteMemoryStore(db), conversations, approvals, commsDenials, secrets,
      channels: channelStore, channelRegistry: channels, jobs, backup,
      oauth: new OAuthStore(db), projects: new ProjectStore(db), skills: new SkillStore(db), prompts: new PromptStore(db),
      settings, speech: new SpeechService(storeSources(backup.dataDir(), settings, apiKeys)),
      version: '9.9.9', authMode: 'on', mcpUrl: 'http://127.0.0.1:7333',
      mcpListening: () => mcpUp,
      schedulerRunning: () => scheduler.running,
      pluginFailures: () => 0,
    });
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    scheduler?.stop();
    server?.close();
    db?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('answers /healthz and /readyz without a login, uncached, naming all ten parts', async () => {
    for (const path of ['/healthz', '/readyz']) {
      const { status, cache, body } = await get(path);
      assert.equal(status, 200, path);
      assert.equal(cache, 'no-store');
      assert.equal(body.name, 'ritsu');
      assert.equal(body.version, '9.9.9');
      assert.equal(typeof body.uptime_s, 'number');
      assert.deepEqual(body.parts.map(p => p.id), [
        'database', 'secrets', 'subscription', 'agents', 'mcp', 'voice', 'backups', 'scheduler', 'plugins', 'channels',
      ]);
    }
  });

  it('reports each part from the real stores', async () => {
    const { body } = await get('/healthz');
    const notes = Object.fromEntries(body.parts.map(p => [p.id, [p.status, p.note]]));
    assert.match(notes.database[1], /^(open|low disk), [\d.]+ GB free$/);
    assert.deepEqual(notes.secrets, ['ok', 'key loaded']);
    assert.deepEqual(notes.subscription, ['ok', 'stored']);
    assert.deepEqual(notes.agents, ['ok', '2 loaded']);
    assert.deepEqual(notes.mcp, ['ok', 'listening']);
    assert.deepEqual(notes.voice, ['ok', 'Whisper server']);
    assert.deepEqual(notes.backups, ['ok', 'newest under 1 h old']);
    assert.deepEqual(notes.scheduler, ['ok', '1 job, none failing']);
    assert.deepEqual(notes.plugins, ['ok', '1 loaded']);
    assert.deepEqual(notes.channels, ['ok', '1 running']);
  });

  it('carries no names, ids, paths, addresses or secrets from the data', async () => {
    for (const path of ['/healthz', '/readyz']) {
      const { text } = await get(path);
      for (const s of [...SENSITIVE, tmp]) assert.ok(!text.includes(s), `${path} leaked ${s}`);
    }
  });

  it('turns /readyz to 503 while a part fails, and keeps /healthz at 200', async () => {
    mcpUp = false;
    try {
      const ready = await get('/readyz');
      assert.equal(ready.status, 503);
      assert.equal(ready.body.status, 'fail');
      assert.deepEqual(ready.body.parts.find(p => p.id === 'mcp'), { id: 'mcp', label: 'MCP server', status: 'fail', note: 'not listening' });
      const live = await get('/healthz');
      assert.equal(live.status, 200);
      assert.equal(live.body.status, 'fail');
    } finally {
      mcpUp = true;
    }
    assert.equal((await get('/readyz')).status, 200);
  });
});

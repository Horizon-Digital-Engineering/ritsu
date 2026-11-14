import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo, Server } from 'node:net';
import { openDatabase } from '../db.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { WorkspaceStore } from '../workspace-store.js';
import { ApprovalStore } from '../approval-store.js';
import { PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { TokenStore } from '../auth/token-store.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { OAuthStore } from '../auth/oauth-store.js';
import { CommsDenialStore } from '../comms-denial-store.js';
import { AgentHost } from '../agent-host.js';
import { SqliteChannelStore } from '../channels/channel-store.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { ChannelRegistry } from '../channels/registry.js';
import { createAdminApp } from '../admin/server.js';
import { ProjectStore } from '../project-store.js';
import { SkillStore } from '../skill-store.js';
import { PromptStore } from '../prompt-store.js';
import { SettingsStore } from '../settings-store.js';
import { BackupManager } from '../backup.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';
import { SEARCH_NS } from '../tools/ritsu-agent/search-config.js';

// A stand-in value; the test only checks it lands in the secret store, not the settings table.
const KEY = 'search-key-for-the-test';

describe('admin settings API', () => {
  let server: Server;
  let base = '';
  let adminToken = '';
  let settings: SettingsStore;
  let secrets: SecretStore;

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  before(async () => {
    process.env.RITSU_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
    _resetKeyCacheForTests();
    const db = openDatabase(':memory:');
    const memory = new SqliteMemoryStore(db);
    const conversations = new SqliteConversationStore(db);
    const defStore = new SqliteAgentDefinitionStore(db);
    const tokens = new TokenStore(db);
    const apiKeys = new ApiKeyStore(db);
    const oauth = new OAuthStore(db);
    const workspaces = new WorkspaceStore(db);
    const approvals = new ApprovalStore(db);
    secrets = new SecretStore(db);
    const pluginHost = new PluginHost(db, secrets);
    const commsDenials = new CommsDenialStore(db);
    const host = new AgentHost(db, conversations, defStore, workspaces, apiKeys, approvals, secrets, commsDenials);
    host.setPluginHost(pluginHost);
    const channelStore = new SqliteChannelStore(db);
    const channels = new ChannelRegistry(channelStore, { get: (id: string) => host.get(id) });
    adminToken = tokens.mint('test-admin', 'admin').token;
    settings = new SettingsStore(db);
    const app = createAdminApp({
      db, defStore, host, tokens, apiKeys, workspaces, pluginHost, memory, conversations,
      approvals, commsDenials, secrets, channels: channelStore, channelRegistry: channels, jobs: new SqliteJobStore(db),
      backup: new BackupManager(db, ':memory:'), oauth, projects: new ProjectStore(db), skills: new SkillStore(db), prompts: new PromptStore(db),
      settings, version: 'test', authMode: 'on', mcpUrl: 'http://127.0.0.1:7333',
    });
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => { server?.close(); });

  it('lists the knobs with their defaults and nothing stored yet', async () => {
    const res = await call('GET', '/admin/api/settings');
    assert.equal(res.status, 200);
    const d = await res.json() as { settings: Record<string, string>; defaults: Record<string, string>; search_providers: string[]; search_key_set: boolean };
    assert.deepEqual(d.settings, {});
    assert.equal(d.defaults['backups.keep'], '14');
    assert.equal(d.defaults['backups.interval_hours'], '24');
    assert.ok(d.search_providers.includes('searxng'));
    assert.equal(d.search_key_set, false);
  });

  it('saves valid values, clears blanks, and keeps the API key out of the settings table', async () => {
    const res = await call('POST', '/admin/api/settings', {
      settings: { 'backups.keep': ' 30 ', 'search.provider': 'searxng', 'search.url': 'http://search.internal:8080', 'approvals.ttl_seconds': '' },
      search_api_key: KEY,
    });
    assert.equal(res.status, 200);
    assert.equal(settings.get('backups.keep'), '30');
    assert.equal(settings.get('search.provider'), 'searxng');
    assert.equal(settings.get('approvals.ttl_seconds'), null);
    assert.equal(settings.get('search_api_key'), null);
    assert.equal(secrets.get(SEARCH_NS, 'api_key'), KEY);

    const d = await (await call('GET', '/admin/api/settings')).json() as { settings: Record<string, string>; search_key_set: boolean };
    assert.equal(d.settings['backups.keep'], '30');
    assert.equal(d.search_key_set, true);

    assert.equal((await call('POST', '/admin/api/settings', { settings: { 'backups.keep': '' } })).status, 200);
    assert.equal(settings.get('backups.keep'), null, 'blank restores the default');
  });

  it('rejects unknown keys and bad values without writing anything', async () => {
    const before = settings.all();
    assert.equal((await call('POST', '/admin/api/settings', { settings: { 'mcp.require_auth': 'off' } })).status, 400);
    assert.equal((await call('POST', '/admin/api/settings', { settings: { 'backups.keep': 'many' } })).status, 400);
    assert.equal((await call('POST', '/admin/api/settings', { settings: { 'backups.keep': '-3' } })).status, 400);
    assert.equal((await call('POST', '/admin/api/settings', { settings: { 'search.provider': 'bing' } })).status, 400);
    assert.equal((await call('POST', '/admin/api/settings', { settings: { 'search.url': 'ftp://x' } })).status, 400);
    const mixed = await call('POST', '/admin/api/settings', { settings: { 'search.provider': 'brave', 'backups.keep': 'nope' } });
    assert.equal(mixed.status, 400);
    assert.deepEqual(settings.all(), before, 'a bad entry means nothing in the request lands');
  });
});

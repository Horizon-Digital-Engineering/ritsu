import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo, Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { BackupManager, _setScryptWorkFactorForTests } from '../backup.js';

_setScryptWorkFactorForTests(10);

// Long enough for the minimum; a plain sentence, so nothing mistakes it for a credential.
const GOOD = 'a sentence that is long enough';

describe('admin backups API', () => {
  let server: Server;
  let base = '';
  let adminToken = '';
  let tmp: string;

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ritsu-adm-bk-'));
    const dbPath = join(tmp, 'data', 'ritsu.db');
    const db = openDatabase(dbPath);
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
    const commsDenials = new CommsDenialStore(db);
    const host = new AgentHost(db, conversations, defStore, workspaces, apiKeys, approvals, secrets, commsDenials);
    host.setPluginHost(pluginHost);
    const channelStore = new SqliteChannelStore(db);
    const channels = new ChannelRegistry(channelStore, { get: (id: string) => host.get(id) });
    adminToken = tokens.mint('test-admin', 'admin').token;
    const app = createAdminApp({
      db, defStore, host, tokens, apiKeys, workspaces, pluginHost, memory, conversations,
      approvals, commsDenials, secrets, channels: channelStore, channelRegistry: channels, jobs: new SqliteJobStore(db),
      backup: new BackupManager(db, dbPath, join(tmp, 'backups'), { host: 'testbox' }),
      oauth, projects: new ProjectStore(db), skills: new SkillStore(db), prompts: new PromptStore(db),
      settings: new SettingsStore(db),
      version: 'test', authMode: 'on', mcpUrl: 'http://127.0.0.1:7333',
    });
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => { server?.close(); rmSync(tmp, { recursive: true, force: true }); });

  it('reports no password and refuses to back up until one is set', async () => {
    const status = await (await call('GET', '/admin/api/backups')).json() as { password_set: boolean; host: string; backups: unknown[]; dir_source: string };
    assert.equal(status.password_set, false);
    assert.equal(status.host, 'testbox');
    assert.equal(status.dir_source, 'RITSU_BACKUP_DIR');
    assert.deepEqual(status.backups, []);
    const res = await call('POST', '/admin/api/backup');
    assert.equal(res.status, 409);
  });

  it('rejects a short password and accepts a long one', async () => {
    assert.equal((await call('PUT', '/admin/api/backups/password', { password: 'short' })).status, 400);
    assert.equal((await call('PUT', '/admin/api/backups/password', { password: GOOD })).status, 200);
    const status = await (await call('GET', '/admin/api/backups')).json() as { password_set: boolean };
    assert.equal(status.password_set, true);
  });

  it('backs up, lists, downloads, rehearses and deletes', async () => {
    const created = await call('POST', '/admin/api/backup');
    assert.equal(created.status, 201);
    const info = await created.json() as { name: string; kind: string; host: string };
    assert.equal(info.kind, 'daily');
    assert.equal(info.host, 'testbox');

    const status = await (await call('GET', '/admin/api/backups')).json() as { backups: Array<{ name: string }> };
    assert.deepEqual(status.backups.map(b => b.name), [info.name]);

    const dl = await call('GET', `/admin/api/backups/${encodeURIComponent(info.name)}`);
    assert.equal(dl.status, 200);
    assert.ok((await dl.arrayBuffer()).byteLength > 0);
    assert.equal((await call('GET', '/admin/api/backups/ritsu-x-20260101T000000Z.db.age')).status, 404);

    const rehearsed = await call('POST', '/admin/api/backups/rehearse', { name: info.name });
    assert.equal(rehearsed.status, 200);
    const report = await rehearsed.json() as { backup: string; tables: Array<{ name: string; before: number | null; after: number | null }> };
    assert.equal(report.backup, info.name);
    assert.ok(report.tables.some(t => t.name === 'agent_definitions' && t.before === t.after));
    const missing = await call('POST', '/admin/api/backups/rehearse', { name: 'ritsu-x-20260101T000000Z.db.age' });
    assert.equal(missing.status, 400);

    assert.equal((await call('DELETE', `/admin/api/backups/${encodeURIComponent(info.name)}`)).status, 204);
    assert.equal((await call('DELETE', `/admin/api/backups/${encodeURIComponent(info.name)}`)).status, 404);
  });
});

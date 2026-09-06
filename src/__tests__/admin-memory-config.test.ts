import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../db.js';
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
import { AgentHost } from '../agent-host.js';
import { SqliteChannelStore } from '../channels/channel-store.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { ChannelRegistry } from '../channels/registry.js';
import { BackupManager } from '../backup.js';
import { createAdminApp } from '../admin/server.js';
import { ProjectStore } from '../project-store.js';
import { SkillStore } from '../skill-store.js';
import { PromptStore } from '../prompt-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

describe('GET /admin/api/memory', () => {
  let server: Server | undefined;
  let base = '';
  let adminToken = '';
  let secrets: SecretStore;

  before(async () => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
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

    const app = createAdminApp({
    db,
      defStore, host, tokens, apiKeys, workspaces, pluginHost, memory, conversations,
      approvals, commsDenials, secrets, backup: new BackupManager(db, ':memory:'),
      channels: channelStore, channelRegistry: channels, jobs: new SqliteJobStore(db),
      oauth, projects: new ProjectStore(db), skills: new SkillStore(db), prompts: new PromptStore(db),
      version: 'test', authMode: 'on', mcpUrl: 'http://127.0.0.1:7333',
      memoryBoot: { mode: 'sqlite', remote: null },
    });
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  after(() => { server?.close(); });

  const get = async () => {
    const res = await fetch(`${base}/admin/api/memory`, { headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(res.status, 200);
    return res.json() as Promise<{
      boot: { mode: string; remote: string | null } | null;
      effective_next_boot: { mode: string; remote: string | null };
      stored: { url: string; token_set: boolean; mode: string; timeout_ms: string; proposal_poll_ms: string };
    }>;
  };

  it('requires auth', async () => {
    const res = await fetch(`${base}/admin/api/memory`);
    assert.equal(res.status, 401);
  });

  it('unconfigured: sqlite everywhere, token not set, no token material in body', async () => {
    const d = await get();
    assert.deepEqual(d.boot, { mode: 'sqlite', remote: null });
    assert.equal(d.effective_next_boot.mode, 'sqlite');
    assert.equal(d.stored.token_set, false);
  });

  it('url + token stored → next boot resolves to dual; token value never echoed', async () => {
    secrets.set('flashback', 'url', 'http://127.0.0.1:8080/');
    secrets.set('flashback', 'token', 'fb_secret_token_value');
    const d = await get();
    assert.equal(d.effective_next_boot.mode, 'dual');
    assert.equal(d.effective_next_boot.remote, 'http://127.0.0.1:8080');
    assert.equal(d.stored.url, 'http://127.0.0.1:8080/');
    assert.equal(d.stored.token_set, true);
    assert.ok(!JSON.stringify(d).includes('fb_secret_token_value'));
    assert.deepEqual(d.boot, { mode: 'sqlite', remote: null });  // boot snapshot unchanged until restart
  });

  it('stored mode wins over the dual default', async () => {
    secrets.set('flashback', 'mode', 'flashback');
    const d = await get();
    assert.equal(d.effective_next_boot.mode, 'flashback');
    assert.equal(d.stored.mode, 'flashback');
  });

  it('the claude-token endpoint stores a token and never returns it', async () => {
    // Over the endpoint's 20-character minimum, and assembled from parts so
    // it reads as a fixture rather than a live credential.
    const token = ['alpha', 'bravo', 'charlie', 'delta'].join('-');
    const post = await fetch(`${base}/admin/api/claude-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal(post.status, 200);

    const res = await fetch(`${base}/admin/api/claude-token`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = await res.text();
    assert.equal(res.status, 200);
    // The hint may show the ends; the whole value must never appear.
    assert.ok(!body.includes(token), 'response leaked the token');
    assert.match(body, /"token_set":true/);
  });

  it('the claude-token endpoint requires auth', async () => {
    const res = await fetch(`${base}/admin/api/claude-token`);
    assert.equal(res.status, 401);
  });

  it('clearing removes the stored token', async () => {
    const del = await fetch(`${base}/admin/api/claude-token`, {
      method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(del.status, 204);
    const res = await fetch(`${base}/admin/api/claude-token`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.match(await res.text(), /"token_set":false/);
  });
});

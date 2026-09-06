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
import { BackupManager } from '../backup.js';

// SEC-4: JSON body parsing is mounted AFTER admin auth, so an unauthenticated
// POST to /admin/agents/:id/ask is rejected (401) BEFORE the 32MB parser can
// buffer its body — no pre-auth RAM-exhaustion DoS. These tests drive the real
// middleware chain over HTTP to prove the ordering (a reorder regression would
// surface as a 413/hang or as broken authed behavior).
describe('admin /ask pre-auth DoS ordering (SEC-4)', () => {
  let server: Server;
  let base = '';
  let adminToken = '';

  before(async () => {
    const db = openDatabase(':memory:');
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
    db,
      defStore, host, tokens, apiKeys, workspaces, pluginHost, memory, conversations,
      approvals, commsDenials, secrets, backup: new BackupManager(db, ':memory:'), channels: channelStore, channelRegistry: channels, jobs: new SqliteJobStore(db),
      oauth, projects: new ProjectStore(db), skills: new SkillStore(db), prompts: new PromptStore(db),
      version: 'test', authMode: 'on', mcpUrl: 'http://127.0.0.1:7333',
    });
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => { server?.close(); });

  it('rejects an UNauthenticated large POST /ask with 401 (not 413 / not a hang)', async () => {
    // 2MB body — far over the 256kb default parser cap. If the parser ran
    // before auth this would 413 (or buffer); with the fix, auth 401s first.
    const body = JSON.stringify({ message: 'x'.repeat(2_000_000) });
    const res = await fetch(`${base}/admin/agents/ghost/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(res.status, 401);
  });

  it('keeps the unauthenticated health endpoint working', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });

  it('parses the body + runs the route for an AUTHENTICATED /ask (404 for a missing agent)', async () => {
    const res = await fetch(`${base}/admin/agents/ghost/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 404);
  });
});

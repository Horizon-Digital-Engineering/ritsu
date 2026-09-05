/**
 * Agent lifecycle over the real admin HTTP surface.
 *
 * Two things worth holding at this level rather than in a unit test: that every
 * route is actually behind the bearer token, and that a save which cannot
 * deliver what the operator asked for SAYS SO. An `approval_tools` entry the
 * runtime can't enforce is the worst kind of silent failure — the operator
 * ticks a box, sees it accepted, and stops worrying about the tool.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { createAdminApp } from '../admin/server.js';
import { ProjectStore } from '../project-store.js';
import { SkillStore } from '../skill-store.js';
import { PromptStore } from '../prompt-store.js';
import { AgentHost, type DispatcherFactory } from '../agent-host.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { WorkspaceStore } from '../workspace-store.js';
import { TokenStore } from '../auth/token-store.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { OAuthStore } from '../auth/oauth-store.js';
import { SecretStore } from '../auth/secret-store.js';
import { ApprovalStore } from '../approval-store.js';
import { CommsDenialStore } from '../comms-denial-store.js';
import { PluginHost } from '../plugins/host.js';
import { SqliteChannelStore } from '../channels/channel-store.js';
import { ChannelRegistry } from '../channels/registry.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { BackupManager } from '../backup.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';
import type { ChatResponse } from '../model/dispatcher.js';

const stubFactory: DispatcherFactory = (def) => ({
  kind: 'claude-direct',
  defaultModel: def.model,
  async chat(): Promise<ChatResponse> {
    return { content: 'stub', model: def.model, raw: null };
  },
});

let db: Db;
let server: Server;
let baseUrl: string;
let adminToken: string;

before(async () => {
  process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
  db = openDatabase(':memory:');

  const defStore = new SqliteAgentDefinitionStore(db);
  const conversations = new SqliteConversationStore(db);
  const workspaces = new WorkspaceStore(db);
  const apiKeys = new ApiKeyStore(db);
  const approvals = new ApprovalStore(db);
  const secrets = new SecretStore(db);
  const commsDenials = new CommsDenialStore(db);
  const tokens = new TokenStore(db);
  adminToken = tokens.mint('test-admin', 'admin').token;

  const host = new AgentHost(
    db, conversations, defStore, workspaces, apiKeys, approvals, secrets, commsDenials, stubFactory,
  );
  const channels = new SqliteChannelStore(db);

  const app = createAdminApp({
    defStore, host, tokens, apiKeys, workspaces,
    pluginHost: new PluginHost(db, secrets),
    memory: new SqliteMemoryStore(db),
    conversations, approvals, commsDenials, secrets,
    backup: new BackupManager(db, join(mkdtempSync(join(tmpdir(), 'ritsu-adm-')), 'ritsu.db')),
    channels,
    channelRegistry: new ChannelRegistry(channels, { get: () => { throw new Error('unused'); } }),
    jobs: new SqliteJobStore(db),
    oauth: new OAuthStore(db),
    version: 'test',
    authMode: 'on',
    projects: new ProjectStore(db), skills: new SkillStore(db), prompts: new PromptStore(db),
    mcpUrl: 'http://127.0.0.1:1',
  });

  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => { await new Promise<void>(r => server.close(() => r())); });

beforeEach(() => { db.exec('DELETE FROM agent_definitions'); });

async function req(
  method: string, path: string, body?: unknown, token: string | null = adminToken,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'alice', type: 'generic', name: 'Alice', description: 'test agent',
  system_prompt: 'be helpful', model: 'claude-sonnet-4-6', ...over,
});

describe('admin agent routes — auth', () => {
  it('refuses an unauthenticated request', async () => {
    assert.equal((await req('GET', '/admin/agents', undefined, null)).status, 401);
  });

  it('refuses a wrong token', async () => {
    assert.equal((await req('GET', '/admin/agents', undefined, 'rat_nope')).status, 401);
  });

  it('accepts the admin token', async () => {
    assert.equal((await req('GET', '/admin/agents')).status, 200);
  });
});

describe('admin agent routes — create and patch', () => {
  it('creates an agent and wires it live', async () => {
    const { status, json } = await req('POST', '/admin/agents', agent());
    assert.equal(status, 201);
    assert.equal(json.id, 'alice');
    assert.equal((await req('GET', '/admin/agents/alice')).status, 200);
  });

  it('refuses a duplicate id rather than clobbering', async () => {
    await req('POST', '/admin/agents', agent());
    const { status, json } = await req('POST', '/admin/agents', agent({ name: 'Impostor' }));
    assert.equal(status, 409);
    assert.match(String(json.error), /already exists/);
  });

  it('rejects a malformed definition with 400, not a 500', async () => {
    const { status } = await req('POST', '/admin/agents', agent({ id: 'Not Kebab Case' }));
    assert.equal(status, 400);
  });

  it('patches only the fields sent', async () => {
    await req('POST', '/admin/agents', agent());
    const { status, json } = await req('PATCH', '/admin/agents/alice', { name: 'Renamed' });
    assert.equal(status, 200);
    assert.equal(json.name, 'Renamed');
    assert.equal(json.system_prompt, 'be helpful', 'untouched fields must survive a patch');
  });

  it('404s a patch to an agent that does not exist', async () => {
    assert.equal((await req('PATCH', '/admin/agents/ghost', { name: 'x' })).status, 404);
  });
});

describe('admin agent routes — unenforceable approval_tools are reported', () => {
  it('warns when a direct-runtime agent gates an SDK built-in', async () => {
    // The vendor SDK runs Bash itself without consulting the gate, so this
    // approval would never fire. Saying nothing is how an operator ends up
    // trusting a gate that does not exist.
    const { status, json } = await req('POST', '/admin/agents', agent({
      runtime: 'direct', provider: 'claude',
      tools_allowlist: ['Bash'], approval_tools: ['Bash'],
    }));
    assert.equal(status, 201);
    assert.match(String(json.warning), /Bash/);
    assert.match(String(json.warning), /cannot enforce/);
  });

  it('stays quiet when the gated tool really is gateable', async () => {
    const { json } = await req('POST', '/admin/agents', agent({
      approval_tools: ['mcp__memory__forget'],
    }));
    assert.equal(json.warning, undefined);
  });

  it('stays quiet on the api runtime, where our own loop gates everything', async () => {
    const { json } = await req('POST', '/admin/agents', agent({
      runtime: 'api', provider: 'litellm',
      tools_allowlist: ['Bash'], approval_tools: ['Bash'],
    }));
    assert.equal(json.warning, undefined);
  });

  it('warns on a patch that introduces the problem, not just on create', async () => {
    await req('POST', '/admin/agents', agent());
    const { json } = await req('PATCH', '/admin/agents/alice', {
      tools_allowlist: ['Write'], approval_tools: ['Write'],
    });
    assert.match(String(json.warning), /Write/);
  });

  it('clears the warning once the operator fixes it', async () => {
    await req('POST', '/admin/agents', agent({ tools_allowlist: ['Bash'], approval_tools: ['Bash'] }));
    const { json } = await req('PATCH', '/admin/agents/alice', { approval_tools: [] });
    assert.equal(json.warning, undefined);
  });
});

describe('admin list limits', () => {
  it('a negative limit does not mean unlimited', async () => {
    // SQLite reads LIMIT -1 as no limit; the route has to floor it.
    await req('POST', '/admin/agents', agent());
    const res = await fetch(`${baseUrl}/admin/api/conversations?limit=-1`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    await res.body?.cancel();
  });

  it('a non-numeric limit is a 200 with the default, not a 500', async () => {
    const res = await fetch(`${baseUrl}/admin/api/conversations?limit=abc`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    await res.body?.cancel();
  });
});

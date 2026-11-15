import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
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
import { AgentHost, type DispatcherFactory } from '../agent-host.js';
import { SqliteChannelStore } from '../channels/channel-store.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { ChannelRegistry } from '../channels/registry.js';
import { createAdminApp } from '../admin/server.js';
import { ProjectStore } from '../project-store.js';
import { SkillStore } from '../skill-store.js';
import { PromptStore } from '../prompt-store.js';
import { SettingsStore } from '../settings-store.js';
import { BackupManager } from '../backup.js';
import { STOPPED_MARK } from '../agents/base.js';
import { TurnRecorder, type ChatRequest, type ChatResponse } from '../model/dispatcher.js';
import type { ConversationEvent } from '../conversation-bus.js';
import type { AgentDefinition } from '../admin/schema.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function untilStopped(req: ChatRequest): Promise<ChatResponse> {
  return new Promise(resolve => {
    const turn = new TurnRecorder(req.onEvent);
    turn.write('Thinking about it');
    turn.toolStart('t1', 'mcp__demo__slow', { n: 1 });
    const stop = (): void => {
      resolve({ content: turn.text, model: 'fake-model', raw: null, tool_calls: turn.finish('stopped'), stopped: true });
    };
    if (req.signal?.aborted) stop();
    else req.signal?.addEventListener('abort', stop, { once: true });
  });
}

const factory: DispatcherFactory = (def) => ({ kind: 'claude-direct', defaultModel: def.model, chat: untilStopped });

function agentDef(id: string): AgentDefinition {
  return {
    id, type: 'generic', name: id, description: 'test agent', system_prompt: 'be brief',
    runtime: 'direct', provider: 'claude', model: 'claude-sonnet-4-6', memory_backend: 'sqlite',
    tools_allowlist: [], can_call: [], api_key_ref: null, provider_options: {}, capabilities: [],
    approval_tools: [], plugins: [], enabled: true, escalation_approvable: false, allow_monitor_read: false,
  };
}

async function readFeed(res: Response, until: (e: ConversationEvent) => boolean): Promise<ConversationEvent[]> {
  if (!res.body) throw new Error('the feed has no body');
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const out: ConversationEvent[] = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    buf += decoder.decode(value, { stream: true });
    let cut = buf.indexOf('\n\n');
    while (cut >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      cut = buf.indexOf('\n\n');
      if (!frame.startsWith('data: ')) continue;
      const ev = JSON.parse(frame.slice(6)) as ConversationEvent;
      out.push(ev);
      if (until(ev)) return out;
    }
  }
}

describe('POST /admin/api/conversations/:cid/stop', () => {
  let server: Server;
  let base = '';
  let adminToken = '';
  let conversations: SqliteConversationStore;

  const call = (method: string, path: string, body?: unknown, token = adminToken, signal?: AbortSignal): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });

  before(async () => {
    process.env.RITSU_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
    _resetKeyCacheForTests();
    const db = openDatabase(':memory:');
    const memory = new SqliteMemoryStore(db);
    conversations = new SqliteConversationStore(db);
    const defStore = new SqliteAgentDefinitionStore(db);
    const tokens = new TokenStore(db);
    const apiKeys = new ApiKeyStore(db);
    const workspaces = new WorkspaceStore(db);
    const approvals = new ApprovalStore(db);
    const secrets = new SecretStore(db);
    const pluginHost = new PluginHost(db, secrets);
    const commsDenials = new CommsDenialStore(db);
    const host = new AgentHost(db, conversations, defStore, workspaces, apiKeys, approvals, secrets, commsDenials, factory);
    host.setPluginHost(pluginHost);
    await defStore.upsert(agentDef('alice'));
    await host.loadAll();
    const channelStore = new SqliteChannelStore(db);
    const channels = new ChannelRegistry(channelStore, { get: (id: string) => host.get(id) });
    adminToken = tokens.mint('test-admin', 'admin').token;
    const app = createAdminApp({
      db, defStore, host, tokens, apiKeys, workspaces, pluginHost, memory, conversations,
      approvals, commsDenials, secrets, channels: channelStore, channelRegistry: channels, jobs: new SqliteJobStore(db),
      backup: new BackupManager(db, ':memory:'), oauth: new OAuthStore(db), projects: new ProjectStore(db),
      skills: new SkillStore(db), prompts: new PromptStore(db), settings: new SettingsStore(db),
      version: 'test', authMode: 'on', mcpUrl: 'http://127.0.0.1:7333',
    });
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server?.closeAllConnections();
    server?.close();
  });

  it('rejects a bad id and needs the admin token', async () => {
    assert.equal((await call('POST', '/admin/api/conversations/abc/stop')).status, 400);
    assert.equal((await call('POST', '/admin/api/conversations/0/stop')).status, 400);
    assert.equal((await call('POST', '/admin/api/conversations/1.5/stop')).status, 400);
    assert.equal((await call('POST', '/admin/api/conversations/1/stop', undefined, 'not-a-real-token')).status, 401);
  });

  it('answers 0 when nothing is running', async () => {
    const res = await call('POST', '/admin/api/conversations/9999/stop');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stopped: 0 });
  });

  it('stops a running ask: the feed streams it, the ask answers with stopped, the partial reply is stored', async () => {
    const cid = conversations.findOrStartHumanThread('alice');
    const feedCtl = new AbortController();
    const feed = await call('GET', '/admin/api/conversations/stream', undefined, adminToken, feedCtl.signal);
    assert.equal(feed.status, 200);
    const events = readFeed(feed, e => e.kind === 'ask-end' && e.conversation_id === cid);

    const ask = call('POST', '/admin/agents/alice/ask', { message: 'take your time', conversation_id: cid });
    let n = 0;
    for (let i = 0; i < 200 && n === 0; i++) {
      await sleep(5);
      const msgs = conversations.recent(cid);
      if (msgs.length > 0) n = (await (await call('POST', `/admin/api/conversations/${cid}/stop`)).json() as { stopped: number }).stopped;
    }
    assert.equal(n, 1);
    const res = await ask;
    assert.equal(res.status, 200);
    const body = await res.json() as { reply: string; stopped?: boolean; conversation_id: number };
    assert.equal(body.stopped, true);
    assert.equal(body.conversation_id, cid);
    assert.equal(body.reply, `Thinking about it\n\n${STOPPED_MARK}`);

    const seen = (await events).filter(e => e.conversation_id === cid);
    feedCtl.abort();
    assert.deepEqual(seen.map(e => (e.kind === 'message' ? `message:${e.role}` : e.kind === 'tool' ? `tool:${e.call.status}` : e.kind)), [
      'message:user', 'ask-start', 'delta', 'tool:running', 'message:assistant', 'ask-end',
    ]);
    const delta = seen.find(e => e.kind === 'delta');
    assert.equal(delta?.kind === 'delta' ? delta.text : null, 'Thinking about it');

    const thread = await (await call('GET', `/admin/api/conversations/${cid}`)).json() as
      { messages: Array<{ role: string; content: string; tool_calls?: Array<{ status: string; result?: string }> }> };
    const last = thread.messages.at(-1);
    assert.equal(last?.content, `Thinking about it\n\n${STOPPED_MARK}`);
    assert.deepEqual(last?.tool_calls?.map(c => `${c.status}:${c.result}`), ['error:stopped']);
  });

  it('regenerate is stoppable and says so in its answer', async () => {
    const cid = conversations.findOrStartHumanThread('alice');
    const target = conversations.recent(cid).at(-1);
    assert.ok(target?.id);
    const regen = call('POST', `/admin/api/conversations/${cid}/regenerate`, { assistant_message_id: target.id });
    let n = 0;
    for (let i = 0; i < 200 && n === 0; i++) {
      await sleep(5);
      n = (await (await call('POST', `/admin/api/conversations/${cid}/stop`)).json() as { stopped: number }).stopped;
    }
    assert.equal(n, 1);
    const res = await regen;
    assert.equal(res.status, 200);
    const body = await res.json() as { content: string; stopped?: boolean };
    assert.equal(body.stopped, true);
    assert.equal(body.content, `Thinking about it\n\n${STOPPED_MARK}`);
  });
});

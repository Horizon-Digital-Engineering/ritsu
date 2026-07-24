import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { WorkspaceStore } from '../workspace-store.js';
import { AgentHost, type DispatcherFactory } from '../agent-host.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { ApprovalStore } from '../approval-store.js';
import { CommsDenialStore } from '../comms-denial-store.js';
import { SecretStore } from '../auth/secret-store.js';
import type { AgentDefinition } from '../admin/schema.js';
import type { ChatRequest, ChatResponse, ModelDispatcher } from '../model/dispatcher.js';
import { PluginHost } from '../plugins/host.js';
import { projectsPlugin } from '../plugins/projects/plugin.js';
import { MemoryService } from '../memory/service.js';
import { FakeMemoryBackend } from '../memory/fake-backend.js';

function sampleDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'alice',
    type: 'generic',
    name: 'Alice',
    description: 'a test agent',
    system_prompt: 'be brief',
    dispatcher: 'claude-direct',
    model: 'claude-sonnet-4-6',
    memory_backend: 'sqlite',
    tools_allowlist: [],
    can_call: [],
    provider: null,
    api_key_ref: null,
    provider_options: {},
    capabilities: [],
    approval_tools: [],
    plugins: [],
    enabled: true,
    escalation_approvable: false,
    allow_monitor_read: false,
    ...overrides,
  };
}

/** Records every dispatcher build + chat call for assertions. */
function makeStubFactory() {
  const builds: Array<{ def: AgentDefinition; opts: Record<string, unknown> }> = [];
  const chats: Array<{ agent: string; req: ChatRequest }> = [];
  const factory: DispatcherFactory = (def, opts) => {
    builds.push({ def, opts: opts as Record<string, unknown> });
    const dispatcher: ModelDispatcher = {
      kind: 'claude-direct',
      defaultModel: def.model,
      async chat(req: ChatRequest): Promise<ChatResponse> {
        chats.push({ agent: def.id, req });
        return { content: `stub reply for ${def.id}`, model: def.model, raw: null };
      },
    };
    return dispatcher;
  };
  return { factory, builds, chats };
}

describe('AgentHost', () => {
  let host: AgentHost;
  let defStore: SqliteAgentDefinitionStore;
  let workspaces: WorkspaceStore;
  let stub: ReturnType<typeof makeStubFactory>;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const convs = new SqliteConversationStore(db);
    defStore = new SqliteAgentDefinitionStore(db);
    workspaces = new WorkspaceStore(db);
    stub = makeStubFactory();
    // ApiKeyStore is a real instance — empty until a test exercises a
    // ritsu-agent. claude-direct paths don't touch it.
    const apiKeys = new ApiKeyStore(db);
    const approvals = new ApprovalStore(db);
    const secrets = new SecretStore(db);
    host = new AgentHost(db, convs, defStore, workspaces, apiKeys, approvals, secrets, new CommsDenialStore(db), stub.factory);
  });

  it('loadAll wires every enabled definition', async () => {
    await defStore.upsert(sampleDef({ id: 'a' }));
    await defStore.upsert(sampleDef({ id: 'b', enabled: false }));
    await host.loadAll();

    assert.deepEqual(host.list().map(a => a.id), ['a']);                  // b is disabled
    assert.throws(() => host.get('b'), /Unknown or disabled/);
  });

  it('addOrReplace with workspace sets cwd + tools + workspaces on the dispatcher', async () => {
    const def = await defStore.upsert(
      sampleDef({ tools_allowlist: ['Read', 'Bash'] }),
    );
    workspaces.upsert({ agent_id: def.id, path: '/tmp/sandbox', permissions: ['read'] });
    host.addOrReplace(def);

    assert.equal((stub.builds).length, 1);
    const { cwd, tools, workspaces: passedWs } = stub.builds[0].opts as {
      cwd?: string; tools?: string[]; workspaces?: Array<{ path: string; permissions: string[] }>;
    };
    assert.equal(cwd, '/tmp/sandbox');
    assert.deepEqual(tools, ['Read', 'Bash']);
    assert.equal(passedWs?.length, 1);
    assert.equal(passedWs?.[0].path, '/tmp/sandbox');
    assert.deepEqual(passedWs?.[0].permissions, ['read']);
  });

  it('disabling an agent removes it from the live map', async () => {
    const def = await defStore.upsert(sampleDef());
    host.addOrReplace(def);
    assert.equal((host.list()).length, 1);

    host.addOrReplace({ ...def, enabled: false });
    assert.equal((host.list()).length, 0);
    assert.throws(() => host.get(def.id));
  });

  it('agent.onMessage flows through the stub dispatcher and persists the turn', async () => {
    const def = await defStore.upsert(sampleDef());
    host.addOrReplace(def);

    const r = await host.get(def.id).onMessage({ message: 'hi' });
    assert.equal(r.reply, 'stub reply for alice');
    assert.equal(r.dispatcher_used, 'claude-direct');
    assert.equal((stub.chats).length, 1);

    // Conversation continuity: messages include the new user turn.
    const sent = stub.chats[0].req.messages;
    assert.equal(sent.some(m => m.role === 'user' && m.content === 'hi'), true);
    assert.equal(sent.some(m => m.role === 'system' && m.content === def.system_prompt), true);
  });

  it('onMessage threads pasted images into the current user turn as content blocks', async () => {
    const def = await defStore.upsert(sampleDef());
    host.addOrReplace(def);

    await host.get(def.id).onMessage({
      message: 'what is this?',
      attachments: [{ media_type: 'image/png', data: 'QUJD' }],
    });

    const sent = stub.chats[0].req.messages;
    const lastUser = sent[sent.length - 1];
    assert.equal(lastUser.role, 'user');
    assert.ok(Array.isArray(lastUser.content), 'image turn carries block content');
    const blocks = lastUser.content as Array<{ type: string; text?: string; media_type?: string; data?: string }>;
    assert.deepEqual(blocks[0], { type: 'text', text: 'what is this?' });
    assert.deepEqual(blocks[1], { type: 'image', media_type: 'image/png', data: 'QUJD' });
  });

  it('an image-only turn (no text) gets a placeholder prompt so the block is not empty', async () => {
    const def = await defStore.upsert(sampleDef());
    host.addOrReplace(def);

    await host.get(def.id).onMessage({
      message: '',
      attachments: [{ media_type: 'image/jpeg', data: 'WFla' }],
    });

    const sent = stub.chats[0].req.messages;
    const blocks = sent[sent.length - 1].content as Array<{ type: string; text?: string }>;
    assert.equal(blocks[0].type, 'text');
    assert.ok((blocks[0].text ?? '').length > 0, 'empty image-only turn gets a non-empty text block');
  });
});

describe('AgentHost — plugin allowlist wiring', () => {
  let host: AgentHost;
  let defStore: SqliteAgentDefinitionStore;
  let stub: ReturnType<typeof makeStubFactory>;
  let pluginHost: PluginHost;

  beforeEach(() => {
    const db = openDatabase(':memory:');
    const convs = new SqliteConversationStore(db);
    defStore = new SqliteAgentDefinitionStore(db);
    const workspaces = new WorkspaceStore(db);
    stub = makeStubFactory();
    host = new AgentHost(db, convs, defStore, workspaces, new ApiKeyStore(db), new ApprovalStore(db), new SecretStore(db), new CommsDenialStore(db), stub.factory);
    pluginHost = new PluginHost(db, new SecretStore(db));
    pluginHost.register(projectsPlugin);
    host.setPluginHost(pluginHost);
  });

  function pluginsOf(i: number): string[] {
    const opts = stub.builds[i].opts as { agentId?: string; plugins?: Array<{ namespace: string }> };
    return (opts.plugins ?? []).map(p => p.namespace);
  }

  it('wires allowlisted plugin providers + agentId into the dispatcher', async () => {
    const def = await defStore.upsert(sampleDef({ id: 'p1', plugins: ['projects'] }));
    host.addOrReplace(def);
    assert.equal((stub.builds[0].opts as { agentId?: string }).agentId, 'p1');
    assert.deepEqual(pluginsOf(0), ['projects']);
  });

  it('no allowlist entry → no plugin providers', async () => {
    const def = await defStore.upsert(sampleDef({ id: 'p2', plugins: [] }));
    host.addOrReplace(def);
    assert.deepEqual(pluginsOf(0), []);
  });

  it('disabled plugin makes the allowlist entry inert', async () => {
    pluginHost.setEnabled('projects', false);
    const def = await defStore.upsert(sampleDef({ id: 'p3', plugins: ['projects'] }));
    host.addOrReplace(def);
    assert.deepEqual(pluginsOf(0), []);
  });

  it('gates the plugin mutating tools (create/update) via approval_tools', async () => {
    const def = await defStore.upsert(sampleDef({ id: 'p4', plugins: ['projects'] }));
    host.addOrReplace(def);
    const opts = stub.builds[0].opts as { approval?: { gatedTools: string[] } };
    const gated = opts.approval?.gatedTools ?? [];
    assert.ok(gated.includes('mcp__projects__create_task'));
    assert.ok(gated.includes('mcp__projects__update_task'));
    assert.ok(!gated.includes('mcp__projects__list_projects'));
  });
});

describe('AgentHost — plugin gating hardening', () => {
  let host: AgentHost;
  let defStore: SqliteAgentDefinitionStore;
  let stub: ReturnType<typeof makeStubFactory>;
  let pluginHost: PluginHost;

  beforeEach(() => {
    const db = openDatabase(':memory:');
    const convs = new SqliteConversationStore(db);
    defStore = new SqliteAgentDefinitionStore(db);
    const workspaces = new WorkspaceStore(db);
    stub = makeStubFactory();
    host = new AgentHost(db, convs, defStore, workspaces, new ApiKeyStore(db), new ApprovalStore(db), new SecretStore(db), new CommsDenialStore(db), stub.factory);
    pluginHost = new PluginHost(db, new SecretStore(db));
    pluginHost.register(projectsPlugin);
    host.setPluginHost(pluginHost);
  });

  function gatedOf(i: number): string[] {
    return (stub.builds[i].opts as { approval?: { gatedTools: string[] } }).approval?.gatedTools ?? [];
  }

  it('normal agent gates only the plugin mutating tools (reads free)', async () => {
    host.addOrReplace(await defStore.upsert(sampleDef({ id: 'n', plugins: ['projects'] })));
    const g = gatedOf(0);
    assert.ok(g.includes('mcp__projects__create_task'));
    assert.ok(!g.includes('mcp__projects__list_projects'));
  });

  it('injection-exposed (crm) agent force-gates EVERY plugin tool, incl. reads', async () => {
    host.addOrReplace(await defStore.upsert(sampleDef({ id: 'c', capabilities: ['crm'], plugins: ['projects'] })));
    const g = gatedOf(0);
    assert.ok(g.includes('mcp__projects__list_projects'));
    assert.ok(g.includes('mcp__projects__list_tasks'));
    assert.ok(g.includes('mcp__projects__create_task'));
  });

  it('reloadForPlugin rebuilds only agents whose allowlist includes it', async () => {
    await defStore.upsert(sampleDef({ id: 'uses', plugins: ['projects'] }));
    await defStore.upsert(sampleDef({ id: 'nope', plugins: [] }));
    await host.loadAll();
    const before = stub.builds.length;
    await host.reloadForPlugin('projects');
    assert.deepEqual(stub.builds.slice(before).map(b => b.def.id), ['uses']);
  });
})

describe('AgentHost — flow-level memory wiring', () => {
  let host: AgentHost;
  let defStore: SqliteAgentDefinitionStore;
  let stub: ReturnType<typeof makeStubFactory>;

  function build(): { db: ReturnType<typeof openDatabase> } {
    const db = openDatabase(':memory:');
    const convs = new SqliteConversationStore(db);
    defStore = new SqliteAgentDefinitionStore(db);
    const workspaces = new WorkspaceStore(db);
    stub = makeStubFactory();
    host = new AgentHost(db, convs, defStore, workspaces, new ApiKeyStore(db), new ApprovalStore(db), new SecretStore(db), new CommsDenialStore(db), stub.factory);
    return { db };
  }

  it('default (no MemoryService): behavior unchanged — no retrieved-context block', async () => {
    build();
    host.addOrReplace(await defStore.upsert(sampleDef()));
    await host.get('alice').onMessage({ message: 'hello' });
    const sys = stub.chats[0].req.messages.filter(m => m.role === 'system').map(m => m.content);
    assert.ok(!sys.some(c => typeof c === 'string' && c.startsWith('Relevant context retrieved')),
      'no flow-level context block when no MemoryService is wired');
  });

  it('with a MemoryService: records the turn AND injects retrieved context on the next turn', async () => {
    build();
    const svc = new MemoryService({ mode: 'sqlite', sqlite: new FakeMemoryBackend() });
    host.setMemoryService(svc);
    host.addOrReplace(await defStore.upsert(sampleDef()));

    // First turn seeds the memory with the (distinctive) user + assistant text.
    await host.get('alice').onMessage({ message: 'remember zephyrantine dosage' });

    // Second turn's getContext should retrieve the seeded record and inject it.
    await host.get('alice').onMessage({ message: 'what about zephyrantine' });
    const sys = stub.chats[1].req.messages
      .filter(m => m.role === 'system')
      .map(m => (typeof m.content === 'string' ? m.content : ''));
    const ctxBlock = sys.find(c => c.startsWith('Relevant context retrieved'));
    assert.ok(ctxBlock, 'the retrieved-context block is present on turn 2');
    assert.match(ctxBlock, /zephyrantine/);
  });

  it('a MemoryService in sqlite mode never blocks the turn (record + getContext both local)', async () => {
    build();
    const svc = new MemoryService({ mode: 'sqlite', sqlite: new FakeMemoryBackend() });
    host.setMemoryService(svc);
    host.addOrReplace(await defStore.upsert(sampleDef()));
    const r = await host.get('alice').onMessage({ message: 'hi' });
    assert.equal(r.reply, 'stub reply for alice'); // turn completes normally
  });
});

describe('AgentHost — conversation ownership', () => {
  let host: AgentHost;
  let defStore: SqliteAgentDefinitionStore;
  let stub: ReturnType<typeof makeStubFactory>;

  beforeEach(() => {
    const db = openDatabase(':memory:');
    const convs = new SqliteConversationStore(db);
    defStore = new SqliteAgentDefinitionStore(db);
    const workspaces = new WorkspaceStore(db);
    stub = makeStubFactory();
    host = new AgentHost(db, convs, defStore, workspaces, new ApiKeyStore(db), new ApprovalStore(db), new SecretStore(db), new CommsDenialStore(db), stub.factory);
  });

  it('ignores a conversation_id that belongs to another agent (no cross-agent read)', async () => {
    host.addOrReplace(await defStore.upsert(sampleDef({ id: 'a' })));
    host.addOrReplace(await defStore.upsert(sampleDef({ id: 'b' })));
    const aResp = await host.get('a').onMessage({ message: 'SECRET-A-ONLY' });
    const aConv = aResp.conversation_id;
    await host.get('b').onMessage({ message: 'hi', conversation_id: aConv });
    const bMsgs = stub.chats[stub.chats.length - 1].req.messages;
    assert.ok(!bMsgs.some(m => m.content === 'SECRET-A-ONLY'), "B must not load A's transcript");
  });
})

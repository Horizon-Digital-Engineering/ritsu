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
    enabled: true,
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

  beforeEach(() => {
    const db = openDatabase(':memory:');
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

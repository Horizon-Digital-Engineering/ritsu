import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { SqliteMemoryStore } from '../memory-store.js';
import {
  buildAgentAdminTools,
  buildAgentMonitorTools,
  buildBuiltinTools,
  type RaToolDeps,
} from '../tools/ritsu-agent/builtin.js';
import type { AgentDefinition } from '../admin/schema.js';

function def(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'a',
    type: 'generic',
    name: 'A',
    description: 'a',
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
    ...overrides,
  };
}

describe('capabilities round-trip', () => {
  it('persists an empty list by default', async () => {
    const store = new SqliteAgentDefinitionStore(openDatabase(':memory:'));
    const saved = await store.upsert(def({ id: 'plain' }));
    assert.deepEqual(saved.capabilities, []);
  });

  it('persists and reads back manage_agents + monitor_agents', async () => {
    const store = new SqliteAgentDefinitionStore(openDatabase(':memory:'));
    const saved = await store.upsert(def({
      id: 'ops',
      capabilities: ['manage_agents', 'monitor_agents'],
    }));
    assert.deepEqual(saved.capabilities.sort(), ['manage_agents', 'monitor_agents']);
    const reread = await store.read('ops');
    assert.deepEqual(reread?.capabilities.sort(), ['manage_agents', 'monitor_agents']);
  });

  it('rejects an unknown capability via schema validation', async () => {
    const store = new SqliteAgentDefinitionStore(openDatabase(':memory:'));
    await assert.rejects(store.upsert(def({
      id: 'bad',
      // Intentionally pass a value outside the declared union to assert
      // schema validation rejects unknown capabilities at runtime.
      capabilities: ['delete_universe'] as unknown as ('manage_agents' | 'monitor_agents')[],
    })));
  });
});

describe('ritsu-agent capability tool gating', () => {
  let toolDeps: RaToolDeps;
  let defStore: SqliteAgentDefinitionStore;
  let conversations: SqliteConversationStore;
  let memory: SqliteMemoryStore;

  beforeEach(async () => {
    const db = openDatabase(':memory:');
    defStore = new SqliteAgentDefinitionStore(db);
    conversations = new SqliteConversationStore(db);
    memory = new SqliteMemoryStore(db);
    // Seed two agents so monitor tools have something to look at.
    await defStore.upsert(def({ id: 'alpha', name: 'Alpha', description: 'alpha-desc' }));
    await defStore.upsert(def({ id: 'beta', name: 'Beta', description: 'beta-desc' }));
    await memory.write({ agent_id: 'beta', content: 'beta knows X' });
    const conv = conversations.findOrStartHumanThread('beta');
    conversations.append(conv, 'user', 'hello beta', 'admin-ui');
    conversations.append(conv, 'assistant', 'hi human', null);

    toolDeps = {
      agentId: 'ops',
      memory,
      defStore,
      conversations,
      host: { get: () => { throw new Error('no agents wired'); } },
      capabilities: [],
      adminHost: { addOrReplace: () => {} },
    };
  });

  it('buildBuiltinTools excludes admin tools when capability missing', () => {
    const tools = buildBuiltinTools({ ...toolDeps, capabilities: [] });
    const names = tools.map(t => t.name);
    assert.ok(!(names).includes('agent_admin_create_agent'));
    assert.ok(!(names).includes('agent_monitor_list_agents'));
  });

  it('buildBuiltinTools includes admin tools when manage_agents set', () => {
    const tools = buildBuiltinTools({ ...toolDeps, capabilities: ['manage_agents'] });
    const names = tools.map(t => t.name);
    assert.ok((names).includes('agent_admin_create_agent'));
    assert.ok((names).includes('agent_admin_update_agent'));
    assert.ok((names).includes('agent_admin_reload_agent'));
    assert.ok(!(names).includes('agent_monitor_list_agents'));
  });

  it('buildBuiltinTools includes monitor tools when monitor_agents set', () => {
    const tools = buildBuiltinTools({ ...toolDeps, capabilities: ['monitor_agents'] });
    const names = tools.map(t => t.name);
    assert.ok((names).includes('agent_monitor_list_agents'));
    assert.ok((names).includes('agent_monitor_list_conversations'));
    assert.ok((names).includes('agent_monitor_read_conversation'));
    assert.ok((names).includes('agent_monitor_read_memory'));
    assert.ok(!(names).includes('agent_admin_create_agent'));
  });

  it('agent_admin_create_agent mints a new agent and rejects duplicates', async () => {
    let lastReloaded: string | null = null;
    const tools = buildAgentAdminTools({
      ...toolDeps,
      adminHost: { addOrReplace: (d) => { lastReloaded = d.id; } },
    });
    const create = tools.find(t => t.name === 'agent_admin_create_agent')!;
    const ok = await create.handler({
      id: 'gamma',
      name: 'Gamma',
      description: 'gamma-desc',
      system_prompt: 'be gamma',
      dispatcher: 'claude-direct',
      model: 'claude-sonnet-4-6',
    });
    assert.ok((ok).includes('created gamma'));
    assert.equal(lastReloaded, 'gamma');
    const dup = await create.handler({
      id: 'gamma',
      name: 'Gamma',
      description: 'gamma-desc',
      system_prompt: 'be gamma',
      dispatcher: 'claude-direct',
      model: 'claude-sonnet-4-6',
    });
    assert.match(String(dup), /already exists/);
  });

  it('agent_monitor_list_agents returns the full registered swarm', async () => {
    const tools = buildAgentMonitorTools(toolDeps);
    const list = tools.find(t => t.name === 'agent_monitor_list_agents')!;
    const out = String(await list.handler({}));
    assert.ok((out).includes('[alpha]'));
    assert.ok((out).includes('[beta]'));
  });

  it('agent_monitor_read_memory reads another agent\'s memories', async () => {
    const tools = buildAgentMonitorTools(toolDeps);
    const read = tools.find(t => t.name === 'agent_monitor_read_memory')!;
    const out = String(await read.handler({ agent_id: 'beta' }));
    assert.ok((out).includes('beta knows X'));
  });

  it('agent_monitor_read_conversation returns transcript with caller labels', async () => {
    const tools = buildAgentMonitorTools(toolDeps);
    const list = tools.find(t => t.name === 'agent_monitor_list_conversations')!;
    const listOut = String(await list.handler({ agent_id: 'beta' }));
    const match = listOut.match(/^\[(\d+)\]/);
    assert.notEqual(match, null);
    const convId = Number(match![1]);
    const read = tools.find(t => t.name === 'agent_monitor_read_conversation')!;
    const out = String(await read.handler({ conversation_id: convId }));
    assert.ok((out).includes('[admin-ui] hello beta'));
    assert.ok((out).includes('[assistant] hi human'));
  });
});

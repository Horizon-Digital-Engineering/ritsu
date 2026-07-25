import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import type { AgentDefinitionStore } from '../agent-definition-store.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { AgentDefinitionSchema } from '../admin/schema.js';
import { monitorReadAllowed } from '../tools/mcp-internal/agent-monitor.js';
import { buildAgentMonitorTools, type RaToolDeps } from '../tools/ritsu-agent/builtin.js';

// SEC-2: a `monitor_agents`-capable agent must NOT read another agent's
// conversations/memory unless that target set allow_monitor_read. Default-deny.
describe('monitorReadAllowed (SEC-2 default-deny predicate)', () => {
  const store = (map: Record<string, { allow_monitor_read: boolean }>): AgentDefinitionStore =>
    ({ read: async (id: string) => map[id] ?? null } as unknown as AgentDefinitionStore);

  it('denies a target that has not opted in', async () => {
    assert.equal(await monitorReadAllowed(store({ y: { allow_monitor_read: false } }), 'x', 'y'), false);
  });
  it('allows a target that opted in', async () => {
    assert.equal(await monitorReadAllowed(store({ y: { allow_monitor_read: true } }), 'x', 'y'), true);
  });
  it('always allows an agent reading its OWN data', async () => {
    assert.equal(await monitorReadAllowed(store({}), 'x', 'x'), true);
  });
  it('denies a missing target', async () => {
    assert.equal(await monitorReadAllowed(store({}), 'x', 'ghost'), false);
  });
});

describe('ritsu-agent monitor tools honor allow_monitor_read', () => {
  let defStore: SqliteAgentDefinitionStore;
  let memory: SqliteMemoryStore;
  let conversations: SqliteConversationStore;

  beforeEach(async () => {
    const db = openDatabase(':memory:');
    defStore = new SqliteAgentDefinitionStore(db);
    memory = new SqliteMemoryStore(db);
    conversations = new SqliteConversationStore(db);
    const mk = (id: string, allow: boolean) => defStore.upsert(AgentDefinitionSchema.parse({
      id, type: 'generic', name: id, description: 'x', system_prompt: 'x',
      runtime: 'direct', model: 'claude-sonnet-4-6', allow_monitor_read: allow,
    }));
    await mk('opaque-agent', false);
    await mk('open-agent', true);
    await memory.write({ agent_id: 'opaque-agent', content: 'OPAQUE-SECRET' });
    await memory.write({ agent_id: 'open-agent', content: 'OPEN-SHARED' });
  });

  const readMemory = () =>
    buildAgentMonitorTools({ agentId: 'watcher', defStore, conversations, memory } as unknown as RaToolDeps)
      .find(t => t.name === 'agent_monitor_read_memory')!;

  it('denies read_memory (and never leaks content) for a non-opted-in agent', async () => {
    const out = await readMemory().handler({ agent_id: 'opaque-agent' });
    assert.match(out, /has not opted into monitor reads/);
    assert.doesNotMatch(out, /OPAQUE-SECRET/);
  });

  it('allows read_memory for an opted-in agent', async () => {
    const out = await readMemory().handler({ agent_id: 'open-agent' });
    assert.match(out, /OPEN-SHARED/);
  });
});

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteAgentDefinitionStore, seedIfEmpty } from '../agent-definition-store.js';
import type { AgentDefinition } from '../admin/schema.js';

function sampleDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'sample',
    type: 'generic',
    name: 'Sample',
    description: 'a sample agent',
    system_prompt: 'be helpful',
    dispatcher: 'claude-direct',
    model: 'claude-sonnet-4-6',
    memory_backend: 'sqlite',
    tools_allowlist: [],
    can_call: [],
    provider: null,
    api_key_ref: null,
    provider_options: {},
    capabilities: [],
    enabled: true,
    ...overrides,
  };
}

describe('SqliteAgentDefinitionStore — bidirectional can_call sync', () => {
  let store: SqliteAgentDefinitionStore;
  beforeEach(() => { store = new SqliteAgentDefinitionStore(openDatabase(':memory:')); });

  it('mirrors an added edge onto the sister agent', async () => {
    await store.upsert(sampleDef({ id: 'alpha' }));
    await store.upsert(sampleDef({ id: 'beta' }));
    await store.upsert(sampleDef({ id: 'alpha', can_call: ['beta'] }));
    const beta = await store.read('beta');
    assert.deepEqual(beta?.can_call, ['alpha']);
  });

  it('mirrors a removed edge off the sister agent', async () => {
    await store.upsert(sampleDef({ id: 'alpha' }));
    await store.upsert(sampleDef({ id: 'beta' }));
    await store.upsert(sampleDef({ id: 'alpha', can_call: ['beta'] }));
    await store.upsert(sampleDef({ id: 'alpha', can_call: [] }));
    const beta = await store.read('beta');
    assert.deepEqual(beta?.can_call, []);
  });

  it('handles multiple edges in one upsert (add some, remove some)', async () => {
    await store.upsert(sampleDef({ id: 'a' }));
    await store.upsert(sampleDef({ id: 'b' }));
    await store.upsert(sampleDef({ id: 'c' }));
    await store.upsert(sampleDef({ id: 'a', can_call: ['b'] }));
    await store.upsert(sampleDef({ id: 'a', can_call: ['c'] }));   // remove b, add c
    const b = await store.read('b'); const c = await store.read('c');
    assert.deepEqual(b?.can_call, []);
    assert.deepEqual(c?.can_call, ['a']);
  });

  it('tolerates dangling ids (referenced agent does not exist)', async () => {
    await store.upsert(sampleDef({ id: 'alpha' }));
    // Should not throw — the missing 'ghost' row is silently skipped on sync.
    await assert.doesNotReject(
      store.upsert(sampleDef({ id: 'alpha', can_call: ['ghost'] })),
    );
    const alpha = await store.read('alpha');
    assert.deepEqual(alpha?.can_call, ['ghost']);
  });

  it('does not duplicate when sister already has the back-edge', async () => {
    await store.upsert(sampleDef({ id: 'alpha' }));
    await store.upsert(sampleDef({ id: 'beta', can_call: ['alpha'] }));  // beta first edges alpha
    await store.upsert(sampleDef({ id: 'alpha', can_call: ['beta'] }));  // alpha edges beta back
    const beta = await store.read('beta');
    assert.deepEqual(beta?.can_call, ['alpha']);  // not ['alpha', 'alpha']
  });
});

describe('SqliteAgentDefinitionStore', () => {
  let store: SqliteAgentDefinitionStore;

  beforeEach(() => {
    store = new SqliteAgentDefinitionStore(openDatabase(':memory:'));
  });

  it('upsert round-trips a definition', async () => {
    const saved = await store.upsert(sampleDef());
    assert.equal(saved.id, 'sample');
    assert.equal(typeof (saved.created_at), 'number');
    assert.equal(typeof (saved.updated_at), 'number');

    const read = await store.read('sample');
    assert.deepEqual(read, saved);
  });

  it('upsert is idempotent + bumps updated_at on change', async () => {
    const first = await store.upsert(sampleDef());
    await new Promise(r => setTimeout(r, 1100)); // strftime('%s') is whole seconds
    const second = await store.upsert(sampleDef({ name: 'Renamed' }));
    assert.equal(second.id, first.id);
    assert.equal(second.name, 'Renamed');
    assert.ok((second.updated_at ?? 0) > (first.updated_at ?? 0));
  });

  it('list returns by id ASC', async () => {
    await store.upsert(sampleDef({ id: 'zeta' }));
    await store.upsert(sampleDef({ id: 'alpha' }));
    const ids = (await store.list()).map(d => d.id);
    assert.deepEqual(ids, ['alpha', 'zeta']);
  });

  it('delete removes the row', async () => {
    await store.upsert(sampleDef());
    assert.equal(await store.delete('sample'), true);
    assert.equal(await store.read('sample'), null);
    assert.equal(await store.delete('sample'), false); // already gone
  });

  it('tools_allowlist + memory_backend round-trip', async () => {
    const saved = await store.upsert(
      sampleDef({ tools_allowlist: ['Read', 'Bash'], memory_backend: 'sqlite' }),
    );
    assert.deepEqual(saved.tools_allowlist, ['Read', 'Bash']);
    assert.equal(saved.memory_backend, 'sqlite');
  });

  it('seedIfEmpty seeds exactly once', async () => {
    assert.equal((await store.list()).length, 0);
    await seedIfEmpty(store);
    assert.deepEqual((await store.list()).map(d => d.id), ['hello-world']);
    await seedIfEmpty(store);   // no-op on second call
    assert.deepEqual((await store.list()).map(d => d.id), ['hello-world']);
  });

  it('rejects malformed id at validation', async () => {
    await assert.rejects(store.upsert(sampleDef({ id: 'NOT KEBAB' })));
  });

  it('upsert snapshots previous_system_prompt when the prompt changes', async () => {
    const v1 = await store.upsert(sampleDef({ system_prompt: 'v1 prompt' }));
    assert.equal(v1.previous_system_prompt, null);

    const v2 = await store.upsert(sampleDef({ system_prompt: 'v2 prompt' }));
    assert.equal(v2.system_prompt, 'v2 prompt');
    assert.equal(v2.previous_system_prompt, 'v1 prompt');
    assert.equal(typeof (v2.previous_saved_at), 'number');
  });

  it('upsert leaves previous untouched when the prompt is unchanged', async () => {
    await store.upsert(sampleDef({ system_prompt: 'p1' }));
    await store.upsert(sampleDef({ system_prompt: 'p2' }));
    const beforeRename = await store.read('sample');
    assert.equal(beforeRename?.previous_system_prompt, 'p1');

    await store.upsert(sampleDef({ system_prompt: 'p2', name: 'Renamed' }));
    const afterRename = await store.read('sample');
    assert.equal(afterRename?.previous_system_prompt, 'p1');  // unchanged
    assert.equal(afterRename?.name, 'Renamed');
  });

  it('revert swaps current and previous; throws if no previous', async () => {
    await assert.rejects(store.revert('missing'), /not found/);
    const created = await store.upsert(sampleDef({ system_prompt: 'good' }));
    await assert.rejects(store.revert(created.id), /no previous/);

    await store.upsert(sampleDef({ system_prompt: 'bad' }));
    const reverted = await store.revert('sample');
    assert.equal(reverted.system_prompt, 'good');
    assert.equal(reverted.previous_system_prompt, 'bad');   // ping-pong target
  });
});

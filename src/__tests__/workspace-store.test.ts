import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { WorkspaceStore } from '../workspace-store.js';

describe('WorkspaceStore', () => {
  let store: WorkspaceStore;

  beforeEach(() => {
    store = new WorkspaceStore(openDatabase(':memory:'));
  });

  it('upsert + listFor preserves insertion order (id ASC)', () => {
    store.upsert({ agent_id: 'alice', path: '/first', permissions: ['read'] });
    store.upsert({ agent_id: 'alice', path: '/second', permissions: ['read', 'write'] });
    const list = store.listFor('alice');
    assert.deepEqual(list.map(w => w.path), ['/first', '/second']);
    assert.deepEqual(list[1].permissions.sort(), ['read', 'write']);
  });

  it('upsert on (agent_id, path) replaces permissions in place', () => {
    const a = store.upsert({ agent_id: 'alice', path: '/x', permissions: ['read'] });
    const b = store.upsert({ agent_id: 'alice', path: '/x', permissions: ['read', 'write', 'exec'] });
    assert.equal(b.id, a.id);                              // same row
    assert.deepEqual(b.permissions.sort(), ['exec', 'read', 'write']);
    assert.equal((store.listFor('alice')).length, 1);
  });

  it('isolates workspaces per agent', () => {
    store.upsert({ agent_id: 'alice', path: '/a', permissions: ['read'] });
    store.upsert({ agent_id: 'bob', path: '/b', permissions: ['read'] });
    assert.equal((store.listFor('alice')).length, 1);
    assert.equal((store.listFor('bob')).length, 1);
  });

  it('deduplicates permissions on write', () => {
    const w = store.upsert({
      agent_id: 'alice',
      path: '/p',
      permissions: ['read', 'read', 'write', 'read'],
    });
    assert.deepEqual(w.permissions.sort(), ['read', 'write']);
  });

  it('delete removes by id', () => {
    const w = store.upsert({ agent_id: 'alice', path: '/p', permissions: ['read'] });
    assert.equal(store.delete(w.id), true);
    assert.equal(store.delete(w.id), false);
    assert.equal((store.listFor('alice')).length, 0);
  });
});

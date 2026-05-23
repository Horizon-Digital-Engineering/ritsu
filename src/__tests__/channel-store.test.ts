import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { SqliteChannelStore } from '../channels/channel-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

describe('SqliteChannelStore', () => {
  let store: SqliteChannelStore;

  beforeEach(() => {
    // Pin an in-memory master key so encryptSecret doesn't try to mkdir
    // /opt/ritsu/data on a contributor's box that doesn't own that path.
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    store = new SqliteChannelStore(openDatabase(':memory:'));
  });

  it('create returns the row with parsed config + defaults enabled=true', () => {
    const row = store.create({
      name: 'main',
      kind: 'telegram',
      operator_agent_id: 'agent-one',
      config: { bot_token: '123:abc', chat_id: 42 },
    });
    assert.equal(row.name, 'main');
    assert.equal(row.kind, 'telegram');
    assert.equal(row.enabled, true);
    assert.equal((row.config as { bot_token: string }).bot_token, '123:abc');
    assert.equal((row.config as { chat_id: number }).chat_id, 42);
  });

  it('list returns all rows in id order; listEnabled filters', () => {
    store.create({ name: 'a', kind: 'telegram', operator_agent_id: 'x', config: { bot_token: 'tA', chat_id: null } });
    store.create({ name: 'b', kind: 'telegram', operator_agent_id: 'x', config: { bot_token: 'tB', chat_id: null }, enabled: false });
    store.create({ name: 'c', kind: 'telegram', operator_agent_id: 'x', config: { bot_token: 'tC', chat_id: null } });
    assert.deepEqual(store.list().map(r => r.name), ['a', 'b', 'c']);
    assert.deepEqual(store.listEnabled().map(r => r.name), ['a', 'c']);
  });

  it('update applies a partial patch and rewrites config when provided', () => {
    const r = store.create({ name: 'main', kind: 'telegram', operator_agent_id: 'agent-a', config: { bot_token: 't', chat_id: null } });
    const after = store.update(r.id, { operator_agent_id: 'agent-b', config: { bot_token: 't', allowed_chat_ids: [99] } });
    assert.equal(after.operator_agent_id, 'agent-b');
    assert.deepEqual((after.config as { allowed_chat_ids: number[] }).allowed_chat_ids, [99]);
  });

  it('setEnabled toggles + delete removes', () => {
    const r = store.create({ name: 'main', kind: 'telegram', operator_agent_id: 'x', config: { bot_token: 't', chat_id: null } });
    assert.equal(store.setEnabled(r.id, false).enabled, false);
    assert.equal(store.setEnabled(r.id, true).enabled, true);
    assert.equal(store.delete(r.id), true);
    assert.equal(store.read(r.id), null);
  });

  it('UNIQUE(name) prevents two channels sharing a name', () => {
    store.create({ name: 'main', kind: 'telegram', operator_agent_id: 'x', config: { bot_token: 't', chat_id: null } });
    assert.throws(() => store.create({ name: 'main', kind: 'telegram', operator_agent_id: 'y', config: { bot_token: 'u', chat_id: null } }));
  });

  it('readByName finds the row + returns null for unknown', () => {
    store.create({ name: 'main', kind: 'telegram', operator_agent_id: 'x', config: { bot_token: 't', chat_id: null } });
    assert.equal(store.readByName('main')?.name, 'main');
    assert.equal(store.readByName('ghost'), null);
  });
});

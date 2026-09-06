/**
 * The stage → migrate → merge pipeline for bringing an OLD install's JSON
 * export into a live database. The fixture below is a faithful old-era
 * export: `dispatcher` agents, `session_id` memory records, flat chats with
 * no tree, a credential table, and a plugin table the live side lacks.
 * What matters most is what must NOT happen: credentials never move, live
 * rows never get clobbered, and a dry run writes nothing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { SqliteMemoryBackend } from '../memory/sqlite-backend.js';
import { mergeExportIntoLive, type MergeReport } from '../merge-import.js';
import type { ExportFile } from '../backup.js';

function oldExport(): ExportFile {
  return {
    // Old exports predate the format stamp; the merge path must not care.
    format: undefined as never,
    exported_at: 1717000000,
    tables: {
      agent_definitions: [{
        id: 'hde-manager', type: 'generic', name: 'hde-manager', description: 'runs things',
        system_prompt: 'be useful', dispatcher: 'claude-direct', model: 'claude-3-5-sonnet',
        memory_backend: 'sqlite', tools_allowlist: '["Read"]', enabled: 1,
        created_at: 1716000000, updated_at: 1716000001,
        previous_system_prompt: null, previous_saved_at: null,
      }, {
        id: 'dup', type: 'generic', name: 'old dup', description: 'old copy',
        system_prompt: 'old prompt', dispatcher: 'claude-direct', model: 'm',
        memory_backend: 'sqlite', tools_allowlist: '[]', enabled: 1,
        created_at: 1, updated_at: 1, previous_system_prompt: null, previous_saved_at: null,
      }],
      agent_workspaces: [
        { id: 1, agent_id: 'hde-manager', path: '/srv/old-root', permissions: 'read', created_at: 1 },
      ],
      memories: [
        { id: 1, agent_id: 'hde-manager', content: 'superseded fact', embedding: null, created_at: 1, superseded_by: 2, lineage_root_id: 0 },
        { id: 2, agent_id: 'hde-manager', content: 'current fact', embedding: null, created_at: 2, superseded_by: null, lineage_root_id: 1 },
      ],
      conversations: [
        { id: 1, agent_id: 'hde-manager', started_at: 10, ended_at: null },
      ],
      messages: [
        { id: 1, conversation_id: 1, role: 'user', content: 'hello from the past', created_at: 11 },
        { id: 2, conversation_id: 1, role: 'assistant', content: 'past reply', created_at: 12 },
      ],
      message_attachments: [
        { id: 1, message_id: 1, conversation_id: 1, media_type: 'image/png', data: 'aGVsbG8=', created_at: 11 },
      ],
      raw_records: [{
        id: 'uuid-old-1', type: 'note', content: 'old memory record',
        content_hash: 'md5-abcdef', event_time: 5, ingest_time: 5,
        source: 'chat', source_ref: null, user_id: 'u', project_id: null,
        session_id: 'sess-9', acl: null, ttl: null, payload: null,
      }],
      // Credentials — must never merge.
      mcp_tokens: [
        { id: 1, name: 'old-admin', token_hash: 'deadbeef', token_prefix: 'rt_', scope: 'admin', created_at: 1, last_used_at: null, use_count: 0, revoked_at: null },
      ],
      // A plugin table the live install does not have.
      plugin_projects_tasks: [
        { id: 1, title: 'old task', done: 0 },
      ],
    },
  };
}

describe('merge-import: stage → migrate → merge', () => {
  let tmp: string;
  let livePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ritsu-merge-'));
    livePath = join(tmp, 'live.db');
    const live = openDatabase(livePath);
    new SqliteMemoryBackend(live);
    // Live state that must survive untouched: a token, an agent, a chat.
    live.prepare("INSERT INTO mcp_tokens (name, token_hash, token_prefix, scope) VALUES ('live-admin','livehash','rt_','admin')").run();
    live.prepare(`INSERT INTO agent_definitions (id, type, name, description, system_prompt, runtime, provider, model)
                  VALUES ('dup', 'generic', 'live dup', 'fresh copy', 'live prompt', 'direct', 'claude', 'm')`).run();
    live.prepare("INSERT INTO conversations (id, agent_id) VALUES (1, 'dup')").run();
    live.prepare("INSERT INTO messages (id, conversation_id, role, content) VALUES (1, 1, 'user', 'live message')").run();
    live.close();
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  function merge(opts = {}): MergeReport {
    return mergeExportIntoLive(oldExport(), livePath, join(tmp, 'stage.db'), opts);
  }

  it('upgrades dispatcher-era agents and merges them without touching collisions', () => {
    const report = merge();
    const live = openDatabase(livePath);
    const hde = live.prepare("SELECT runtime, provider, model FROM agent_definitions WHERE id = 'hde-manager'").get() as
      { runtime: string; provider: string; model: string };
    assert.equal(hde.runtime, 'direct', 'legacy dispatcher row came through the real migration');
    assert.equal(hde.provider, 'claude');
    const dup = live.prepare("SELECT name FROM agent_definitions WHERE id = 'dup'").get() as { name: string };
    assert.equal(dup.name, 'live dup', 'colliding agent keeps the LIVE definition by default');
    assert.deepEqual(report.skippedAgents, ['dup']);
  });

  it('replaces a colliding definition only when asked', () => {
    merge({ replaceAgents: ['dup'] });
    const live = openDatabase(livePath);
    const dup = live.prepare("SELECT name FROM agent_definitions WHERE id = 'dup'").get() as { name: string };
    assert.equal(dup.name, 'old dup');
  });

  it('remaps conversation/message/attachment ids so nothing collides', () => {
    merge();
    const live = openDatabase(livePath);
    assert.equal((live.prepare('SELECT count(*) c FROM conversations').get() as { c: number }).c, 2);
    const liveMsg = live.prepare('SELECT content FROM messages WHERE id = 1').get() as { content: string };
    assert.equal(liveMsg.content, 'live message', 'pre-existing rows untouched');
    const imported = live.prepare("SELECT id, conversation_id FROM messages WHERE content = 'hello from the past'").get() as
      { id: number; conversation_id: number };
    assert.notEqual(imported.conversation_id, 1, 'imported chat got a fresh conversation id');
    const att = live.prepare('SELECT message_id, conversation_id FROM message_attachments').get() as
      { message_id: number; conversation_id: number };
    assert.equal(att.message_id, imported.id, 'attachment follows its remapped message');
    assert.equal(att.conversation_id, imported.conversation_id);
    // The tree backfill ran over the staged data: the assistant reply hangs
    // off the imported user turn.
    const reply = live.prepare("SELECT parent_message_id FROM messages WHERE content = 'past reply'").get() as
      { parent_message_id: number };
    assert.equal(reply.parent_message_id, imported.id);
  });

  it('remaps memory supersession chains and renames legacy record columns', () => {
    merge();
    const live = openDatabase(livePath);
    const superseded = live.prepare("SELECT id, superseded_by FROM memories WHERE content = 'superseded fact'").get() as
      { id: number; superseded_by: number };
    const current = live.prepare("SELECT id, lineage_root_id FROM memories WHERE content = 'current fact'").get() as
      { id: number; lineage_root_id: number };
    assert.equal(superseded.superseded_by, current.id, 'supersession re-pointed through the id map');
    assert.equal(current.lineage_root_id, superseded.id, 'lineage root re-pointed too');
    const raw = live.prepare("SELECT thread_id, content_hash FROM raw_records WHERE id = 'uuid-old-1'").get() as
      { thread_id: string; content_hash: string };
    assert.equal(raw.thread_id, 'sess-9', 'legacy session_id landed as thread_id via the real migration');
    assert.equal(raw.content_hash, 'md5-abcdef', 'old hashes carried as-is — nothing verifies them');
  });

  it('never merges credentials, and reports unknown plugin tables instead of dropping silently', () => {
    const report = merge();
    const live = openDatabase(livePath);
    const tokens = live.prepare('SELECT name FROM mcp_tokens').all() as Array<{ name: string }>;
    assert.deepEqual(tokens.map(t => t.name), ['live-admin'], 'the old install token must not arrive');
    assert.ok(report.skippedTables.includes('plugin_projects_tasks'));
    assert.ok(report.notes.some(n => n.includes('plugin_projects_tasks')));
  });

  it('dry run produces the full report and writes nothing', () => {
    const report = merge({ dryRun: true });
    assert.equal(report.dryRun, true);
    assert.ok(report.tables.agent_definitions.inserted > 0, 'the report reflects what WOULD land');
    const live = openDatabase(livePath);
    assert.equal((live.prepare('SELECT count(*) c FROM conversations').get() as { c: number }).c, 1);
    assert.equal((live.prepare("SELECT count(*) c FROM agent_definitions WHERE id = 'hde-manager'").get() as { c: number }).c, 0);
  });

  it('selects by agent and by kind', () => {
    const report = merge({ agents: ['hde-manager'], only: ['memories'] });
    const live = openDatabase(livePath);
    assert.equal((live.prepare("SELECT count(*) c FROM memories").get() as { c: number }).c, 2);
    assert.equal((live.prepare('SELECT count(*) c FROM conversations').get() as { c: number }).c, 1, 'chats not selected');
    assert.equal((live.prepare("SELECT count(*) c FROM agent_definitions WHERE id = 'hde-manager'").get() as { c: number }).c, 0, 'definitions not selected');
    assert.equal(report.tables.conversations, undefined);
  });
});

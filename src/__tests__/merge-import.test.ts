/**
 * Merging a current-format export into a live database. What matters most is
 * what must NOT happen: credentials never move, live rows never get
 * clobbered, a non-current file is refused, and a dry run writes nothing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../db.js';
import { SqliteMemoryBackend } from '../memory/sqlite-backend.js';
import { mergeExportIntoDb, type MergeReport } from '../merge-import.js';
import { EXPORT_FORMAT, type ExportFile } from '../backup.js';

function currentExport(): ExportFile {
  return {
    format: EXPORT_FORMAT,
    exported_at: 1757000000,
    tables: {
      agent_definitions: [{
        id: 'imported-agent', type: 'generic', name: 'imported', description: 'd',
        system_prompt: 'p', runtime: 'direct', provider: 'claude', model: 'm',
        memory_backend: 'sqlite', tools_allowlist: '[]', can_call: '[]',
        api_key_ref: null, provider_options: '{}', capabilities: '[]',
        approval_tools: '[]', plugins: '[]', escalation_approvable: 0,
        allow_monitor_read: 0, enabled: 1, created_at: 1, updated_at: 1,
        previous_system_prompt: null, previous_saved_at: null,
      }, {
        id: 'dup', type: 'generic', name: 'incoming dup', description: 'd',
        system_prompt: 'incoming prompt', runtime: 'direct', provider: 'claude', model: 'm',
        memory_backend: 'sqlite', tools_allowlist: '[]', can_call: '[]',
        api_key_ref: null, provider_options: '{}', capabilities: '[]',
        approval_tools: '[]', plugins: '[]', escalation_approvable: 0,
        allow_monitor_read: 0, enabled: 1, created_at: 1, updated_at: 1,
        previous_system_prompt: null, previous_saved_at: null,
      }],
      memories: [
        { id: 2, agent_id: 'imported-agent', content: 'current fact', embedding: null, created_at: 2, superseded_by: null, lineage_root_id: 1 },
        { id: 1, agent_id: 'imported-agent', content: 'superseded fact', embedding: null, created_at: 1, superseded_by: 2, lineage_root_id: 0 },
      ],
      conversations: [
        { id: 1, agent_id: 'imported-agent', started_at: 10, ended_at: null, caller_agent_id: null, project_id: null, title: null, pinned: 0, archived: 0, read_at: null },
      ],
      messages: [
        { id: 1, conversation_id: 1, role: 'user', content: 'hello from elsewhere', created_at: 11, parent_message_id: null },
        { id: 2, conversation_id: 1, role: 'assistant', content: 'reply', created_at: 12, parent_message_id: 1 },
      ],
      message_attachments: [
        { id: 1, message_id: 1, conversation_id: 1, media_type: 'image/png', data: 'aGk=', created_at: 11 },
      ],
      raw_records: [{
        id: 'uuid-r1', type: 'note', content: 'record', content_hash: 'h',
        event_time: 5, ingest_time: 5, source: 'chat', source_ref: null,
        user_id: 'u', project_id: null, thread_id: 't1', mode: null,
        supersedes: null, prev_source_ref: null, acl: null, ttl: null, payload: null,
      }],
      mcp_tokens: [
        { id: 1, name: 'foreign', token_hash: 'x', token_prefix: 'rt_', scope: 'admin', created_at: 1, last_used_at: null, use_count: 0, revoked_at: null },
      ],
      plugin_widgets: [{ id: 1, name: 'w' }],
    },
  };
}

describe('merge-import', () => {
  let tmp: string;
  let live: Db;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ritsu-merge-'));
    live = openDatabase(join(tmp, 'live.db'));
    new SqliteMemoryBackend(live);
    live.prepare("INSERT INTO mcp_tokens (name, token_hash, token_prefix, scope) VALUES ('live-admin','livehash','rt_','admin')").run();
    live.prepare(`INSERT INTO agent_definitions (id, type, name, description, system_prompt, runtime, provider, model)
                  VALUES ('dup', 'generic', 'live dup', 'd', 'live prompt', 'direct', 'claude', 'm')`).run();
    live.prepare("INSERT INTO conversations (id, agent_id) VALUES (1, 'dup')").run();
    live.prepare("INSERT INTO messages (id, conversation_id, role, content) VALUES (1, 1, 'user', 'live message')").run();
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  function merge(opts = {}): MergeReport {
    return mergeExportIntoDb(currentExport(), live, opts);
  }

  it('refuses anything that is not a current-format export', () => {
    const noStamp = currentExport() as { format?: string };
    delete noStamp.format;
    assert.throws(() => mergeExportIntoDb(noStamp as never, live), /unrecognised export format/);

    const oldColumn = currentExport();
    (oldColumn.tables.agent_definitions as Array<Record<string, unknown>>)[0].dispatcher = 'claude-direct';
    assert.throws(() => mergeExportIntoDb(oldColumn, live), /dispatcher/);
  });

  it('merges without touching collisions, and replaces only when asked', () => {
    const report = merge();
    assert.deepEqual(report.skippedAgents, ['dup']);
    let dup = live.prepare("SELECT name FROM agent_definitions WHERE id = 'dup'").get() as { name: string };
    assert.equal(dup.name, 'live dup');

    merge({ replaceAgents: ['dup'] });
    dup = live.prepare("SELECT name FROM agent_definitions WHERE id = 'dup'").get() as { name: string };
    assert.equal(dup.name, 'incoming dup');
  });

  it('remaps conversation/message/attachment/memory ids so nothing collides', () => {
    merge();
    const liveMsg = live.prepare('SELECT content FROM messages WHERE id = 1').get() as { content: string };
    assert.equal(liveMsg.content, 'live message');
    const imported = live.prepare("SELECT id, conversation_id FROM messages WHERE content = 'hello from elsewhere'").get() as
      { id: number; conversation_id: number };
    assert.notEqual(imported.conversation_id, 1);
    const reply = live.prepare("SELECT parent_message_id FROM messages WHERE content = 'reply'").get() as
      { parent_message_id: number };
    assert.equal(reply.parent_message_id, imported.id);
    const att = live.prepare('SELECT message_id, conversation_id FROM message_attachments').get() as
      { message_id: number; conversation_id: number };
    assert.equal(att.message_id, imported.id);
    assert.equal(att.conversation_id, imported.conversation_id);
    const superseded = live.prepare("SELECT superseded_by FROM memories WHERE content = 'superseded fact'").get() as
      { superseded_by: number };
    const current = live.prepare("SELECT id FROM memories WHERE content = 'current fact'").get() as { id: number };
    assert.equal(superseded.superseded_by, current.id);
  });

  it('never merges credentials, and reports unknown plugin tables', () => {
    const report = merge();
    const tokens = live.prepare('SELECT name FROM mcp_tokens').all() as Array<{ name: string }>;
    assert.deepEqual(tokens.map(t => t.name), ['live-admin']);
    assert.ok(report.skippedTables.includes('plugin_widgets'));
  });

  it('dry run produces the full report and writes nothing', () => {
    const report = merge({ dryRun: true });
    assert.equal(report.dryRun, true);
    assert.ok(report.tables.agent_definitions.inserted > 0);
    assert.equal((live.prepare('SELECT count(*) c FROM conversations').get() as { c: number }).c, 1);
    assert.equal((live.prepare("SELECT count(*) c FROM agent_definitions WHERE id = 'imported-agent'").get() as { c: number }).c, 0);
  });
});

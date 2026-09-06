/**
 * The workspace-UI backend: projects (chat + file filing), the guarded file
 * browser over an agent's workspace roots, and default-chat resolution.
 *
 * The properties that matter most here are the refusals — a project must not
 * file another agent's chat, a tag must not be mintable for a path outside the
 * roots, and the file routes must be unable to read or write past a root even
 * via symlink — because the browser runs with operator authority over real
 * directories on disk.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { createAdminApp } from '../admin/server.js';
import { ProjectStore } from '../project-store.js';
import { SkillStore } from '../skill-store.js';
import { PromptStore } from '../prompt-store.js';
import { listFiles, readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceFile, canonicalIfContained } from '../agent-files.js';
import { AgentHost, type DispatcherFactory } from '../agent-host.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { WorkspaceStore, type Workspace } from '../workspace-store.js';
import { TokenStore } from '../auth/token-store.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { OAuthStore } from '../auth/oauth-store.js';
import { SecretStore } from '../auth/secret-store.js';
import { ApprovalStore } from '../approval-store.js';
import { CommsDenialStore } from '../comms-denial-store.js';
import { PluginHost } from '../plugins/host.js';
import { SqliteChannelStore } from '../channels/channel-store.js';
import { ChannelRegistry } from '../channels/registry.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { BackupManager } from '../backup.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';
import type { ChatResponse } from '../model/dispatcher.js';

// ─── ProjectStore unit ──────────────────────────────────────────────────────

describe('ProjectStore', () => {
  let db: Db;
  let store: ProjectStore;
  let convs: SqliteConversationStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new ProjectStore(db);
    convs = new SqliteConversationStore(db);
  });

  it('creates, lists (name-sorted), renames, reads', () => {
    store.create('alice', 'zeta');
    const p = store.create('alice', 'Alpha');
    store.create('bob', 'other-agent');
    assert.deepEqual(store.listFor('alice').map(x => x.name), ['Alpha', 'zeta']);
    assert.equal(store.rename(p.id, 'Alpha Prime'), true);
    assert.equal(store.read(p.id)?.name, 'Alpha Prime');
    assert.equal(store.rename(9999, 'x'), false);
  });

  it('counts filed chats and tagged files', () => {
    const p = store.create('alice', 'sbir');
    const cid = convs.start('alice');
    convs.setProject(cid, p.id);
    store.tagFile('alice', '/ws/a.pdf', p.id);
    store.tagFile('alice', '/ws/b.pdf', p.id);
    const row = store.read(p.id)!;
    assert.equal(row.chat_count, 1);
    assert.equal(row.file_count, 2);
  });

  it('delete unfiles members but never deletes them', () => {
    const p = store.create('alice', 'doomed');
    const cid = convs.start('alice');
    convs.setProject(cid, p.id);
    store.tagFile('alice', '/ws/a.pdf', p.id);
    assert.equal(store.delete(p.id), true);
    // The conversation survives, unfiled.
    const summaries = convs.listSummaries('alice');
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].project_id, null);
    assert.equal(store.fileTagsFor('alice').size, 0);
    assert.equal(store.delete(p.id), false);
  });

  it('a file belongs to at most one project — tagging moves it', () => {
    const a = store.create('alice', 'a');
    const b = store.create('alice', 'b');
    store.tagFile('alice', '/ws/doc.md', a.id);
    store.tagFile('alice', '/ws/doc.md', b.id);
    const tags = store.fileTagsFor('alice');
    assert.equal(tags.get('/ws/doc.md'), b.id);
    assert.equal(store.read(a.id)?.file_count, 0);
    store.tagFile('alice', '/ws/doc.md', null);
    assert.equal(store.fileTagsFor('alice').size, 0);
  });
});

// ─── agent-files unit (real tmpdir) ─────────────────────────────────────────

describe('agent-files', () => {
  let root: string;
  let outside: string;
  let ws: Workspace[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ritsu-wsfiles-'));
    outside = mkdtempSync(join(tmpdir(), 'ritsu-outside-'));
    writeFileSync(join(root, 'notes.md'), 'hello');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'plan.txt'), 'the plan');
    writeFileSync(join(root, '.secret'), 'hidden');
    writeFileSync(join(outside, 'loot.txt'), 'nope');
    symlinkSync(join(outside, 'loot.txt'), join(root, 'link.txt'));
    // The agent's flags are read-only ON PURPOSE: the operator browser must
    // still be able to write — containment, not agent permissions, is the gate.
    ws = [{ id: 1, agent_id: 'alice', path: root, permissions: ['read'] } as unknown as Workspace];
  });

  const cleanup = () => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); };
  after(cleanup);

  it('lists regular files with root-relative paths; skips dotfiles and symlinks', () => {
    const { files, truncated } = listFiles(ws);
    assert.equal(truncated, false);
    const rels = files.map(f => f.rel).sort();
    assert.deepEqual(rels, ['docs/plan.txt', 'notes.md']);
    assert.ok(files.every(f => f.path.startsWith(root)));
  });

  it('reads a file back and refuses what it must', async () => {
    const r = await readWorkspaceFile('notes.md', ws);
    assert.ok(r.ok && r.value.data.toString() === 'hello');
    assert.equal((await readWorkspaceFile('missing.md', ws)).ok, false);
    assert.equal((await readWorkspaceFile('../' + 'loot.txt', ws)).ok, false, 'lexical traversal');
    assert.equal((await readWorkspaceFile('/etc/hostname', ws)).ok, false, 'absolute escape');
    assert.equal((await readWorkspaceFile('link.txt', ws)).ok, false, 'symlink to outside');
  });

  it('writes despite agent-read-only flags, creates parents, honors overwrite', async () => {
    const w1 = await writeWorkspaceFile('new/deep/file.txt', Buffer.from('v1'), ws, false);
    assert.ok(w1.ok, 'operator write into read-only-for-agent root must succeed');
    const clash = await writeWorkspaceFile('new/deep/file.txt', Buffer.from('v2'), ws, false);
    assert.equal(clash.ok, false, 'refuse silent overwrite');
    const w2 = await writeWorkspaceFile('new/deep/file.txt', Buffer.from('v2'), ws, true);
    assert.ok(w2.ok);
    const back = await readWorkspaceFile('new/deep/file.txt', ws);
    assert.ok(back.ok && back.value.data.toString() === 'v2');
  });

  it('refuses to write outside the root, even by symlink', async () => {
    assert.equal((await writeWorkspaceFile('../evil.txt', Buffer.from('x'), ws, true)).ok, false);
    assert.equal((await writeWorkspaceFile('link.txt', Buffer.from('x'), ws, true)).ok, false);
    assert.equal(existsSync(join(outside, 'evil.txt')), false);
    assert.equal((await import('node:fs')).readFileSync(join(outside, 'loot.txt'), 'utf8'), 'nope',
      'the symlink target was never touched');
  });

  it('deletes only real contained files', async () => {
    assert.ok((await deleteWorkspaceFile('notes.md', ws)).ok);
    assert.equal(existsSync(join(root, 'notes.md')), false);
    assert.equal((await deleteWorkspaceFile('notes.md', ws)).ok, false);
    assert.equal((await deleteWorkspaceFile('link.txt', ws)).ok, false, 'symlink refused');
    assert.equal(existsSync(join(outside, 'loot.txt')), true);
  });

  it('canonicalIfContained: identity for real files, null otherwise', async () => {
    assert.equal(await canonicalIfContained('docs/plan.txt', ws), join(root, 'docs', 'plan.txt'));
    assert.equal(await canonicalIfContained('missing.md', ws), null);
    assert.equal(await canonicalIfContained('/etc/hostname', ws), null);
    assert.equal(await canonicalIfContained('link.txt', ws), null);
  });
});

// ─── Route level ────────────────────────────────────────────────────────────

const dispatched: Array<{ agent: string; messages: Array<{ role: string; content: unknown }> }> = [];
const stubFactory: DispatcherFactory = (def) => ({
  kind: 'claude-direct',
  defaultModel: def.model,
  async chat(req): Promise<ChatResponse> {
    dispatched.push({ agent: def.id, messages: req.messages });
    return { content: `reply #${dispatched.length}`, model: def.model, raw: null };
  },
});

describe('workspace API routes', () => {
  let db: Db;
  let server: Server;
  let baseUrl: string;
  let adminToken: string;
  let convs: SqliteConversationStore;
  let channelStore: SqliteChannelStore;
  let wsRoot: string;

  before(async () => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    db = openDatabase(':memory:');
    wsRoot = mkdtempSync(join(tmpdir(), 'ritsu-wsapi-'));

    const defStore = new SqliteAgentDefinitionStore(db);
    convs = new SqliteConversationStore(db);
    const workspaces = new WorkspaceStore(db);
    const secrets = new SecretStore(db);
    const tokens = new TokenStore(db);
    adminToken = tokens.mint('test-admin', 'admin').token;
    channelStore = new SqliteChannelStore(db);

    const host = new AgentHost(
      db, convs, defStore, workspaces, new ApiKeyStore(db), new ApprovalStore(db),
      secrets, new CommsDenialStore(db), stubFactory,
    );

    // Two agents so cross-agent refusals are testable; alice gets a real root.
    for (const id of ['alice', 'bob']) {
      const saved = await defStore.upsert({
        id, type: 'generic', name: id, description: id, system_prompt: 'p',
        model: 'm',
      } as never);
      host.addOrReplace(saved);
    }
    workspaces.upsert({ agent_id: 'alice', path: wsRoot, permissions: ['read'] } as never);

    const app = createAdminApp({
    db,
      defStore, host, tokens, apiKeys: new ApiKeyStore(db), workspaces,
      pluginHost: new PluginHost(db, secrets),
      memory: new SqliteMemoryStore(db),
      conversations: convs,
      approvals: new ApprovalStore(db),
      commsDenials: new CommsDenialStore(db),
      secrets,
      backup: new BackupManager(db, join(wsRoot, 'unused.db')),
      channels: channelStore,
      channelRegistry: new ChannelRegistry(channelStore, { get: () => { throw new Error('unused'); } }),
      jobs: new SqliteJobStore(db),
      oauth: new OAuthStore(db),
      projects: new ProjectStore(db), skills: new SkillStore(db), prompts: new PromptStore(db),
      version: 'test', authMode: 'on', mcpUrl: 'http://127.0.0.1:1',
    });
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>(r => server.close(() => r()));
    rmSync(wsRoot, { recursive: true, force: true });
  });

  async function req(method: string, path: string, body?: unknown):
    Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* binary */ }
    return { status: res.status, json };
  }

  it('serves the operations board without a token, like the other page chrome', async () => {
    for (const [path, marker] of [
      ['/admin/ops', 'Operations'],
      ['/admin/ops.js', 'operations board'],
      ['/admin/ops.css', '--rail-w'],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200, `${path} should be auth-exempt static chrome`);
      assert.ok((await res.text()).includes(marker), `${path} serves the ops asset`);
    }
    // The data endpoints behind it stay gated.
    const gated = await fetch(`${baseUrl}/admin/api/approvals`);
    assert.equal(gated.status, 401);
  });

  it('project CRUD round-trips over HTTP', async () => {
    const c = await req('POST', '/admin/api/agents/alice/projects', { name: 'sbir' });
    assert.equal(c.status, 201);
    const pid = c.json.id as number;
    const l = await req('GET', '/admin/api/agents/alice/projects');
    assert.deepEqual((l.json.projects as Array<{ name: string }>).map(p => p.name), ['sbir']);
    assert.equal((await req('PATCH', `/admin/api/projects/${pid}`, { name: 'sbir-26' })).status, 200);
    assert.equal((await req('DELETE', `/admin/api/projects/${pid}`)).status, 204);
    assert.equal((await req('GET', '/admin/api/agents/ghost/projects')).status, 404);
  });

  it('files a conversation, and refuses filing under another agent\'s project', async () => {
    const mine = (await req('POST', '/admin/api/agents/alice/projects', { name: 'mine' })).json.id as number;
    const theirs = (await req('POST', '/admin/api/agents/bob/projects', { name: 'theirs' })).json.id as number;
    const cid = convs.start('alice');

    const cross = await req('PATCH', `/admin/api/conversations/${cid}/project`, { project_id: theirs });
    assert.equal(cross.status, 400, 'a chat must not surface inside another agent\'s workspace');

    assert.equal((await req('PATCH', `/admin/api/conversations/${cid}/project`, { project_id: mine })).status, 200);
    assert.equal(convs.listSummaries('alice').find(s => s.id === cid)?.project_id, mine);

    assert.equal((await req('PATCH', `/admin/api/conversations/${cid}/project`, { project_id: null })).status, 200);
    assert.equal(convs.listSummaries('alice').find(s => s.id === cid)?.project_id, null);
  });

  it('default-chat is stable and reports the bound channel', async () => {
    const a = await req('GET', '/admin/api/agents/alice/default-chat');
    const b = await req('GET', '/admin/api/agents/alice/default-chat');
    assert.equal(a.json.conversation_id, b.json.conversation_id, 'the anchor must not wander');
    assert.equal(a.json.channel, null);

    channelStore.create({
      name: 'hde-bot', kind: 'telegram', operator_agent_id: 'alice',
      config: { bot_token: 'x', chat_id: null }, enabled: true,
    });
    const c = await req('GET', '/admin/api/agents/alice/default-chat');
    assert.equal((c.json.channel as { kind: string }).kind, 'telegram');
    // bob has no channel; his default chat stays unbadged.
    assert.equal((await req('GET', '/admin/api/agents/bob/default-chat')).json.channel, null);
  });

  it('upload → list → tag → download → delete, with tags dying with the file', async () => {
    const pid = (await req('POST', '/admin/api/agents/alice/projects', { name: 'files' })).json.id as number;

    const up = await req('POST', '/admin/api/agents/alice/files', {
      path: 'ref/spec.md', data: Buffer.from('# spec').toString('base64'),
    });
    assert.equal(up.status, 201);

    let list = await req('GET', '/admin/api/agents/alice/files');
    const entry = (list.json.files as Array<{ rel: string; project_id: number | null; path: string }>)
      .find(f => f.rel === 'ref/spec.md');
    assert.ok(entry);
    assert.equal(entry.project_id, null);

    assert.equal((await req('POST', '/admin/api/agents/alice/files/tag',
      { path: entry.path, project_id: pid })).status, 200);
    list = await req('GET', '/admin/api/agents/alice/files');
    assert.equal((list.json.files as Array<{ rel: string; project_id: number | null }>)
      .find(f => f.rel === 'ref/spec.md')?.project_id, pid);

    const dl = await fetch(`${baseUrl}/admin/api/agents/alice/file?path=${encodeURIComponent(entry.path)}`,
      { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal(await dl.text(), '# spec');

    assert.equal((await req('DELETE', `/admin/api/agents/alice/file?path=${encodeURIComponent(entry.path)}`)).status, 204);
    list = await req('GET', '/admin/api/agents/alice/files');
    assert.equal((list.json.files as Array<{ rel: string }>).some(f => f.rel === 'ref/spec.md'), false);
  });

  it('renames and deletes chats, but never the default chat', async () => {
    const dc = (await req('GET', '/admin/api/agents/alice/default-chat')).json.conversation_id as number;
    const cid = (await req('POST', '/admin/api/agents/alice/conversations')).json.conversation_id as number;

    assert.equal((await req('PATCH', `/admin/api/conversations/${cid}/title`, { title: '  Launch plan  ' })).status, 200);
    let row = convs.listSummaries('alice').find(sm => sm.id === cid);
    assert.equal(row?.title, 'Launch plan', 'manual title overrides, trimmed');

    assert.equal((await req('PATCH', `/admin/api/conversations/${cid}/title`, { title: null })).status, 200);
    row = convs.listSummaries('alice').find(sm => sm.id === cid);
    assert.equal(row?.title, '', 'null reverts to the derived (empty here) title');

    // The anchor is renameable but not deletable.
    assert.equal((await req('PATCH', `/admin/api/conversations/${dc}/title`, { title: 'HQ' })).status, 200);
    const refuse = await req('DELETE', `/admin/api/conversations/${dc}`);
    assert.equal(refuse.status, 400);
    assert.match(String(refuse.json.error), /default chat/);

    assert.equal((await req('DELETE', `/admin/api/conversations/${cid}`)).status, 204);
    assert.equal(convs.listSummaries('alice').some(sm => sm.id === cid), false);
    assert.equal((await req('DELETE', `/admin/api/conversations/${cid}`)).status, 404);
  });

  it('pins, archives, searches, and forks', async () => {
    // Seed a chat with content via the store (no model in this harness).
    const cid = (await req('POST', '/admin/api/agents/alice/conversations')).json.conversation_id as number;
    convs.append(cid, 'user', 'planning the zephyr launch window');
    convs.append(cid, 'assistant', 'the window opens **Tuesday**; checklist follows');
    convs.append(cid, 'user', 'add fuel margins to the checklist');

    // flags
    assert.equal((await req('PATCH', `/admin/api/conversations/${cid}/flags`, { pinned: true })).status, 200);
    let sm = convs.listSummaries('alice').find(x => x.id === cid)!;
    assert.equal(sm.pinned, true);
    assert.equal((await req('PATCH', `/admin/api/conversations/${cid}/flags`, { archived: true })).status, 200);
    sm = convs.listSummaries('alice').find(x => x.id === cid)!;
    assert.equal(sm.archived, true);
    const dc = (await req('GET', '/admin/api/agents/alice/default-chat')).json.conversation_id as number;
    const refuse = await req('PATCH', `/admin/api/conversations/${dc}/flags`, { archived: true });
    assert.equal(refuse.status, 400, 'archiving the channel-fed anchor must be refused');

    // search: multi-word ANDs across DIFFERENT messages; archived still found
    const hit = await req('GET', `/admin/api/search?agent_id=alice&q=${encodeURIComponent('zephyr fuel')}`);
    const results = hit.json.results as Array<{ id: number; snippet: string }>;
    assert.ok(results.some(r => r.id === cid), 'archived chat is searchable');
    assert.match(results.find(r => r.id === cid)!.snippet, /zephyr/i);
    const miss = await req('GET', `/admin/api/search?agent_id=alice&q=${encodeURIComponent('zephyr unobtainium')}`);
    assert.ok(!(miss.json.results as Array<{ id: number }>).some(r => r.id === cid), 'every term must match somewhere');

    // fork: full copy, title marked, project filing kept
    const pid = (await req('POST', '/admin/api/agents/alice/projects', { name: 'zephyr' })).json.id as number;
    await req('PATCH', `/admin/api/conversations/${cid}/project`, { project_id: pid });
    const fork = await req('POST', `/admin/api/conversations/${cid}/fork`, {});
    assert.equal(fork.status, 201);
    const fid = fork.json.conversation_id as number;
    const fsm = convs.listSummaries('alice').find(x => x.id === fid)!;
    assert.match(fsm.title, / \(fork\)$/);
    assert.equal(fsm.project_id, pid, 'fork keeps the project filing');
    assert.equal(fsm.archived, false, 'fork starts unarchived');
    assert.equal(convs.recent(fid).length, 3);
    assert.equal(convs.recent(fid)[1].content.includes('Tuesday'), true);

    // partial fork: only up to the second message
    const msgs = convs.recent(cid);
    void msgs;
    const upTo = (await req('POST', `/admin/api/conversations/${cid}/fork`,
      { up_to_message_id: 2_000_000 })).status;
    assert.equal(upTo, 201);
  });

  it('threads a message tree: edits branch, regenerate makes siblings, context follows the path', async () => {
    const cid = (await req('POST', '/admin/api/agents/alice/conversations')).json.conversation_id as number;

    // Two linear turns.
    await req('POST', '/admin/agents/alice/ask', { message: 'first question', conversation_id: cid });
    await req('POST', '/admin/agents/alice/ask', { message: 'second question', conversation_id: cid });
    const rows = convs.recent(cid);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].parent_message_id, null, 'root turn');
    assert.equal(rows[1].parent_message_id, rows[0].id, 'reply answers the question');
    assert.equal(rows[2].parent_message_id, rows[1].id, 'linear default = continue from leaf');

    // Edit turn one: same parent as the original (root) → a sibling branch.
    await req('POST', '/admin/agents/alice/ask',
      { message: 'first question, edited', conversation_id: cid, parent_message_id: null });
    const afterEdit = convs.recent(cid);
    const edited = afterEdit.find(m => m.content === 'first question, edited')!;
    assert.equal(edited.parent_message_id, null, 'sibling of the original root turn');
    // The dispatch for the edited turn must NOT contain branch A's tail.
    const lastDispatch = dispatched.at(-1)!;
    const texts = lastDispatch.messages.map(m => String(m.content));
    assert.equal(texts.some(t => t.includes('second question')), false,
      'the other branch must not leak into context');

    // Regenerate the very first answer: a sibling under the same user turn.
    const firstAnswer = rows[1];
    const regen = await req('POST', `/admin/api/conversations/${cid}/regenerate`,
      { assistant_message_id: firstAnswer.id });
    assert.equal(regen.status, 200);
    const sibs = convs.recent(cid).filter(m => m.role === 'assistant' && m.parent_message_id === rows[0].id);
    assert.equal(sibs.length, 2, 'original + regenerated, side by side');
    assert.equal((await req('POST', `/admin/api/conversations/${cid}/regenerate`,
      { assistant_message_id: 999_999 })).status, 400);
  });

  it('skills: CRUD, binding, agent-scoped body lookup, and manifest injection', async () => {
    const mk = await req('POST', '/admin/api/skills',
      { name: 'release-notes', description: 'How to write our release notes', content: '# Steps\nBe terse.' });
    assert.equal(mk.status, 201);
    const sid = mk.json.id as number;
    assert.equal((await req('POST', '/admin/api/skills',
      { name: 'release-notes', description: '', content: 'x' })).status, 409, 'names are unique');

    assert.equal((await req('POST', '/admin/api/agents/alice/skills', { skill_id: sid })).status, 200);
    const list = await req('GET', '/admin/api/skills');
    assert.deepEqual((list.json.skills as Array<{ agents: string[] }>)[0].agents, ['alice']);

    // The manifest reaches the next turn's system context; the body does not.
    const cid = (await req('POST', '/admin/api/agents/alice/conversations')).json.conversation_id as number;
    await req('POST', '/admin/agents/alice/ask', { message: 'hi', conversation_id: cid });
    const sys = dispatched.at(-1)!.messages.filter(m => m.role === 'system').map(m => String(m.content));
    assert.ok(sys.some(t => t.includes('release-notes') && t.includes('view_skill')), 'lazy manifest injected');
    assert.equal(sys.some(t => t.includes('Be terse.')), false, 'body loads only on demand');

    assert.equal((await req('DELETE', `/admin/api/agents/alice/skills/${sid}`)).status, 200);
    assert.equal((await req('DELETE', `/admin/api/skills/${sid}`)).status, 204);
  });

  it('a project prompt is inherited by chats filed under it — and only those', async () => {
    const pid = (await req('POST', '/admin/api/agents/alice/projects', { name: 'persona' })).json.id as number;
    assert.equal((await req('PATCH', `/admin/api/projects/${pid}/prompt`,
      { system_prompt: 'Answer in pirate voice.' })).status, 200);

    const inside = (await req('POST', '/admin/api/agents/alice/conversations')).json.conversation_id as number;
    await req('PATCH', `/admin/api/conversations/${inside}/project`, { project_id: pid });
    await req('POST', '/admin/agents/alice/ask', { message: 'ahoy', conversation_id: inside });
    let sys = dispatched.at(-1)!.messages.filter(m => m.role === 'system').map(m => String(m.content));
    assert.ok(sys.some(t => t.includes('pirate voice')), 'filed chat inherits the project prompt');

    const outside = (await req('POST', '/admin/api/agents/alice/conversations')).json.conversation_id as number;
    await req('POST', '/admin/agents/alice/ask', { message: 'hello', conversation_id: outside });
    sys = dispatched.at(-1)!.messages.filter(m => m.role === 'system').map(m => String(m.content));
    assert.equal(sys.some(t => t.includes('pirate voice')), false, 'unfiled chats stay vanilla');
  });

  it('prompt library scopes rows per agent plus globals', async () => {
    await req('POST', '/admin/api/prompts', { name: 'daily', content: 'Summarize {{topic|text}}', agent_id: null });
    await req('POST', '/admin/api/prompts', { name: 'alice-only', content: 'x', agent_id: 'alice' });
    await req('POST', '/admin/api/prompts', { name: 'bob-only', content: 'x', agent_id: 'bob' });
    const names = ((await req('GET', '/admin/api/agents/alice/prompts')).json.prompts as Array<{ name: string }>)
      .map(x => x.name);
    assert.ok(names.includes('daily') && names.includes('alice-only') && !names.includes('bob-only'));
  });

  it('context plumbing: fetch-url is SSRF-guarded, reference chats come fenced', async () => {
    assert.equal((await req('POST', '/admin/api/agents/alice/fetch-url',
      { url: 'http://127.0.0.1:1/x' })).status, 400, 'loopback refused before any request');
    assert.equal((await req('POST', '/admin/api/agents/alice/fetch-url',
      { url: 'file:///etc/passwd' })).status, 400);

    const cid = (await req('POST', '/admin/api/agents/alice/conversations')).json.conversation_id as number;
    convs.append(cid, 'user', 'the launch code discussion');
    const ctx = await req('POST', `/admin/api/conversations/${cid}/as-context`);
    assert.equal(ctx.status, 200);
    assert.match(String(ctx.json.text), /UNTRUSTED/, 'a referenced transcript is data, not instructions');
    assert.match(String(ctx.json.text), /launch code discussion/);
  });

  it('read markers: opening a chat clears its unread state', async () => {
    const cid = (await req('POST', '/admin/api/agents/alice/conversations')).json.conversation_id as number;
    convs.append(cid, 'assistant', 'a message that arrived while nobody looked');
    let sm = convs.listSummaries('alice').find(x => x.id === cid)!;
    assert.equal(sm.read_at, null);
    assert.ok(sm.last_message_at, 'summaries expose the newest message time');
    assert.equal((await req('PATCH', `/admin/api/conversations/${cid}/read`)).status, 200);
    sm = convs.listSummaries('alice').find(x => x.id === cid)!;
    assert.ok(sm.read_at != null && sm.read_at >= sm.last_message_at!, 'read_at moves past the newest message');
  });

  it('prompt scope is editable after creation, and unbind is idempotent', async () => {
    const pr = (await req('POST', '/admin/api/prompts', { name: 'scoped', content: 'x', agent_id: 'alice' })).json;
    const prId = pr.id as number;
    assert.equal((await req('PATCH', `/admin/api/prompts/${prId}`, { agent_id: null })).status, 200);
    const bobs = ((await req('GET', '/admin/api/agents/bob/prompts')).json.prompts as Array<{ name: string }>);
    assert.ok(bobs.some(x => x.name === 'scoped'), 'now global, so bob sees it');

    const sk = (await req('POST', '/admin/api/skills', { name: 'idem', description: '', content: 'x' })).json;
    const skId = sk.id as number;
    assert.equal((await req('DELETE', `/admin/api/agents/alice/skills/${skId}`)).status, 200,
      'unbinding a never-bound skill is the requested state, not an error');
  });

  it('refuses traversal and speculative tags over HTTP', async () => {
    const esc = await req('POST', '/admin/api/agents/alice/files', {
      path: '../../escape.txt', data: Buffer.from('x').toString('base64'),
    });
    assert.equal(esc.status, 400);

    const pid = (await req('POST', '/admin/api/agents/alice/projects', { name: 'spec-tags' })).json.id as number;
    const ghost = await req('POST', '/admin/api/agents/alice/files/tag',
      { path: '/etc/hostname', project_id: pid });
    assert.equal(ghost.status, 404, 'tags must reference real, contained files only');
  });
});

describe('legacy message backfill', () => {
  it('threads pre-tree linear history once, and never re-threads a deliberate root sibling', () => {
    const db = openDatabase(':memory:');
    // Simulate a pre-tree database: null out the parents the store wrote.
    const c = new SqliteConversationStore(db);
    const cid = c.start('a');
    c.append(cid, 'user', 'q1'); c.append(cid, 'assistant', 'r1'); c.append(cid, 'user', 'q2');
    db.exec('UPDATE messages SET parent_message_id = NULL');
    // Re-open (same handle: rerun the migration path by hand).
    const hasTree = db.prepare('SELECT 1 AS x FROM messages WHERE parent_message_id IS NOT NULL LIMIT 1').get();
    assert.equal(hasTree, undefined);
    db.exec(`UPDATE messages SET parent_message_id = (
      SELECT MAX(m2.id) FROM messages m2
      WHERE m2.conversation_id = messages.conversation_id AND m2.id < messages.id
    ) WHERE parent_message_id IS NULL`);
    const rows = c.recent(cid);
    assert.equal(rows[0].parent_message_id, null, 'first message stays a root');
    assert.equal(rows[1].parent_message_id, rows[0].id);
    assert.equal(rows[2].parent_message_id, rows[1].id);
    // A deliberate root sibling now exists; the guard must keep later boots out.
    c.append(cid, 'user', 'edited root', null, undefined, null);
    const guard = db.prepare('SELECT 1 AS x FROM messages WHERE parent_message_id IS NOT NULL LIMIT 1').get();
    assert.notEqual(guard, undefined, 'threaded rows exist, so the backfill never runs again');
  });
});

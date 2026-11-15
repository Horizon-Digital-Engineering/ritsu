import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { SqliteAgentDefinitionStore, seedIfEmpty } from '../agent-definition-store.js';
import { WorkspaceStore } from '../workspace-store.js';
import { ApprovalStore } from '../approval-store.js';
import { PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { TokenStore } from '../auth/token-store.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { OAuthStore } from '../auth/oauth-store.js';
import { CommsDenialStore } from '../comms-denial-store.js';
import { AgentHost } from '../agent-host.js';
import { SqliteChannelStore } from '../channels/channel-store.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { ChannelRegistry } from '../channels/registry.js';
import { createAdminApp, type AdminDeps } from '../admin/server.js';
import { ProjectStore } from '../project-store.js';
import { SkillStore } from '../skill-store.js';
import { PromptStore } from '../prompt-store.js';
import { SettingsStore } from '../settings-store.js';
import { BackupManager } from '../backup.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';
import { NOTHING_HEARD, NOT_WAV, SpeechService, TOO_LONG, storeSources, type SpeechStatus } from '../speech/index.js';
import type { AsrModel } from '../speech/builtin.js';
import { modelDir } from '../speech/model.js';
import { PROXY_LOGIN, fakeModel, toneWav } from './speech-helpers.js';

describe('speech API', () => {
  const servers: Server[] = [];
  let base = '';
  let bare = '';
  let adminToken = '';
  let dataDir = '';
  let cid = 0;
  let speech: SpeechService;
  const prompts: string[] = [];
  let whisperUrl = '';

  const call = (method: string, path: string, body?: unknown, to = base): Promise<Response> =>
    fetch(`${to}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const send = (wav: Buffer, query = '', type = 'audio/wav', to = base): Promise<Response> =>
    fetch(`${to}/admin/api/speech/transcribe${query}`, {
      method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${adminToken}` }, body: new Uint8Array(wav),
    });

  before(async () => {
    process.env.RITSU_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
    _resetKeyCacheForTests();
    dataDir = mkdtempSync(join(tmpdir(), 'ritsu-speech-admin-'));
    const db = openDatabase(':memory:');
    const memory = new SqliteMemoryStore(db);
    const conversations = new SqliteConversationStore(db);
    const defStore = new SqliteAgentDefinitionStore(db);
    await seedIfEmpty(defStore);
    cid = conversations.start('hello-world');
    const tokens = new TokenStore(db);
    const apiKeys = new ApiKeyStore(db);
    const workspaces = new WorkspaceStore(db);
    const approvals = new ApprovalStore(db);
    const secrets = new SecretStore(db);
    const pluginHost = new PluginHost(db, secrets);
    const commsDenials = new CommsDenialStore(db);
    const host = new AgentHost(db, conversations, defStore, workspaces, apiKeys, approvals, secrets, commsDenials);
    host.setPluginHost(pluginHost);
    const channelStore = new SqliteChannelStore(db);
    adminToken = tokens.mint('test-admin', 'admin').token;
    const settings = new SettingsStore(db);
    const fakeLoad = async (): Promise<AsrModel> => ({ transcribe: async () => ' Ask not what your country can do for you. ', dispose: async () => undefined });
    speech = new SpeechService({ ...storeSources(dataDir, settings, apiKeys), builtin: { load: fakeLoad } });
    const deps: AdminDeps = {
      db, defStore, host, tokens, apiKeys, workspaces, pluginHost, memory, conversations,
      approvals, commsDenials, secrets, channels: channelStore,
      channelRegistry: new ChannelRegistry(channelStore, { get: (id: string) => host.get(id) }), jobs: new SqliteJobStore(db),
      backup: new BackupManager(db, ':memory:'), oauth: new OAuthStore(db), projects: new ProjectStore(db), skills: new SkillStore(db),
      prompts: new PromptStore(db), settings, version: 'test', authMode: 'on', mcpUrl: 'http://127.0.0.1:7333',
    };
    const listen = async (app: ReturnType<typeof createAdminApp>): Promise<string> => {
      const s = await new Promise<Server>(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
      servers.push(s);
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    };
    base = await listen(createAdminApp({ ...deps, speech }));
    bare = await listen(createAdminApp(deps));

    const whisper = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData().then(fd => {
          const p = fd.get('prompt');
          prompts.push(typeof p === 'string' ? p : '');
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: ' from the whisper server ' }));
        });
      });
    });
    await new Promise<void>(r => whisper.listen(0, '127.0.0.1', () => r()));
    servers.push(whisper);
    whisperUrl = `http://127.0.0.1:${(whisper.address() as AddressInfo).port}/inference`;
  });

  after(async () => {
    for (const s of servers) s.close();
    await speech.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports the engines and what a recording would do', async () => {
    const res = await call('GET', '/admin/api/speech');
    assert.equal(res.status, 200);
    const st = await res.json() as SpeechStatus;
    assert.deepEqual([st.choice, st.engine, st.max_seconds, st.whisper_url, st.model], ['auto', null, 300, '', null]);
    assert.match(st.sentence, /^No speech engine can run yet/);
    assert.deepEqual(st.engines.map(e => Object.keys(e)), Array(3).fill(['id', 'label', 'available', 'detail', 'cost']));
    assert.deepEqual(st.engines.map(e => e.label), ['Built-in Whisper', 'Whisper server', 'OpenAI gpt-transcribe']);
  });

  it('answers 422 with the sentence when no engine can run, 400 for what is not a WAV', async () => {
    const res = await send(toneWav({ seconds: 1 }));
    assert.equal(res.status, 422);
    assert.match((await res.json() as { error: string }).error, /^No speech engine can run yet/);
    const junk = await send(Buffer.from('this is not a recording'));
    assert.equal(junk.status, 400);
    assert.deepEqual(await junk.json(), { error: NOT_WAV });
    const asJson = await fetch(`${base}/admin/api/speech/transcribe`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: '{"audio":"x"}',
    });
    assert.equal(asJson.status, 400);
    assert.equal((await send(toneWav({ seconds: 1 }), '?conversation_id=abc')).status, 400);
  });

  it('answers 413 past five minutes, whether the WAV says so or the body is too big', async () => {
    const long = await send(toneWav({ seconds: 302 }));
    assert.equal(long.status, 413);
    assert.deepEqual(await long.json(), { error: TOO_LONG });
    const huge = await send(Buffer.alloc(9_800_000), '', 'application/octet-stream');
    assert.equal(huge.status, 413);
    assert.deepEqual(await huge.json(), { error: TOO_LONG });
  });

  it('silence comes back with a note and no engine', async () => {
    const res = await send(toneWav({ seconds: 1.5, amplitude: 0 }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: '', engine: null, seconds: 1.5, note: NOTHING_HEARD });
  });

  it('transcribes with the built-in engine once a model is in the folder', async () => {
    fakeModel(dataDir, 'small.en');
    try {
      const res = await send(toneWav({ seconds: 4.2 }), `?conversation_id=${cid}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { text: 'Ask not what your country can do for you.', engine: 'builtin', seconds: 4.2 });
      const st = await (await call('GET', '/admin/api/speech')).json() as SpeechStatus;
      assert.equal(st.sentence, 'Speech goes to the built-in Whisper (small.en).');
    } finally { rmSync(modelDir(dataDir), { recursive: true }); }
  });

  it('follows the settings, and the chat it was spoken into primes the whisper server', async () => {
    const saved = await call('POST', '/admin/api/settings', { settings: { 'speech.engine': 'local', 'speech.whisper_url': whisperUrl } });
    assert.equal(saved.status, 200);
    const st = await (await call('GET', '/admin/api/speech')).json() as SpeechStatus;
    assert.deepEqual([st.choice, st.engine, st.whisper_url], ['local', 'local', whisperUrl]);
    const res = await send(toneWav({ seconds: 1 }), `?conversation_id=${cid}`);
    assert.deepEqual(await res.json(), { text: 'from the whisper server', engine: 'local', seconds: 1 });
    assert.equal(prompts.at(-1), 'A conversation with Hello World.');
    await send(toneWav({ seconds: 1 }));
    assert.equal(prompts.at(-1), '', 'no chat, no prompt');
    assert.equal((await call('POST', '/admin/api/settings', { settings: { 'speech.engine': 'off' } })).status, 200);
    const off = await send(toneWav({ seconds: 1 }));
    assert.equal(off.status, 422);
    assert.deepEqual(await off.json(), { error: 'Voice is off.' });
    assert.equal((await call('POST', '/admin/api/settings', { settings: { 'speech.engine': '', 'speech.whisper_url': '' } })).status, 200);
    const back = await (await call('GET', '/admin/api/speech')).json() as SpeechStatus;
    assert.deepEqual([back.choice, back.whisper_url], ['auto', '']);
  });

  it('accepts only known engines and http(s) whisper addresses', async () => {
    const res = await call('GET', '/admin/api/settings');
    const d = await res.json() as { defaults: Record<string, string> };
    assert.equal(d.defaults['speech.engine'], 'auto');
    assert.equal(d.defaults['speech.whisper_url'], '');
    for (const settings of [{ 'speech.engine': 'cuda' }, { 'speech.whisper_url': 'ftp://example.test/inference' }, { 'speech.whisper_url': 'not an address' }]) {
      const bad = await call('POST', '/admin/api/settings', { settings });
      assert.equal(bad.status, 400, JSON.stringify(settings));
    }
    for (const choice of ['auto', 'builtin', 'local', 'openai', 'off']) {
      assert.equal((await call('POST', '/admin/api/settings', { settings: { 'speech.engine': choice } })).status, 200, choice);
    }
    assert.equal((await call('POST', '/admin/api/settings', { settings: { 'speech.engine': '' } })).status, 200);
  });

  it('refuses a whisper address that carries a user name or password, and stores nothing', async () => {
    for (const url of [`https://${PROXY_LOGIN}@whisper.example.test/inference`, 'https://operator@whisper.example.test/inference']) {
      const res = await call('POST', '/admin/api/settings', { settings: { 'speech.whisper_url': url } });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'the whisper server address cannot carry a user name or password' });
    }
    const st = await (await call('GET', '/admin/api/speech')).json() as SpeechStatus;
    assert.deepEqual([st.whisper_url, st.engines[1].available], ['', false]);
  });

  it('is gated by the admin token, writes an audit row, and is 503 when not wired', async () => {
    const anon = await fetch(`${base}/admin/api/speech/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(toneWav({ seconds: 1 })) });
    assert.equal(anon.status, 401);
    const audit = await (await call('GET', '/admin/api/audit')).json() as { audit: Array<{ path: string; status: number }> };
    assert.ok(audit.audit.some(r => r.path === '/admin/api/speech/transcribe' && r.status === 200));
    assert.equal((await call('GET', '/admin/api/speech', undefined, bare)).status, 503);
    assert.equal((await send(toneWav({ seconds: 1 }), '', 'audio/wav', bare)).status, 503);
  });
});

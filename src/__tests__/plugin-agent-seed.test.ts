import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo, Server } from 'node:net';
import { openDatabase } from '../db.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { WorkspaceStore } from '../workspace-store.js';
import { ApprovalStore } from '../approval-store.js';
import { PluginHost } from '../plugins/host.js';
import { CommsDenialStore } from '../comms-denial-store.js';
import { SecretStore } from '../auth/secret-store.js';
import { TokenStore } from '../auth/token-store.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { OAuthStore } from '../auth/oauth-store.js';
import { AgentHost } from '../agent-host.js';
import { SqliteChannelStore } from '../channels/channel-store.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { ChannelRegistry } from '../channels/registry.js';
import { createAdminApp } from '../admin/server.js';
import { ProjectStore } from '../project-store.js';
import { SkillStore } from '../skill-store.js';
import { PromptStore } from '../prompt-store.js';
import { BackupManager } from '../backup.js';
import { healthPlugin } from '../plugins/health/plugin.js';

// CORE-2: a plugin ships a DEFAULT agent config; the operator loads it into a
// real, editable agent (one POST). Not a hardcoded agent — a preset.
describe('plugin agent preset (CORE-2)', () => {
  it('exposes the preset via PluginHost (lightweight in manifests, full via agentSeed)', () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db, new SecretStore(db));
    host.register(healthPlugin);
    const m = host.manifests().find(p => p.id === 'health');
    assert.deepEqual(m?.agent, { id: 'health-assistant', name: 'Health Advisor' });
    const seed = host.agentSeed('health');
    assert.ok(seed && seed.system_prompt.length > 50);
  });

  describe('load-agent route', () => {
    let server: Server;
    let base = '';
    let token = '';
    let defStore: SqliteAgentDefinitionStore;

    before(async () => {
      const db = openDatabase(':memory:');
      const memory = new SqliteMemoryStore(db);
      const conversations = new SqliteConversationStore(db);
      defStore = new SqliteAgentDefinitionStore(db);
      const tokens = new TokenStore(db);
      const apiKeys = new ApiKeyStore(db);
      const oauth = new OAuthStore(db);
      const workspaces = new WorkspaceStore(db);
      const approvals = new ApprovalStore(db);
      const secrets = new SecretStore(db);
      const commsDenials = new CommsDenialStore(db);
      const pluginHost = new PluginHost(db, secrets);
      pluginHost.register(healthPlugin);
      const host = new AgentHost(db, conversations, defStore, workspaces, apiKeys, approvals, secrets, commsDenials);
      host.setPluginHost(pluginHost);
      const channelStore = new SqliteChannelStore(db);
      const channels = new ChannelRegistry(channelStore, { get: (id: string) => host.get(id) });
      token = tokens.mint('t', 'admin').token;
      const app = createAdminApp({
        defStore, host, tokens, apiKeys, workspaces, pluginHost, memory, conversations,
        approvals, commsDenials, secrets, backup: new BackupManager(db, ':memory:'), channels: channelStore, channelRegistry: channels, jobs: new SqliteJobStore(db), oauth,
        projects: new ProjectStore(db), skills: new SkillStore(db), prompts: new PromptStore(db),
        version: 'test', authMode: 'off', mcpUrl: 'http://127.0.0.1:7333',
      });
      await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server?.close());

    const load = () => fetch(`${base}/admin/api/plugins/health/agent`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

    it('creates an editable agent wired to the plugin, then is non-destructive on re-load', async () => {
      const r1 = await load();
      assert.equal(r1.status, 201);
      assert.deepEqual(await r1.json(), { created: true, id: 'health-assistant' });

      const def = await defStore.read('health-assistant');
      assert.ok(def);
      assert.equal(def.name, 'Health Advisor');
      assert.ok(def.plugins.includes('health'), 'agent should be wired to the health plugin');

      // second load leaves the (possibly user-edited) agent untouched
      const r2 = await load();
      assert.equal(r2.status, 200);
      assert.deepEqual(await r2.json(), { created: false, id: 'health-assistant' });
    });
  });
});

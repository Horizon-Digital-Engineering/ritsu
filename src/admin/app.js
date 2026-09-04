// ritsu admin UI client.
//
// Served as a static asset at /admin/app.js so the page can drop
// 'unsafe-inline' from script-src. Every interaction routes through
// the single document-level click delegator at the bottom of the file
// (data-action="..."), so no inline onclick=/onsubmit= attributes
// survive in the HTML or in JS-built innerHTML strings.

// ---- helpers ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** Strip every trailing `/`. Regex-free (linear-time, no backtracking) so
 *  static analyzers don't have to reason about regex engine behaviour. */
function stripTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s.codePointAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const fmtRelative = (epoch) => {
  if (!epoch) return 'never';
  const diff = Date.now() / 1000 - epoch;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 14) return Math.floor(diff / 86400) + 'd ago';
  return new Date(epoch * 1000).toLocaleDateString();
};

/** Stable hash → glyph + color for any agent id. Same id renders identically everywhere. */
const GLYPH_SHAPES = ['●', '■', '▲', '◆', '★', '◉', '◐', '◢'];
const GLYPH_HUES   = [200, 280, 140, 30, 0, 320, 240, 100];   // HSL hue stops
function agentHash(agentId) {
  let h = 5381;
  for (const c of String(agentId)) {
    h = ((h << 5) + h + (c.codePointAt(0) ?? 0)) >>> 0;
  }
  return h;
}
function glyphShape(agentId) {
  return GLYPH_SHAPES[agentHash(agentId) % GLYPH_SHAPES.length];
}
function glyphFor(agentId) {
  const h = agentHash(agentId);
  const shape = GLYPH_SHAPES[h % GLYPH_SHAPES.length];
  // Discrete hue index → CSS rule keyed off data-hue-idx in app.css. The
  // CSS owns the per-index hsl() triple, so we don't need an inline style
  // attribute here (which is what lets style-src drop 'unsafe-inline').
  const hueIdx = Math.floor(h / GLYPH_SHAPES.length) % GLYPH_HUES.length;
  return `<span class="agent-glyph" data-hue-idx="${hueIdx}">${shape}</span>`;
}

function copyBtn(text, label = 'copy') {
  return `<button class="copy-btn" type="button" data-action="copy" data-copy="${esc(text)}">${esc(label)}</button>`;
}
function copyClick(btn) {
  const text = btn.dataset.copy;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
  });
}

const ADMIN_TOKEN_KEY = 'ritsu.adminToken';
// localStorage (not sessionStorage): mobile Safari wipes sessionStorage on tab
// close / memory pressure / ITP, forcing a re-login every visit. The admin UI
// sits behind a tailnet-only URL, so the network ACL is the real auth boundary.
function getAdminToken() { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; }
function setAdminToken(t) { localStorage.setItem(ADMIN_TOKEN_KEY, t); }
function clearAdminToken() { localStorage.removeItem(ADMIN_TOKEN_KEY); }
function signOut() { clearAdminToken(); location.reload(); }

// Shared login-gate: many api() calls fire in parallel at page load;
// we want exactly ONE modal instead of five stacked dialogs.
let _tokenPromise = null;
function showAdminLogin(reason) {
  const overlay = $('admin-login');
  const form    = $('admin-login-form');
  const input   = $('admin-login-token');
  const msg     = $('admin-login-msg');
  msg.textContent = reason || 'Sign in with your admin token.';
  overlay.classList.add('open');
  input.value = '';
  // Defer focus so the browser/password manager has time to autofill first.
  setTimeout(() => input.focus(), 50);
  return new Promise(resolve => {
    const onSubmit = (e) => {
      e.preventDefault();
      const t = input.value.trim();
      if (!t) return;
      setAdminToken(t);
      overlay.classList.remove('open');
      form.removeEventListener('submit', onSubmit);
      resolve(true);
    };
    form.addEventListener('submit', onSubmit);
  });
}
async function ensureAdminToken(reason) {
  if (getAdminToken()) return true;
  if (_tokenPromise) return _tokenPromise;
  _tokenPromise = showAdminLogin(reason);
  try { return await _tokenPromise; }
  finally { _tokenPromise = null; }
}

async function api(method, path, body) {
  // Every admin API request carries the admin token via X-Ritsu-Admin-Token
  // (or Authorization: Bearer — server accepts both). If we don't have one
  // yet, prompt before firing. If the server returns 401, clear and re-prompt.
  if (!getAdminToken()) {
    const got = await ensureAdminToken('Admin token required.');
    if (!got) throw new Error('admin token required');
  }
  const doFetch = async () => {
    const headers = { 'X-Ritsu-Admin-Token': getAdminToken() };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  };
  let r = await doFetch();
  if (r.status === 401) {
    clearAdminToken();
    const got = await ensureAdminToken('Admin token rejected — paste again.');
    if (!got) throw new Error('admin token required');
    r = await doFetch();
  }
  const text = await r.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!r.ok) throw new Error(json?.error || `${r.status}`);
  return json;
}

/**
 * Authenticated SSE consumer. Browser's EventSource can't send custom
 * headers, so admin-gated streams have to use streaming fetch + manual
 * parsing of the text/event-stream wire format.
 *
 * Caller passes an AbortController signal so they can close the stream
 * via controller.abort(). onEvent receives the parsed JSON of each
 * `data:` block. Comment lines (`:keepalive`) are dropped.
 *
 * Auto-reconnect: on transport failure, waits 2s and reopens. Caller
 * aborts to stop the loop permanently.
 */
async function sseFetch(path, onEvent, signal) {
  while (!signal.aborted) {
    try {
      const r = await fetch(path, {
        headers: { 'X-Ritsu-Admin-Token': getAdminToken(), Accept: 'text/event-stream' },
        signal,
      });
      if (!r.ok || !r.body) throw new Error(`sse ${r.status}`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE events end with a blank line (\n\n). Split, keep the
        // trailing partial in buf for the next chunk.
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLines = raw.split('\n')
            .filter(l => l.startsWith('data: '))
            .map(l => l.slice(6));
          if (!dataLines.length) continue;
          try { onEvent(JSON.parse(dataLines.join('\n'))); }
          catch { /* malformed payload — skip, keep stream alive */ }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      console.warn('sse reconnect in 2s:', e?.message ?? e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function toast(msg, kind = 'ok') {
  const el = $('toast');
  el.classList.remove('hidden');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  setTimeout(() => { el.classList.add('hidden'); }, 3000);
}

// ---- two-row grouped nav ---------------------------------------------------
// Row 1 (rendered statically in HTML) = top-level groups. Row 2 (rendered
// here, hidden when the active group has ≤1 tab) = sub-tabs of the active
// group. The pane is keyed off the *tab* id, same as before, so existing
// loaders / pane ids didn't have to move.
const NAV_GROUPS = [
  { id: 'dashboard', label: 'Dashboard', tabs: [
    { id: 'tiles', label: 'Dashboard' },
  ] },
  { id: 'approvals', label: 'Approvals', tabs: [
    { id: 'approvals', label: 'Approvals' },
  ] },
  { id: 'agents', label: 'Agents', tabs: [
    { id: 'agents',        label: 'Agents' },
    { id: 'workspaces',    label: 'Workspaces' },
    { id: 'memories',      label: 'Memories' },
    { id: 'conversations', label: 'Conversations' },
    { id: 'tools',         label: 'Tools' },
  ] },
  { id: 'comms', label: 'Comms', tabs: [
    { id: 'channels', label: 'Channels' },
    { id: 'jobs', label: 'Jobs' },
    { id: 'mcp',      label: 'MCP' },
  ] },
  { id: 'extensions', label: 'Extensions', tabs: [
    { id: 'extensions', label: 'Extensions' },
  ] },
  { id: 'auth', label: 'Auth', tabs: [
    { id: 'tokens',        label: 'Tokens' },
    { id: 'api-keys',      label: 'API Keys' },
    { id: 'oauth-clients', label: 'OAuth Clients' },
  ] },
  { id: 'system', label: 'System', tabs: [
    { id: 'health',   label: 'Health' },
    { id: 'memory',   label: 'Memory' },
    { id: 'settings', label: 'Settings' },
    { id: 'logs',    label: 'Logs' },
    { id: 'audit',   label: 'Audit' },
    { id: 'plugins', label: 'Plugins' },
    { id: 'backups', label: 'Backups' },
  ] },
];
const TAB_TO_GROUP = (() => {
  const m = new Map();
  for (const g of NAV_GROUPS) for (const t of g.tabs) m.set(t.id, g.id);
  return m;
})();
let activeGroup = 'dashboard';
let activeTab   = 'tiles';

function renderNav() {
  document.querySelectorAll('#nav-primary button').forEach(b => {
    b.classList.toggle('active', b.dataset.group === activeGroup);
  });
  const sub = $('nav-secondary');
  const group = NAV_GROUPS.find(g => g.id === activeGroup);
  // Singleton groups (Dashboard, today's System) hide row 2 entirely — no
  // sense in a row with one tab that just duplicates the group label.
  if (!group || group.tabs.length <= 1) {
    sub.innerHTML = '';
    sub.classList.add('empty');
    return;
  }
  sub.classList.remove('empty');
  sub.innerHTML = group.tabs.map(t =>
    `<button data-action="switch-tab" data-tab="${esc(t.id)}" class="${t.id === activeTab ? 'active' : ''}">${esc(t.label)}</button>`,
  ).join('');
}

function switchGroup(groupId) {
  const group = NAV_GROUPS.find(g => g.id === groupId);
  if (!group) return;
  activeGroup = groupId;
  // Open the group on its first sub-tab. (V2: remember last sub-tab per group.)
  switchTab(group.tabs[0].id);
}

function switchTab(name) {
  activeTab = name;
  const parentGroup = TAB_TO_GROUP.get(name);
  if (parentGroup) activeGroup = parentGroup;
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === `pane-${name}`));
  renderNav();
  if (name === 'tiles') startTilesPolling();
  else stopTilesPolling();
  if (pluginTabs[name]) pluginTabs[name](document.getElementById(`pane-${name}`));
  if (name === 'approvals') loadApprovalsTab();
  if (name === 'extensions') loadExtensionsTab();
  if (name === 'mcp') loadMcpTools();
  else if (name === 'tokens') refreshTokens();
  else if (name === 'api-keys') { refreshApiKeys(); loadClaudeToken(); }
  else if (name === 'oauth-clients') loadOAuthClientsTab();
  else if (name === 'channels') loadChannelsTab();
  else if (name === 'jobs') loadJobsTab();
  else if (name === 'workspaces') loadWorkspacesTab();
  else if (name === 'conversations') loadConversationsTab();
  else if (name === 'memories') loadMemoriesTab();
  else if (name === 'tools') loadToolsTab();
  else if (name === 'logs') openLogStream();
  else if (name === 'audit') loadAuditTab();
  else if (name === 'plugins') loadPluginsManager();
  else if (name === 'backups') loadBackupsTab();
  else if (name === 'health') loadHealthTab();
  else if (name === 'memory') loadMemoryTab();
  else if (name === 'settings') loadSettingsTab();
  if (name !== 'logs') closeLogStream();
}

// ---- info bar --------------------------------------------------------------
function renderMasterKeyBanner(ok) {
  let el = $('master-key-banner');
  if (ok) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'master-key-banner';
    el.className = 'mk-banner';
    document.querySelector('main')?.prepend(el);
  }
  el.textContent = 'No master key — secrets cannot be stored. Create one on the server, then restart: '
    + "sudo sh -c 'umask 077; openssl rand -base64 32 > /etc/ritsu/master-key' "
    + '&& sudo chown ritsu:ritsu /etc/ritsu/master-key. Back it up: it is excluded from database backups.';
}

async function refreshInfo() {
  try {
    const d = await api('GET', '/admin/api/info');
    $('version').textContent = `v${d.version}`;
    // Without a master key every secret write fails, and each connector then
    // reads as "not configured" for the same hidden reason. Say it once, loudly.
    renderMasterKeyBanner(d.master_key_ok !== false);
    const authChip = `<span class="chip ${d.auth_effective === 'open' ? 'warn' : 'ok'}">mcp: ${esc(d.auth_effective)}</span>`;
    const modeChip = `<span class="chip">mode: ${esc(d.auth_mode)}</span>`;
    const levelChip = `<span class="chip">log: ${esc(d.log_level)}</span>`;
    const agentsChip = `<span class="chip">${d.agent_count} agent${d.agent_count===1?'':'s'}</span>`;
    const tokensChip = `<span class="chip">${d.active_token_count} token${d.active_token_count===1?'':'s'}</span>`;
    const signOutChip = `<button type="button" class="chip action" data-action="sign-out" title="Clear admin token from this browser">sign out</button>`;
    $('info-bar').innerHTML = authChip + modeChip + levelChip + agentsChip + tokensChip + signOutChip;
    $('mcp-url').textContent = `${location.protocol}//${location.hostname}:7333/mcp`;
    $('mcp-auth-note').innerHTML = d.auth_effective === 'required'
      ? `MCP auth is <strong>required</strong>. Include <code>Authorization: Bearer rt_…</code> on every call.`
      : `MCP auth is <strong>open</strong> (mode: <code>${d.auth_mode}</code>). Mint a token to auto-lock in 'auto' mode.`;
  } catch (e) {
    // Best-effort UI refresh: if the info call fails (network blip, page
    // closing) the existing chips stay as-is. Log for visibility but don't
    // surface a toast on every transient blip.
    console.warn('refreshInfo failed', e);
  }
}

// ---- agents ----------------------------------------------------------------
let agentCache = [];
async function refreshAgents() {
  try {
    const { agents } = await api('GET', '/admin/agents');
    agentCache = agents;
    renderAgents();
  } catch (e) { toast(e.message, 'err'); }
}
function applyAgentFilters() { renderAgents(); }
async function loadAgentTypes() {
  try {
    const { types } = await api('GET', '/admin/agents/types');
    $('f-type').innerHTML = types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  } catch (e) { toast(e.message, 'err'); }
}

let availableTools = [];
/** Signature of the last rendered approval-tools list, so a re-render only
 *  happens when the candidates actually changed — rebuilding innerHTML on every
 *  keystroke would yank focus out of a checkbox the operator is tabbing through. */
let approvalToolsRendered = null;
async function loadAvailableTools() {
  try {
    const { tools } = await api('GET', '/admin/api/tools/available');
    availableTools = tools;
    renderToolCheckboxes([]);
    approvalToolsRendered = null;
    renderApprovalToolsCheckboxes([]);
  } catch (e) { toast(e.message, 'err'); }
}
function renderToolCheckboxes(selected) {
  const set = new Set(selected || []);
  $('f-tools').innerHTML = availableTools.map(t =>
    `<label class="row fs-md1"><input type="checkbox" value="${esc(t)}" ${set.has(t) ? 'checked' : ''} class="input-auto" /> ${esc(t)}</label>`,
  ).join('');
}
function readToolsAllowlist() {
  return [...$('f-tools').querySelectorAll('input[type=checkbox]:checked')].map(el => el.value);
}
/**
 * Every tool name that could be put behind an approval, for the agent as the
 * form currently describes it. Built-ins first, then the in-process groups the
 * selected capabilities switch on. Offering only the built-ins was the trap:
 * on the direct runtime those are exactly the names the gate cannot enforce.
 */
function approvalToolCandidates() {
  const runtime = $('f-runtime')?.value || 'direct';
  const caps = {
    manage_agents: !!$('f-cap-manage')?.checked,
    monitor_agents: !!$('f-cap-monitor')?.checked,
    crm: !!$('f-cap-crm')?.checked,
    social: !!$('f-cap-social')?.checked,
  };
  const servers = ['memory', 'agent_comms', 'scheduler'];
  if (caps.manage_agents) servers.push('agent_admin');
  if (caps.monitor_agents) servers.push('agent_monitor');
  if (caps.crm) servers.push('email');
  if (caps.social) servers.push('social');
  const mcp = servers.flatMap(srv => MCP_TOOL_MAP[srv].map(t => toolName(runtime, srv, t)));
  return [...availableTools, ...mcp];
}

/** True when the runtime genuinely enforces a gate on this name. Mirrors
 *  ungateableApprovalTools() on the server — keep the two in step. */
function isGateable(toolName_, runtime) {
  return runtime === 'api' || toolName_.startsWith('mcp__');
}

function renderApprovalToolsCheckboxes(selected) {
  const set = new Set(selected || []);
  const runtime = $('f-runtime')?.value || 'direct';
  // Keep a ticked name visible even if a capability was since turned off,
  // otherwise unchecking a capability would silently drop its gates.
  const names = [...new Set([...approvalToolCandidates(), ...set])];
  // Explicit comparator: deterministic and locale-independent, since this
  // string is only ever compared against the previous render's.
  const sorted = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sig = `${runtime}|${names.join(',')}|${sorted.join(',')}`;
  if (sig === approvalToolsRendered) return;
  approvalToolsRendered = sig;
  $('f-approval-tools').innerHTML = names.map(t => {
    const inert = !isGateable(t, runtime);
    const note = inert ? ' <span class="txt-muted">(not enforceable on direct)</span>' : '';
    return `<label class="row fs-md1"><input type="checkbox" value="${esc(t)}" ${set.has(t) ? 'checked' : ''} class="input-auto" /> ${esc(t)}${note}</label>`;
  }).join('');
}
function readApprovalTools() {
  return [...$('f-approval-tools').querySelectorAll('input[type=checkbox]:checked')].map(el => el.value);
}
function renderPluginCheckboxes(selected) {
  const set = new Set(selected || []);
  const target = $('f-plugins');
  if (!target) return;
  const enabled = (installedPlugins || []).filter(p => p.enabled !== false);
  if (!enabled.length) {
    target.innerHTML = '<em class="txt-muted fs-md1">No enabled plugins.</em>';
    return;
  }
  target.innerHTML = enabled.map(p =>
    `<label class="row fs-md1"><input type="checkbox" value="${esc(p.id)}" ${set.has(p.id) ? 'checked' : ''} class="input-auto" /> ${esc(p.name)} <span class="txt-muted">(${(p.mcpTools || []).length} tools)</span></label>`,
  ).join('');
}
function readPlugins() {
  return [...$('f-plugins').querySelectorAll('input[type=checkbox]:checked')].map(el => el.value);
}
function renderCanCallCheckboxes(selected) {
  const set = new Set(selected || []);
  // Filter out self so an agent can't be configured to call itself.
  const callable = (agentCache || []).filter(a => a.id !== editingAgentId);
  const target = $('f-can-call');
  if (!callable.length) {
    target.innerHTML = '<em class="txt-muted fs-md1">No other agents exist yet.</em>';
    return;
  }
  target.innerHTML = callable.map(a =>
    `<label class="row fs-md1"><input type="checkbox" value="${esc(a.id)}" ${set.has(a.id) ? 'checked' : ''} class="input-auto" /> ${esc(a.id)}</label>`,
  ).join('');
}
function readCanCall() {
  return [...$('f-can-call').querySelectorAll('input[type=checkbox]:checked')].map(el => el.value);
}
function renderAgents() {
  const target = $('agent-list');
  if (!agentCache.length) {
    target.innerHTML = '<em class="txt-muted">No agents yet. Create one below.</em>';
    return;
  }
  const q = ($('agent-search')?.value || '').toLowerCase();
  const disp = $('agent-disp-filter')?.value || '';
  const stateF = $('agent-state-filter')?.value || '';
  const filtered = agentCache.filter(a => {
    if (q && !(a.id + ' ' + a.name + ' ' + a.description).toLowerCase().includes(q)) return false;
    if (disp && a.runtime !== disp) return false;
    if (stateF === 'on' && !a.enabled) return false;
    if (stateF === 'off' && a.enabled) return false;
    return true;
  });
  if (!filtered.length) {
    target.innerHTML = '<em class="txt-muted">No agents match the filter.</em>';
    return;
  }
  const rows = filtered.map(a => `
    <tr class="${a.enabled ? '' : 'disabled'}">
      <td class="id-cell">${glyphFor(a.id)}${esc(a.id)}</td>
      <td><span class="badge">${esc(a.type)}</span></td>
      <td>${esc(a.name)}</td>
      <td><span class="badge runtime-${esc(a.runtime)}">${esc(a.runtime)}:${esc(a.provider)}</span> ${esc(a.model)}</td>
      <td>${esc(a.memory_backend)}</td>
      <td title="${a.last_used_at ? new Date(a.last_used_at * 1000).toISOString() : ''}">${fmtRelative(a.last_used_at)}</td>
      <td>${a.enabled ? 'on' : 'off'}</td>
      <td class="row-actions">
        <button data-action="edit-agent" data-id="${esc(a.id)}">edit</button>
        <button data-action="toggle-agent" data-id="${esc(a.id)}" data-enabled="${a.enabled ? '0' : '1'}">${a.enabled ? 'disable' : 'enable'}</button>
        <button data-action="reload-agent" data-id="${esc(a.id)}">reload</button>
        <button class="danger" data-action="delete-agent" data-id="${esc(a.id)}">delete</button>
      </td>
    </tr>`).join('');
  target.innerHTML = `<table><thead><tr><th>id</th><th>type</th><th>name</th><th>runtime / model</th><th>memory</th><th>last used</th><th>state</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
/** id of the agent currently loaded into the form, or null if drafting a new one. */
let editingAgentId = null;
/**
 * Workspace cache for the agent currently in the form. Cleared on
 * loadAgentForm / clearForm; refreshed by ensureWorkspaceCache().
 * Cached because recomputeFormWarnings runs on every checkbox tick —
 * re-fetching there would race (last-to-resolve wins, not last-to-fire)
 * and a transient failure would silently produce a false "no workspace"
 * warning on an agent that has them.
 */
let editingWorkspaces = null;   // null = not loaded yet; [] = none

async function ensureWorkspaceCache() {
  if (!editingAgentId) { editingWorkspaces = []; return; }
  if (editingWorkspaces !== null) return;
  try {
    const r = await api('GET', `/admin/agents/${editingAgentId}/workspaces`);
    editingWorkspaces = r.workspaces ?? [];
  } catch (e) {
    // Don't silently treat fetch failure as "no workspaces" — surface it.
    editingWorkspaces = { error: e.message };
  }
}

/** Invalidate cache so the next recomputeFormWarnings refetches. Called from
 * the Workspaces tab after add/delete so the Agents tab warning re-evaluates
 * the next time it runs without needing a page reload. */
function invalidateWorkspaceCache(agentId) {
  if (agentId === editingAgentId) editingWorkspaces = null;
}

/** Cache the API key list so the agent form's dropdown can render without
 *  a round-trip every load. Refreshed when the form opens. */
let apiKeyCache = [];
async function refreshApiKeyDropdown() {
  try {
    const { api_keys } = await api('GET', '/admin/api/api-keys');
    apiKeyCache = api_keys.filter(k => !k.revoked_at);
  } catch { apiKeyCache = []; }
  renderApiKeyDropdown(null);
}
function renderApiKeyDropdown(selectedId) {
  const sel = $('f-api-key-ref');
  if (!sel) return;
  const opts = ['<option value="">— none (direct runtime / keyless endpoint) —</option>']
    .concat(apiKeyCache.map(k => `<option value="${k.id}">${esc(k.name)} (${esc(k.provider)})</option>`));
  sel.innerHTML = opts.join('');
  if (selectedId != null) sel.value = String(selectedId);
}

/** Provider choices per runtime tier. direct = vendor runtimes riding a
 *  subscription; api = metered providers behind ritsu's own loop. */
const RUNTIME_PROVIDERS = {
  direct: [
    { value: 'claude', label: 'claude (Agent SDK, Max plan)' },
  ],
  api: [
    { value: 'anthropic', label: 'anthropic (official SDK)' },
    { value: 'openai', label: 'openai (official SDK)' },
    { value: 'gemini', label: 'gemini (official SDK)' },
    { value: 'xai', label: 'xai / grok (api.x.ai)' },
    { value: 'openrouter', label: 'openrouter (any model, one key)' },
    { value: 'litellm', label: 'litellm proxy (key optional)' },
    { value: 'custom', label: 'custom (OpenAI-compatible base_url)' },
  ],
};
function renderProviderDropdown(runtime, selected) {
  const sel = $('f-provider');
  const list = RUNTIME_PROVIDERS[runtime] ?? RUNTIME_PROVIDERS.direct;
  sel.innerHTML = list.map(p => `<option value="${p.value}">${esc(p.label)}</option>`).join('');
  sel.value = list.some(p => p.value === selected) ? selected : list[0].value;
}
function loadAgentForm(a) {
  editingAgentId = a.id;
  editingWorkspaces = null;   // force refetch on next recomputeFormWarnings
  $('f-id').value = a.id; $('f-id').readOnly = true;
  $('f-type').value = a.type;
  $('f-name').value = a.name;
  $('f-description').value = a.description;
  $('f-runtime').value = a.runtime ?? 'direct';
  renderProviderDropdown(a.runtime ?? 'direct', a.provider ?? 'claude');
  $('f-model').value = a.model;
  $('f-memory-backend').value = a.memory_backend;
  $('f-enabled').checked = !!a.enabled;
  $('f-escalation-approvable').checked = !!a.escalation_approvable;
  $('f-allow-monitor-read').checked = !!a.allow_monitor_read;
  $('f-system-prompt').value = a.system_prompt;
  renderApiKeyDropdown(a.api_key_ref ?? null);
  $('f-provider-options').value = a.provider_options && Object.keys(a.provider_options).length
    ? JSON.stringify(a.provider_options)
    : '';
  refreshApiKeyDropdown().then(() => { renderApiKeyDropdown(a.api_key_ref ?? null); });
  renderToolCheckboxes(a.tools_allowlist || []);
  approvalToolsRendered = null;
  renderApprovalToolsCheckboxes(a.approval_tools || []);
  renderPluginCheckboxes(a.plugins || []);
  renderCanCallCheckboxes(a.can_call || []);
  const caps = new Set(a.capabilities || []);
  $('f-cap-manage').checked = caps.has('manage_agents');
  $('f-cap-monitor').checked = caps.has('monitor_agents');
  $('f-cap-crm').checked = caps.has('crm');
  $('f-cap-social').checked = caps.has('social');
  // Show Revert only when there's a previous prompt to swap to.
  const revertBtn = $('f-revert');
  if (a.previous_system_prompt) {
    revertBtn.classList.remove('hidden');
    revertBtn.title = `Revert to prompt saved ${fmtRelative(a.previous_saved_at)} (will swap current ↔ previous)`;
  } else {
    revertBtn.classList.add('hidden');
    revertBtn.title = '';
  }
  // Show the test pane.
  $('test-pane').classList.remove('hidden');
  $('test-reply').classList.add('hidden');
  $('test-meta').textContent = '';
  recomputeFormWarnings();
}
function clearForm() {
  editingAgentId = null;
  editingWorkspaces = [];   // new draft: definitively no workspaces
  $('agent-form').reset();
  $('f-id').readOnly = false;
  $('f-runtime').value = 'direct';
  renderProviderDropdown('direct', 'claude');
  $('f-provider-options').value = '';
  renderApiKeyDropdown(null);
  refreshApiKeyDropdown();
  renderToolCheckboxes([]);
  renderApprovalToolsCheckboxes([]);
  renderPluginCheckboxes([]);
  renderCanCallCheckboxes([]);
  $('f-cap-manage').checked = false;
  $('f-cap-monitor').checked = false;
  $('f-cap-crm').checked = false;
  $('f-cap-social').checked = false;
  $('f-revert').classList.add('hidden');
  $('test-pane').classList.remove('hidden'); // available for drafts too
  $('test-reply').classList.add('hidden');
  $('test-meta').textContent = '';
  recomputeFormWarnings();
}
async function submitAgent(method) {
  const runtime = $('f-runtime').value;
  const provider = $('f-provider').value;
  const apiKeyRefRaw = $('f-api-key-ref').value;
  const apiKeyRef = apiKeyRefRaw ? Number(apiKeyRefRaw) : null;
  const providerOptsRaw = $('f-provider-options').value.trim();
  let providerOptions = {};
  if (providerOptsRaw) {
    try { providerOptions = JSON.parse(providerOptsRaw); }
    catch { toast('provider options must be valid JSON', 'err'); return; }
  }
  const body = {
    id: $('f-id').value, type: $('f-type').value, name: $('f-name').value,
    description: $('f-description').value, runtime,
    model: $('f-model').value, memory_backend: $('f-memory-backend').value,
    enabled: $('f-enabled').checked, system_prompt: $('f-system-prompt').value,
    tools_allowlist: readToolsAllowlist(),
    approval_tools: readApprovalTools(),
    plugins: readPlugins(),
    escalation_approvable: $('f-escalation-approvable').checked,
    allow_monitor_read: $('f-allow-monitor-read').checked,
    can_call: readCanCall(),
    capabilities: [
      ...($('f-cap-manage').checked ? ['manage_agents'] : []),
      ...($('f-cap-monitor').checked ? ['monitor_agents'] : []),
      ...($('f-cap-crm').checked ? ['crm'] : []),
      ...($('f-cap-social').checked ? ['social'] : []),
    ],
    provider,
    api_key_ref: apiKeyRef,
    provider_options: providerOptions,
  };
  try {
    const url = method === 'POST' ? '/admin/agents' : `/admin/agents/${body.id}`;
    const saved = await api(method, url, body);
    toast(`${method} ok`);
    refreshAgents(); refreshInfo();
    // Re-load the form from the server response so the Revert button reflects
    // the new previous_system_prompt state.
    if (saved?.id) loadAgentForm(saved);
  } catch (e) { toast(e.message, 'err'); }
}
async function toggleAgent(id, enabled) {
  try { await api('PATCH', `/admin/agents/${id}`, { enabled }); refreshAgents(); refreshInfo(); }
  catch (e) { toast(e.message, 'err'); }
}
async function reloadAgent(id) {
  try { await api('POST', `/admin/agents/${id}/reload`); toast('reloaded'); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteAgent(id) {
  if (!confirm(`Delete agent "${id}"?\nMemories will be retained.`)) return;
  try { await api('DELETE', `/admin/agents/${id}`); refreshAgents(); refreshInfo(); }
  catch (e) { toast(e.message, 'err'); }
}
async function revertAgent() {
  if (!editingAgentId) return;
  if (!confirm(`Revert "${editingAgentId}" to the previous system prompt? The current one will become the new "previous".`)) return;
  try {
    const reverted = await api('POST', `/admin/agents/${editingAgentId}/revert`);
    toast('reverted');
    loadAgentForm(reverted);
    refreshAgents();
  } catch (e) { toast(e.message, 'err'); }
}

/** Tool allowlist presets — same set of SDK tool names used everywhere. */
const TOOL_PRESETS = {
  researcher: ['WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep'],
  editor:     ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  readonly:   ['Read', 'Glob', 'Grep'],
  none:       [],
};
function applyToolPreset(name) {
  const list = TOOL_PRESETS[name];
  if (!list) return;
  renderToolCheckboxes(list);
  recomputeFormWarnings();
  toast(`preset: ${name}`);
}

/**
 * Cross-tab consistency warnings on the agent edit form:
 *   - Tool needs filesystem access but no workspace is set: hard error
 *   - Tool needs write but no workspace grants write: hard error
 *   - Tool needs exec (Bash) but no workspace grants exec: hard error
 * These don't block save (the underlying tool just won't be usable),
 * but the banner makes the foot-gun visible.
 */
async function recomputeFormWarnings() {
  const banner = $('f-warnings');
  if (!banner) return;
  // The candidate list depends on runtime + capabilities, both of which live in
  // this form; re-render it here so it tracks them without its own listener.
  renderApprovalToolsCheckboxes(readApprovalTools());
  await ensureWorkspaceCache();
  banner.innerHTML = buildWarningHtml(
    readToolsAllowlist(), editingWorkspaces, editingAgentId,
    readApprovalTools(), $('f-runtime')?.value || 'direct',
  );
}

/** Map (selected tools, workspace cache, editingAgentId) → the warning-banner
 *  HTML string. Pure function — easier to reason about than mutating banner
 *  in-flight across branches, and unit-testable if we ever want to. */
function buildWarningHtml(toolList, workspaces, agentId, approvalTools = [], runtime = 'direct') {
  const tools = new Set(toolList);
  const needs = {
    read:  ['Read','Glob','Grep'].some(t => tools.has(t)),
    write: ['Write','Edit'].some(t => tools.has(t)),
    exec:  tools.has('Bash'),
  };
  const anyFsTool = needs.read || needs.write || needs.exec;

  // workspaces is one of: array of workspaces, [], or {error: msg}
  if (workspaces?.error) {
    return `<div class="warn-banner">⚠ <strong>Could not load workspaces for this agent</strong> — ${esc(workspaces.error)}. The tool-vs-workspace check is paused; the agent may still work if workspaces exist server-side.</div>`;
  }
  const wsList = Array.isArray(workspaces) ? workspaces : [];
  const lines = [
    ...collectFormWarningLines(needs, anyFsTool, wsList, agentId),
    ...ungateableWarningLines(approvalTools, runtime),
  ];
  return lines.length ? `<div class="warn-banner">⚠ ${lines.join('<br>')}</div>` : '';
}

/** An approval that cannot fire is worse than no approval — the operator ticks
 *  the box and stops worrying. Say so at the point of the tick. */
function ungateableWarningLines(approvalTools, runtime) {
  const inert = (approvalTools || []).filter(t => !isGateable(t, runtime));
  if (!inert.length) return [];
  return [`<strong>${inert.map(esc).join(', ')} cannot be gated on the direct runtime.</strong> ` +
    'The vendor SDK runs its built-ins without consulting the gate, so these approvals will never fire. ' +
    'Switch this agent to the api runtime, or drop those tools from its allowlist.'];
}

/** Decide which tool-vs-workspace mismatch lines to surface. Extracted from
 *  buildWarningHtml so the branch logic stays scoped and readable. */
function collectFormWarningLines(needs, anyFsTool, wsList, agentId) {
  if (anyFsTool && wsList.length === 0) {
    return [agentId
      ? `<strong>Filesystem tools enabled but no workspace set for "${esc(agentId)}".</strong> Add one in the Workspaces tab or those tools will fail at runtime.`
      // CREATE mode — agent doesn't exist yet, can't have workspaces. Softer hint.
      : `<em>You'll need to add a workspace after saving this agent — filesystem tools require one.</em>`];
  }
  const wsPerms = new Set();
  for (const w of wsList) for (const p of (w.permissions || [])) wsPerms.add(p);
  return [
    ...(needs.write && !wsPerms.has('write')
      ? ['<strong>Write / Edit enabled</strong> but no workspace grants <code>write</code>. The agent will be denied on Write attempts.']
      : []),
    ...(needs.exec && !wsPerms.has('exec')
      ? ['<strong>Bash enabled</strong> but no workspace grants <code>exec</code>. The agent will be denied on Bash attempts.']
      : []),
  ];
}

/** One-shot test: dispatches a single turn using the FORM's draft state. Not saved. */
async function runTest() {
  const msg = $('test-message').value.trim();
  if (!msg) return;
  const replyBox = $('test-reply');
  const meta = $('test-meta');
  replyBox.classList.remove('hidden');
  replyBox.textContent = 'thinking…';
  meta.textContent = '';
  const wsList = editingAgentId
    ? (await api('GET', `/admin/agents/${editingAgentId}/workspaces`).catch(() => ({ workspaces: [] }))).workspaces
    : [];
  try {
    const r = await api('POST', '/admin/api/test', {
      system_prompt: $('f-system-prompt').value,
      message: msg,
      runtime: $('f-runtime').value,
      provider: $('f-provider').value,
      api_key_ref: $('f-api-key-ref').value ? Number($('f-api-key-ref').value) : null,
      model: $('f-model').value,
      tools_allowlist: readToolsAllowlist(),
      workspaces: wsList.map(w => ({ path: w.path, permissions: w.permissions })),
    });
    replyBox.textContent = r.reply || '(empty reply)';
    meta.textContent = `${r.model} · ${r.duration_ms}ms · ${r.usage?.input_tokens ?? '?'} in / ${r.usage?.output_tokens ?? '?'} out · NOT saved`;
  } catch (e) {
    replyBox.textContent = `error: ${e.message}`;
    meta.textContent = '';
  }
}

// ---- Workspaces tab ---------------------------------------------------
let wsAgentId = null;
let wsListenersWired = false;
async function loadWorkspacesTab() {
  try {
    const { agents } = await api('GET', '/admin/agents');
    const pick = $('ws-pick');
    if (!agents.length) {
      pick.innerHTML = '<em class="txt-muted">No agents yet. Create one in the Agents tab.</em>';
      $('ws-section').classList.add('hidden');
      return;
    }
    const opts = agents.map(a => `<option value="${esc(a.id)}" ${wsAgentId === a.id ? 'selected' : ''}>${esc(a.id)} — ${esc(a.name)}</option>`).join('');
    pick.innerHTML = `<label>Agent: <select id="ws-pick-select"><option value="">— pick —</option>${opts}</select></label>`;
    $('ws-pick-select').onchange = (e) => {
      wsAgentId = e.target.value || null;
      if (wsAgentId) showWsSection();
      else $('ws-section').classList.add('hidden');
    };
    // Wire root/subpath live-preview listeners exactly once
    // (the form elements live in static HTML, not re-rendered).
    if (!wsListenersWired) {
      $('ws-root').addEventListener('change', updateResolvedPath);
      $('ws-subpath').addEventListener('input', updateResolvedPath);
      wsListenersWired = true;
    }
    // Refresh writable roots every load — picks up host-side `ritsu path add`
    // without needing a hard page reload.
    await loadWritableRoots();
    if (wsAgentId) showWsSection();
  } catch (e) { toast(e.message, 'err'); }
}
async function showWsSection() {
  $('ws-section').classList.remove('hidden');
  $('ws-section-title').textContent = `workspaces for "${wsAgentId}"`;
  try {
    const { workspaces } = await api('GET', `/admin/agents/${wsAgentId}/workspaces`);
    renderWsList(workspaces);
  } catch (e) { toast(e.message, 'err'); }
}
function renderWsList(list) {
  const target = $('ws-list');
  if (!list.length) {
    target.innerHTML = '<em class="txt-muted">No workspaces. Add one below.</em>';
    return;
  }
  const rows = list.map((w, idx) => `
    <tr>
      <td class="id-cell">${esc(w.path)} ${copyBtn(w.path)}</td>
      <td>${(w.permissions || []).map(p => `<span class="badge">${esc(p)}</span>`).join(' ')}</td>
      <td>${idx === 0 ? '<span class="badge" title="lowest id is used as cwd">cwd</span>' : ''}</td>
      <td class="row-actions"><button class="danger" data-action="delete-workspace" data-id="${w.id}">remove</button></td>
    </tr>`).join('');
  target.innerHTML = `<table><thead><tr><th>path</th><th>permissions</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
// Cache of sandbox-allowed roots. Populated on first Workspaces tab load
// and refreshed each time the section becomes visible so changes from
// `ritsu path add` are picked up without a hard reload.
let writableRoots = [];

async function loadWritableRoots() {
  try {
    const { roots } = await api('GET', '/admin/api/system/writable-roots');
    writableRoots = Array.isArray(roots) ? roots : [];
  } catch { writableRoots = []; }
  const sel = $('ws-root');
  if (writableRoots.length === 0) {
    sel.innerHTML = '<option value="">(no writable roots — run sudo ritsu path add)</option>';
  } else {
    sel.innerHTML = writableRoots
      .map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  }
  updateResolvedPath();
}

function updateResolvedPath() {
  const root = $('ws-root').value || '';
  const sub  = ($('ws-subpath').value || '').replace(/^\/+/, '').trim();
  const resolved = root && sub
    ? stripTrailingSlashes(root) + '/' + sub
    : (root || '—');
  $('ws-resolved').textContent = resolved;
}

async function addWorkspace() {
  if (!wsAgentId) { toast('pick an agent first', 'err'); return; }
  const root = $('ws-root').value;
  const subpath = $('ws-subpath').value.trim();
  if (!root) { toast('pick a root', 'err'); return; }
  const perms = [...$('ws-perms').querySelectorAll('input:checked')].map(el => el.value);
  try {
    await api('POST', `/admin/agents/${wsAgentId}/workspaces`, { root, subpath, permissions: perms });
    $('ws-subpath').value = '';
    updateResolvedPath();
    showWsSection();
    // If the same agent is being edited on the Agents tab, drop its
    // cached workspaces so the warning banner re-evaluates next render.
    invalidateWorkspaceCache(wsAgentId);
    toast('added');
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteWorkspace(id) {
  if (!wsAgentId) return;
  if (!confirm('Remove this workspace? The agent will lose access to it on the next reload.')) return;
  try {
    await api('DELETE', `/admin/agents/${wsAgentId}/workspaces/${id}`);
    showWsSection();
    invalidateWorkspaceCache(wsAgentId);
  } catch (e) { toast(e.message, 'err'); }
}

// ---- Tiles tab + agent chat side-panel -------------------------------
//
// The Tiles tab is a dashboard view: one card per agent with at-a-glance
// state (active dot, last activity, latest convo snippet) and a click
// target that opens a slide-in chat panel for that agent.
//
// The chat panel reuses /admin/agents/:id/ask — the same path the MCP
// ask_agent tool flows through — so transcripts and conversation IDs
// are consistent across surfaces. Conversation threading: opening the
// panel resumes the most recent conversation; the [+ new] button starts
// a fresh one.

let tilesPollHandle = null;
let panelAgentId = null;
let panelConvoId = null;
let panelAsking = false;
// Images the operator has pasted/dropped/picked but not yet sent. Each entry
// is { media_type, data (base64, no prefix), url (data: URL for preview) }.
// Cleared after a successful send and on panel close / convo switch.
let panelAttachments = [];
// The panel agent's model id, kept so the attach-hint can flag a text-only model.
let panelModel = null;
// AbortController for the conversation-events stream — fires for EVERY
// conversation event in the server, we filter by panelConvoId on
// receipt. Opened on openAgentPanel, aborted on closeAgentPanel.
let panelSseAbort = null;
// Set of conversation ids currently being processed by SOMEONE — this
// tab, another tab, another machine, or an agent-to-agent call. Driven
// by ask-start / ask-end SSE events. We render typing dots when our
// panelConvoId is in this set.
const panelInFlight = new Set();

function startTilesPolling() {
  refreshTiles();
  stopTilesPolling();
  tilesPollHandle = setInterval(refreshTiles, 10_000);
}
function stopTilesPolling() {
  if (tilesPollHandle) clearInterval(tilesPollHandle);
  tilesPollHandle = null;
}

async function refreshTiles() {
  try {
    const { tiles, server_now } = await api('GET', '/admin/api/agents/tiles');
    renderTiles(tiles, server_now);
  } catch (e) {
    $('tiles-grid').innerHTML = `<div class="txt-err">tiles failed: ${esc(e.message)}</div>`;
  }
}

function renderTiles(tiles, now) {
  const grid = $('tiles-grid');
  if (!tiles.length) {
    grid.innerHTML = '<div class="txt-muted">No agents yet. Create one in the Agents tab.</div>';
    return;
  }
  // Sort: most-recently-active first; agents that never ran sink to the bottom.
  const sorted = [...tiles].sort((a, b) => (b.last_activity_ts ?? 0) - (a.last_activity_ts ?? 0));
  grid.innerHTML = sorted.map(t => {
    const dotCls = tileDotClass(t);
    const dotTitle = tileDotTitle(t);
    const lastAct = t.last_activity_ts ? fmtRelativeSeconds(now - t.last_activity_ts) : 'never';
    const snippet = t.latest_conversation?.title?.trim();
    const snippetHtml = snippet
      ? `<div class="tile-snippet">${esc(snippet)}</div>`
      : `<div class="tile-snippet empty">no conversations yet</div>`;
    return `<div class="tile ${t.enabled ? '' : 'disabled'}" data-action="open-agent-panel" data-agent="${esc(t.id)}">
      <div class="tile-head">
        <span class="tile-dot ${dotCls}" title="${dotTitle}"></span>
        <span class="tile-name">${esc(t.id)}</span>
      </div>
      <div class="tile-meta">${esc(t.name)} · ${esc(t.model)}</div>
      ${snippetHtml}
      <div class="tile-stats">
        <span>${t.recent_24h} convo${t.recent_24h === 1 ? '' : 's'} / 24h</span>
        <span>· last ${lastAct}</span>
      </div>
    </div>`;
  }).join('');
}

/** State label for an OAuth-issued token row. */
function oauthTokenState(t, expired) {
  if (t.revoked_at) return 'revoked';
  return expired ? 'expired' : 'active';
}

/** Status-palette CSS class for an OAuth token row (revoked=error, expired=warn, active=info). */
function oauthTokenStateClass(t, expired) {
  if (t.revoked_at) return 'level-error';
  return expired ? 'level-warn' : 'level-info';
}

/** Render the software identification cell for an OAuth client row —
 *  software_id, optionally suffixed with @software_version, or "—" when
 *  the client didn't declare itself. Extracted so the table-row builder
 *  doesn't carry a nested ternary inside its template literal. */
function oauthClientSoftware(c) {
  if (!c.software_id) return '—';
  const v = c.software_version ? `@${esc(c.software_version)}` : '';
  return esc(c.software_id) + v;
}

/** Map an HTTP status code to the audit-table badge palette (4xx/5xx=error, 3xx=warn, 2xx=info). */
function statusBadgeClass(status) {
  if (status >= 400) return 'level-error';
  if (status >= 300) return 'level-warn';
  return 'level-info';
}

/** CSS class for a tile's status dot — disabled / active / idle. */
function tileDotClass(t) {
  if (!t.enabled) return 'off';
  return t.active ? 'active' : 'idle';
}

/** Tooltip text for a tile's status dot. */
function tileDotTitle(t) {
  if (!t.enabled) return 'disabled';
  return t.active ? 'active in last 90s' : 'idle';
}

function fmtRelativeSeconds(deltaSec) {
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

async function openAgentPanel(agentId) {
  panelAgentId = agentId;
  const panel = $('agent-panel');
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
  setPanelReadOnly(false);  // fresh open is always editable
  // Schedule a transcript-padding sync once the panel finishes animating in.
  requestAnimationFrame(syncTranscriptPadding);
  ensurePanelSse();
  ensurePanelApprovalSse();
  $('ap-id').textContent = agentId;
  $('ap-sub').textContent = 'loading…';
  $('ap-transcript').innerHTML = '<div class="ap-empty">loading…</div>';
  try {
    const def = await api('GET', `/admin/agents/${agentId}`);
    // Canonical (and only) human ↔ agent thread, get-or-created on the
    // server. This makes the panel never spawn an accidental new thread.
    const canonical = await api('GET', `/admin/api/agents/${encodeURIComponent(agentId)}/canonical-thread`);
    const summaries = { conversations: [{ id: canonical.id }] };
    panelConvoId = summaries.conversations[0]?.id ?? null;
    $('ap-dot').className = `tile-dot ${def.enabled ? 'idle' : 'off'}`;
    $('ap-sub').textContent = `${def.model} · ${def.runtime}:${def.provider}${def.enabled ? '' : ' · disabled'}`;
    panelModel = def.model;
    clearAttachments();
    updateAttachHint();
    await loadPanelTranscript();
    // Set the trigger label to the conversation's title (first user msg);
    // computed inside loadPanelTranscript so it has the messages in hand.
    setTimeout(() => $('ap-input').focus(), 100);
  } catch (e) {
    $('ap-transcript').innerHTML = `<div class="txt-err">failed: ${esc(e.message)}</div>`;
  }
}

async function loadPanelTranscript() {
  const t = $('ap-transcript');
  if (!panelConvoId) {
    t.innerHTML = '<div class="ap-empty">no messages yet — send something below.</div>';
    updateMetaFromMessages([]);
    return;
  }
  try {
    const { messages } = await api('GET', `/admin/api/conversations/${panelConvoId}`);
    renderTranscript(messages);
    updateMetaFromMessages(messages);
    await appendInlineApprovals();
  } catch (e) {
    t.innerHTML = `<div class="txt-err">${esc(e.message)}</div>`;
  }
}

// ---- inline approval cards in the chat panel --------------------------
// The chat panel opens its own approvals stream (filtered to the open
// thread) so a gated tool call the agent is waiting on shows up as a card
// right in the transcript — approve/reject without leaving the chat.
let panelApprovalAbort = null;
function ensurePanelApprovalSse() {
  if (panelApprovalAbort) return;
  panelApprovalAbort = new AbortController();
  sseFetch('/admin/api/approvals/stream', handlePanelApprovalEvent, panelApprovalAbort.signal);
}
function closePanelApprovalSse() {
  if (!panelApprovalAbort) return;
  panelApprovalAbort.abort();
  panelApprovalAbort = null;
}
function handlePanelApprovalEvent(ev) {
  const a = ev?.approval;
  if (!a || a.conversation_id !== panelConvoId) return;
  if (ev.kind === 'requested') {
    appendInlineApprovals();
  } else if (ev.kind === 'decided') {
    // Flip the inline card to a stamp in place; it clears on the next full
    // transcript reload when the agent's follow-up message arrives.
    const card = $('ap-transcript').querySelector(`.approval-card[data-approval-id="${a.id}"]`);
    if (card) card.outerHTML = approvalStampHtml(a);
  }
}
/** Refresh the inline pending-approval cards for the open thread. Cards live
 *  at the bottom of the transcript (the agent is blocked waiting on them). */
async function appendInlineApprovals() {
  if (!panelConvoId) return;
  const t = $('ap-transcript');
  t.querySelectorAll('.approval-card.inline').forEach(el => el.remove());
  try {
    const { approvals } = await api('GET', `/admin/api/approvals?conversation_id=${panelConvoId}`);
    for (const a of approvals) {
      t.insertAdjacentHTML('beforeend', approvalCardHtml(a, true));
    }
    t.scrollTop = t.scrollHeight;
  } catch { /* best-effort — the Approvals tab is the durable surface */ }
}

/** Derive a short, one-line title from the first user turn and stuff it
 *  into the trigger button. Falls back gracefully when the convo is empty. */
function computeConvoTitle(messages) {
  const firstUser = (messages || []).find(m => m.role === 'user');
  if (!firstUser) return '(empty)';
  const oneLine = String(firstUser.content).replace(/\s+/g, ' ').trim();
  return oneLine.length > 50 ? oneLine.slice(0, 47) + '…' : oneLine;
}
function updateMetaFromMessages(messages) {
  const title = computeConvoTitle(messages);
  $('ap-meta').textContent = panelReadOnly ? `${title} (read-only)` : title;
}

function renderTranscript(messages) {
  const t = $('ap-transcript');
  const visible = messages.filter(m => m.role !== 'system');
  if (!visible.length) {
    t.innerHTML = '<div class="ap-empty">no messages yet — send something below.</div>';
  } else {
    // Byline only when the caller is another *agent*. Everything else
    // (admin-ui, any MCP bearer token, etc.) is "you" — device doesn't
    // matter; the operator is one person.
    const agentIds = new Set((agentCache || []).map(a => a.id));
    t.innerHTML = visible.map(m => {
      const showByline = m.role === 'user' && m.caller_label && agentIds.has(m.caller_label);
      const byline = showByline
        ? `<div class="transcript-byline">${esc(m.caller_label)}</div>`
        : '';
      const atts = (m.attachments && m.attachments.length)
        ? `<div class="ap-msg-atts">${m.attachments.map(a =>
            `<img class="ap-att-img" data-action="zoom-attachment" src="data:${esc(a.media_type)};base64,${a.data}" alt="attachment">`).join('')}</div>`
        : '';
      return `<div class="ap-msg ${m.role}">${byline}${esc(m.content)}${atts}</div>`;
    }).join('');
  }
  // If a turn is currently in flight (here or in another tab), keep the
  // typing-dot bubble at the bottom of the transcript after every render.
  if (panelConvoId !== null && panelInFlight.has(panelConvoId)) {
    ensurePendingBubble();
  }
  t.scrollTop = t.scrollHeight;
}

function appendTranscript(role, content, attachmentUrls) {
  const t = $('ap-transcript');
  if (t.querySelector('.ap-empty')) t.innerHTML = '';
  const div = document.createElement('div');
  div.className = `ap-msg ${role}`;
  if (content) {
    const text = document.createElement('span');
    text.textContent = content;
    div.appendChild(text);
  }
  if (attachmentUrls && attachmentUrls.length) {
    const atts = document.createElement('div');
    atts.className = 'ap-msg-atts';
    for (const url of attachmentUrls) {
      const img = document.createElement('img');
      img.className = 'ap-att-img';
      img.src = url;
      img.alt = 'attachment';
      img.dataset.action = 'zoom-attachment';
      atts.appendChild(img);
    }
    div.appendChild(atts);
  }
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
  return div;
}

/** Ensure the bottom of the transcript shows a typing-dots bubble.
 *  Idempotent — multiple ask-start events for the same convo only ever
 *  produce one bubble. */
function ensurePendingBubble() {
  const t = $('ap-transcript');
  if (t.querySelector('.ap-msg.pending')) return;
  if (t.querySelector('.ap-empty')) t.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'ap-msg assistant pending';
  div.innerHTML = '<span class="ap-typing"><span></span><span></span><span></span></span>';
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
}

function removePendingBubble() {
  const t = $('ap-transcript');
  const pending = t.querySelector('.ap-msg.pending');
  if (pending) pending.remove();
}

// ---- image attachments (chat panel) ----------------------------------
const ATTACH_MAX = 4;
// Long-edge downscale cap, resolved per-agent from the panel's model. 1568px is
// the resolution ceiling for Sonnet 4.6 / Opus 4.6 & older (larger buys no
// fidelity — the API downsamples anyway); Opus 4.7/4.8 do high-res vision up to
// 2576px, so agents on those models get the sharper cap.
const ATTACH_MAX_EDGE_DEFAULT = 1568;
const ATTACH_MAX_EDGE_HIRES = 2576;
const ATTACH_MAX_B64 = 6_800_000;    // ~5MB binary; server enforces the same
function attachMaxEdge() {
  return /opus-4-[78]/.test(panelModel || '') ? ATTACH_MAX_EDGE_HIRES : ATTACH_MAX_EDGE_DEFAULT;
}
const ATTACH_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// Best-effort vision-capability guess. Unknown models default to "yes" so we
// don't nag; the warning only fires for models we're fairly sure are text-only.
const VISION_MODEL_RE = /claude|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|chatgpt-4o|o1|o3|o4|gemini|grok|llava|pixtral|qwen.*vl|llama.*vision|vision|moondream/i;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('failed to read image'));
    r.onload = () => {
      const s = String(r.result);
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.readAsDataURL(blob);
  });
}

// Decode → downscale to ATTACH_MAX_EDGE → re-encode, bounding the payload.
// GIFs pass through untouched so animation survives (canvas flattens them).
async function processImageFile(file) {
  if (!ATTACH_TYPES.includes(file.type)) {
    throw new Error('unsupported image type (png/jpeg/webp/gif only)');
  }
  if (file.type === 'image/gif') {
    const data = await blobToBase64(file);
    if (data.length > ATTACH_MAX_B64) throw new Error('gif too large (max ~5MB)');
    return { media_type: 'image/gif', data, url: `data:image/gif;base64,${data}` };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, attachMaxEdge() / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  // PNG stays PNG (screenshots, transparency); everything else → JPEG.
  const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const toBlob = (q) => new Promise(res => canvas.toBlob(res, outType, q));
  let blob = await toBlob(0.85);
  let data = blob ? await blobToBase64(blob) : '';
  if (data.length > ATTACH_MAX_B64 && outType === 'image/jpeg') {
    blob = await toBlob(0.6);                    // one retry at lower quality
    data = blob ? await blobToBase64(blob) : data;
  }
  if (!data) throw new Error('failed to encode image');
  if (data.length > ATTACH_MAX_B64) throw new Error('image too large after downscale (max ~5MB)');
  return { media_type: outType, data, url: `data:${outType};base64,${data}` };
}

async function addAttachmentFiles(files) {
  const list = Array.from(files || []).filter(f => f && f.type && f.type.startsWith('image/'));
  for (const f of list) {
    if (panelAttachments.length >= ATTACH_MAX) { toast(`max ${ATTACH_MAX} images per message`, 'err'); break; }
    try {
      panelAttachments.push(await processImageFile(f));
    } catch (e) {
      toast(e.message || 'could not attach image', 'err');
    }
  }
  renderAttachTray();
}

function renderAttachTray() {
  const tray = $('ap-attach-tray');
  if (!tray) return;
  if (!panelAttachments.length) {
    tray.classList.remove('show');
    tray.setAttribute('aria-hidden', 'true');
    tray.innerHTML = '';
    return;
  }
  tray.classList.add('show');
  tray.setAttribute('aria-hidden', 'false');
  tray.innerHTML = panelAttachments.map((a, i) =>
    `<div class="ap-attach-chip"><img src="${a.url}" alt="attachment ${i + 1}"><button type="button" data-action="remove-attachment" data-idx="${i}" title="remove">✕</button></div>`,
  ).join('');
}

function removeAttachment(idx) {
  panelAttachments.splice(idx, 1);
  renderAttachTray();
}

function clearAttachments() {
  panelAttachments = [];
  renderAttachTray();
}

function modelSupportsVision(model) {
  return !model || VISION_MODEL_RE.test(model); // unknown → assume capable
}

// Tap a transcript image to view it full-size in an overlay.
function openImageLightbox(src) {
  if (!src) return;
  closeImageLightbox();
  const back = document.createElement('div');
  back.className = 'ap-lightbox';
  back.dataset.action = 'close-lightbox';
  const img = document.createElement('img');
  img.src = src;
  back.appendChild(img);
  document.body.appendChild(back);
}

function closeImageLightbox() {
  document.querySelectorAll('.ap-lightbox').forEach(n => n.remove());
}

// Warn (don't block) when the panel's agent runs a model we think is text-only.
function updateAttachHint() {
  const hint = $('ap-attach-hint');
  if (!hint) return;
  const model = panelModel || ((agentCache || []).find(a => a.id === panelAgentId) || {}).model;
  if (model && !modelSupportsVision(model)) {
    hint.textContent = `heads up: ${model} may not be able to see images`;
    hint.classList.add('show');
    hint.setAttribute('aria-hidden', 'false');
  } else {
    hint.classList.remove('show');
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = '';
  }
}

async function sendPanelAsk() {
  if (panelAsking || !panelAgentId) return;
  const msg = $('ap-input').value.trim();
  // Allow an image-only turn (e.g. "look at this") — require text OR an image.
  if (!msg && !panelAttachments.length) return;
  panelAsking = true;
  $('ap-send').disabled = true;
  $('ap-input').value = '';
  // Snapshot + clear the pending images so the tray empties immediately and a
  // double-tap can't resend them. Restored into the tray if the send fails.
  const sentAttachments = panelAttachments;
  clearAttachments();
  // Optimistic user bubble so the operator sees their input land
  // instantly; the SSE 'message' event will reload the transcript
  // shortly with the canonical row. Typing dots are driven by the
  // server's ask-start SSE event (also covers other-tab + agent-to-
  // agent + telegram-bot callers).
  const optimisticBubble = appendTranscript('user', msg, sentAttachments.map(a => a.url));
  try {
    const body = { message: msg };
    if (panelConvoId) body.conversation_id = panelConvoId;
    if (sentAttachments.length) {
      body.attachments = sentAttachments.map(a => ({ media_type: a.media_type, data: a.data }));
    }
    const resp = await api('POST', `/admin/agents/${panelAgentId}/ask`, body);
    panelConvoId = resp.conversation_id;
    // If the trigger label was "(empty)" before the first turn, refresh
    // it now that the convo has a first user message to title with.
    if ($('ap-meta').textContent === '(empty)') {
      const { messages } = await api('GET', `/admin/api/conversations/${panelConvoId}`);
      updateMetaFromMessages(messages);
    }
  } catch (e) {
    // Send failed (typically: iOS Safari suspended the tab and killed
    // the in-flight fetch with TypeError: Load failed). Pull the
    // optimistic bubble + pending dots off, put the operator's text
    // back in the box so they can just tap Send again — losing their
    // message into the void is the worst failure mode here.
    optimisticBubble.remove();
    removePendingBubble();
    $('ap-input').value = msg;
    // Put the images back in the tray so the operator can just hit Send again.
    if (sentAttachments.length) { panelAttachments = sentAttachments; renderAttachTray(); }
    const friendly = /load failed|networkerror|failed to fetch/i.test(e.message)
      ? 'connection dropped — tap Send to retry'
      : `error: ${e.message}`;
    const errNode = document.createElement('div');
    errNode.className = 'ap-msg system';
    errNode.textContent = friendly;
    $('ap-transcript').appendChild(errNode);
    toast(friendly, 'err');
  } finally {
    panelAsking = false;
    $('ap-send').disabled = false;
    $('ap-input').focus();
  }
}

function closeAgentPanel() {
  const panel = $('agent-panel');
  panel.classList.remove('open');
  document.body.classList.remove('panel-open');
  panel.setAttribute('aria-hidden', 'true');
  closeConvoPicker();
  setPanelReadOnly(false);
  clearAttachments();
  closeImageLightbox();
  panelModel = null;
  panelAgentId = null;
  panelConvoId = null;
  closePanelSse();
  closePanelApprovalSse();
}

/** Open the conversation-events stream if not already open. Uses
 *  streaming fetch (not EventSource) so the admin token can ride in
 *  the X-Ritsu-Admin-Token header rather than leaking into the URL. */
function ensurePanelSse() {
  if (panelSseAbort) return;
  panelSseAbort = new AbortController();
  sseFetch('/admin/api/conversations/stream', handlePanelSseEvent, panelSseAbort.signal);
}

// Resume handler: iOS Safari (and to a lesser extent desktop browsers
// after a long sleep) suspends backgrounded tabs aggressively. In-flight
// fetches die with TypeError: Load failed; the streaming SSE connection
// either errors or, worse, sits there silently delivering no bytes. On
// every transition back to 'visible' with the panel open we (a) force-
// reconnect the SSE so we don't drift behind, and (b) reload the
// transcript so any out-of-band messages that landed while suspended
// (telegram, another tab, an agent-to-agent call) show up immediately.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!panelAgentId) return;
  closePanelSse();
  ensurePanelSse();
  loadPanelTranscript();
});

function closePanelSse() {
  if (!panelSseAbort) return;
  panelSseAbort.abort();
  panelSseAbort = null;
  panelInFlight.clear();
}

/** Apply a server-sent conversation event to the panel state. Most
 *  events are irrelevant (other agent's conversations, other threads
 *  with our agent); only ones matching panelConvoId reach the DOM. */
function handlePanelSseEvent(ev) {
  if (!panelAgentId) return;
  if (ev.conversation_id !== panelConvoId) return;
  if (ev.kind === 'message') {
    // Authoritative re-render from server state. Wipes any optimistic
    // bubbles + applies any out-of-band turns (telegram bot, MCP
    // caller, agent-to-agent, second browser tab).
    loadPanelTranscript();
  } else if (ev.kind === 'ask-start') {
    panelInFlight.add(ev.conversation_id);
    ensurePendingBubble();
  } else if (ev.kind === 'ask-end') {
    panelInFlight.delete(ev.conversation_id);
    // The matching 'message' event from the assistant turn already
    // re-rendered the transcript and dropped the pending bubble. If
    // ask-end arrived first (race), the upcoming message event will
    // clean it up; meanwhile remove the bubble eagerly so the dots
    // don't linger forever on errors.
    removePendingBubble();
  }
}

// ---- Conversation picker (slide-in chat panel) ------------------------
// Tapping the "conversation #N" label opens a popover listing other
// human-initiated conversations with this agent so the user can switch
// without leaving the chat surface. Agent-to-agent threads are
// deliberately excluded — those belong on the Conversations tab.
function closeConvoPicker() {
  const picker = $('ap-convo-picker');
  picker.classList.remove('open');
  picker.setAttribute('aria-hidden', 'true');
}
async function toggleConvoPicker(e) {
  e?.stopPropagation();
  const picker = $('ap-convo-picker');
  if (picker.classList.contains('open')) { closeConvoPicker(); return; }
  if (!panelAgentId) return;
  picker.innerHTML = '<div class="ap-convo-pick-empty">loading…</div>';
  picker.classList.add('open');
  picker.setAttribute('aria-hidden', 'false');
  try {
    // involves=agent picks up every thread the panel's agent is part of —
    // its canonical human thread plus every agent-to-agent thread where
    // it's caller or target.
    const { conversations } = await api(
      'GET',
      `/admin/api/conversations?involves=${encodeURIComponent(panelAgentId)}&kind=all&limit=50`,
    );
    if (!conversations.length) {
      picker.innerHTML = '<div class="ap-convo-pick-empty">No conversations yet.</div>';
      return;
    }
    picker.innerHTML = conversations.map(c => {
      const snippet = c.title ? esc(c.title) : '(empty)';
      const current = c.id === panelConvoId ? ' current' : '';
      const isAgentToAgent = !!c.caller_agent_id;
      // Relationship is the primary identification ("you ↔ X" or "X → Y").
      // The conversation's content snippet drops to the meta line.
      const relationship = isAgentToAgent
        ? `<code>${esc(c.caller_agent_id)}</code> → <code>${esc(c.agent_id)}</code>`
        : `you ↔ <code>${esc(c.agent_id)}</code>`;
      const tag = isAgentToAgent
        ? ' <span class="chip-inline">read-only</span>'
        : '';
      return `<button type="button" class="ap-convo-pick-item${current}" data-action="switch-panel-convo" data-cid="${c.id}" data-readonly="${isAgentToAgent ? '1' : '0'}">
        <div class="ap-convo-pick-title">${relationship}${tag}</div>
        <div class="ap-convo-pick-meta">${snippet} · ${c.message_count} msg${c.message_count === 1 ? '' : 's'} · ${fmtRelative(c.started_at)}</div>
      </button>`;
    }).join('');
  } catch (err) {
    picker.innerHTML = `<div class="ap-convo-pick-empty">error: ${esc(err.message)}</div>`;
  }
}
/** True while viewing an agent-to-agent thread from the slide-in panel:
 *  Send + textarea hidden so the human can't inject themselves mid-log.
 *  The .ap-meta-btn (picker trigger) stays visible so the user can switch
 *  back to a writable thread without having to close the whole panel. */
let panelReadOnly = false;
function setPanelReadOnly(on) {
  panelReadOnly = !!on;
  $('ap-ask-form').classList.toggle('read-only', !!on);
}
async function switchPanelConvo(cid, readOnly) {
  if (!panelAgentId) return;
  closeConvoPicker();
  clearAttachments();
  panelConvoId = cid;
  $('ap-meta').textContent = 'loading…';
  setPanelReadOnly(readOnly);
  $('ap-transcript').innerHTML = '<div class="ap-empty">loading…</div>';
  try {
    const { messages } = await api('GET', `/admin/api/conversations/${cid}`);
    renderTranscript(messages);
    updateMetaFromMessages(messages);
    syncTranscriptPadding();
  } catch (e) {
    $('ap-transcript').innerHTML = `<div class="ap-empty">error: ${esc(e.message)}</div>`;
  }
}

// ---- Conversations tab -----------------------------------------------
let convKind = 'human';  // 'human' (default) | 'agent'
async function loadConversationsTab() {
  await refreshConversationList();
  $('conv-refresh').onclick = refreshConversationList;
  $('conv-agent-filter').oninput = debounce(refreshConversationList, 200);
  // Wire the sub-tab toggle once. Default state is 'human'.
  document.querySelectorAll('.conv-kind-tab').forEach(btn => {
    btn.onclick = () => {
      const kind = btn.dataset.kind;
      if (kind === convKind) return;
      convKind = kind;
      document.querySelectorAll('.conv-kind-tab').forEach(b => {
        const active = b.dataset.kind === convKind;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      // Drop any open detail when switching — the open one may not be in the new set.
      $('conv-detail').classList.add('hidden');
      refreshConversationList();
    };
  });
}
async function refreshConversationList() {
  const agent = $('conv-agent-filter').value.trim();
  const qs = new URLSearchParams();
  if (agent) qs.set('agent_id', agent);
  qs.set('kind', convKind);
  try {
    const { conversations } = await api('GET', `/admin/api/conversations?${qs.toString()}`);
    renderConversationList(conversations);
  } catch (e) { toast(e.message, 'err'); }
}
function renderConversationList(list) {
  const target = $('conv-list');
  if (!list.length) {
    const msg = convKind === 'agent'
      ? 'No agent-to-agent conversations yet. They\'ll appear here once one agent calls another via mcp__agent_comms__ask_agent.'
      : 'No conversations.';
    target.innerHTML = `<em class="txt-muted">${msg}</em>`;
    return;
  }
  // In agent ↔ agent view, show the caller → target pairing instead of just the target id.
  const agentColHeader = convKind === 'agent' ? 'caller → target' : 'agent';
  const rows = list.map(c => {
    const agentCell = convKind === 'agent' && c.caller_agent_id
      ? `${glyphFor(c.caller_agent_id)}${esc(c.caller_agent_id)} → ${glyphFor(c.agent_id)}${esc(c.agent_id)}`
      : `${glyphFor(c.agent_id)}${esc(c.agent_id)}`;
    return `
    <tr>
      <td class="id-cell">${c.id}</td>
      <td>${agentCell}</td>
      <td class="wrap-ellipsis" title="${esc(c.title)}">${esc(c.title || '(empty)')}</td>
      <td title="${new Date(c.started_at * 1000).toISOString()}">${fmtRelative(c.started_at)}</td>
      <td>${c.message_count}</td>
      <td><button data-action="open-conversation" data-id="${c.id}" data-agent="${esc(c.agent_id)}" data-title="${esc(c.title || '')}">view</button></td>
    </tr>`;
  }).join('');
  target.innerHTML = `<table><thead><tr><th>id</th><th>${agentColHeader}</th><th>title</th><th>started</th><th>msgs</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
/** id of the conversation currently shown in the detail view (for Resume). */
let openConvId = null;
let openConvAgent = null;
async function openConversation(id, agentId, title) {
  try {
    const { messages } = await api('GET', `/admin/api/conversations/${id}`);
    openConvId = id; openConvAgent = agentId;
    $('conv-detail').classList.remove('hidden');
    const msgWord = messages.length === 1 ? 'message' : 'messages';
    const titleSuffix = title ? ` · ${esc(title)}` : '';
    $('conv-detail-title').innerHTML = `${glyphFor(agentId)}<code>${esc(agentId)}</code> · conversation ${id} · ${messages.length} ${msgWord}${titleSuffix}`;
    // Byline only when the caller is another agent. admin-ui / any MCP
    // bearer token = "you" with no byline; device labels aren't useful
    // for a single-operator setup.
    const agentIds = new Set((agentCache || []).map(a => a.id));
    $('conv-messages').innerHTML = messages.map(m => {
      const showByline = m.role === 'user' && m.caller_label && agentIds.has(m.caller_label);
      const byline = showByline
        ? `<span class="transcript-byline-inline">${esc(m.caller_label)}</span>`
        : '';
      return `
      <div class="convo-msg-card">
        <div class="convo-msg-meta">${esc(m.role)}${byline}</div>
        <div class="wrap-pre">${esc(m.content)}</div>
      </div>`;
    }).join('');
    // Hide the "Continue this conversation" panel when reading an agent-to-agent
    // thread — injecting a human turn into it would mix origins confusingly.
    $('conv-resume').classList.toggle('hidden', convKind === 'agent');
    $('resume-meta').textContent = '';
    $('resume-message').value = '';
  } catch (e) { toast(e.message, 'err'); }
}
async function resumeConversation() {
  if (!openConvId || !openConvAgent) return;
  const msg = $('resume-message').value.trim();
  if (!msg) return;
  $('resume-meta').textContent = 'sending…';
  try {
    const bearer = currentBearer();
    await api('POST', '/admin/api/mcp/call', {
      name: 'ask_agent',
      arguments: { agent_id: openConvAgent, message: msg, conversation_id: openConvId },
      ...(bearer ? { bearer } : {}),
    });
    // Re-load to show the new turn.
    await openConversation(openConvId, openConvAgent, '');
    toast('sent');
  } catch (e) { $('resume-meta').textContent = `error: ${e.message}`; }
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---- Memories tab ----------------------------------------------------
let memCache = [];   // cache of active memories so edit-memory can look up content by id
async function loadMemoriesTab() {
  try {
    const { agents } = await api('GET', '/admin/agents');
    const cur = $('mem-agent-pick').value;
    // glyph isn't representable in <option> text, but we can use the shape character
    $('mem-agent-pick').innerHTML = '<option value="">— pick —</option>' + agents.map(a =>
      `<option value="${esc(a.id)}" ${a.id===cur?'selected':''}>${glyphShape(a.id)}  ${esc(a.id)}</option>`,
    ).join('');
    $('mem-agent-pick').onchange = (e) => {
      if (e.target.value) { memAgentId = e.target.value; loadMemories(memAgentId); $('mem-seed-form').classList.remove('hidden'); }
      else { memAgentId = null; $('mem-list').innerHTML = 'pick an agent above…'; $('mem-seed-form').classList.add('hidden'); }
      $('mem-lineage').classList.add('hidden');
    };
    if (cur) { memAgentId = cur; loadMemories(cur); $('mem-seed-form').classList.remove('hidden'); }
  } catch (e) { toast(e.message, 'err'); }
}
/** id of the agent currently selected on the Memories tab. */
let memAgentId = null;

async function loadMemories(agentId) {
  try {
    const { memories } = await api('GET', `/admin/api/memories?agent_id=${encodeURIComponent(agentId)}`);
    memCache = memories;
    renderMemoryList(memories);
  } catch (e) { toast(e.message, 'err'); }
}
function renderMemoryList(list) {
  const target = $('mem-list');
  if (!list.length) { target.innerHTML = '<em class="txt-muted">No active memories for this agent. Add one below to seed.</em>'; return; }
  const rows = list.map(m => `
    <tr data-id="${m.id}">
      <td class="id-cell">${m.id}</td>
      <td>${fmtTime(new Date(m.created_at * 1000).toISOString())}</td>
      <td class="mem-content wrap-pre">${esc(m.content)}</td>
      <td class="row-actions">
        <button data-action="open-lineage" data-id="${m.id}">lineage</button>
        <button data-action="edit-memory" data-id="${m.id}">edit</button>
        <button class="danger" data-action="delete-memory" data-id="${m.id}">delete</button>
      </td>
    </tr>`).join('');
  target.innerHTML = `<table><thead><tr><th>id</th><th>created</th><th>content</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function seedMemory() {
  if (!memAgentId) return;
  const content = $('mem-seed-content').value.trim();
  if (!content) return;
  try {
    await api('POST', '/admin/api/memories', { agent_id: memAgentId, content });
    $('mem-seed-content').value = '';
    loadMemories(memAgentId);
    toast('memory saved');
  } catch (e) { toast(e.message, 'err'); }
}

async function editMemory(id, currentContent) {
  const updated = prompt('Replace this memory with:', currentContent);
  if (updated === null) return;
  const trimmed = updated.trim();
  if (!trimmed) { toast('content required', 'err'); return; }
  if (trimmed === currentContent.trim()) return;  // nothing to do
  try {
    await api('PATCH', `/admin/api/memories/${id}`, { content: trimmed });
    if (memAgentId) loadMemories(memAgentId);
    toast('memory updated (old version preserved in lineage)');
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteMemory(id) {
  if (!confirm(`Delete memory ${id}? It will be tombstoned (visible in lineage, hidden from active list).`)) return;
  try {
    await api('DELETE', `/admin/api/memories/${id}`);
    if (memAgentId) loadMemories(memAgentId);
    toast('memory deleted');
  } catch (e) { toast(e.message, 'err'); }
}
async function openLineage(memId) {
  try {
    const { lineage } = await api('GET', `/admin/api/memories/${memId}/lineage`);
    $('mem-lineage').classList.remove('hidden');
    $('mem-lineage-title').textContent = `lineage for memory ${memId} (${lineage.length} version${lineage.length===1?'':'s'})`;
    $('mem-lineage-list').innerHTML = lineage.map((m, i) => `
      <div class="lineage-card ${m.superseded_by ? 'dim' : ''}">
        <div class="convo-msg-meta">
          v${i+1} · id=${m.id} · ${fmtTime(new Date(m.created_at * 1000).toISOString())}
          ${m.superseded_by ? `<span class="badge ml-2">superseded by ${m.superseded_by}</span>` : '<span class="badge ml-2">active</span>'}
        </div>
        <div class="wrap-pre">${esc(m.content)}</div>
      </div>
    `).join('');
  } catch (e) { toast(e.message, 'err'); }
}

// ---- MCP tab ----------------------------------------------------------
// Static info page. Pulls tool summaries + URL + auth requirement from
// /admin/api/mcp-info (no live MCP call, no token required at view time).
// Connect snippets show what the operator pastes into their MCP client.
async function loadMcpTools() {
  try {
    const info = await api('GET', '/admin/api/mcp-info');
    $('mcp-url').textContent = info.url;
    $('mcp-auth-note').textContent = info.auth_required
      ? 'MCP auth is required — every request needs Authorization: Bearer rt_…'
      : 'MCP auth is currently open (no tokens minted). Mint one to lock it down.';
    $('mcp-tools').innerHTML = (info.tools ?? []).map(t => `
      <div class="tool-card">
        <div class="name">${esc(t.name)}</div>
        <div class="desc">${esc(t.summary)}</div>
        <div class="fs-md txt-muted mt-1">args: <code>${esc(t.args)}</code></div>
      </div>
    `).join('');
    $('snip-cc').textContent =
      `claude mcp add --transport http --scope user ritsu ${info.url} \\\n  --header "Authorization: Bearer rt_YOUR_TOKEN"`;
    $('snip-desktop').textContent = JSON.stringify({
      mcpServers: {
        ritsu: {
          command: '/opt/homebrew/bin/npx',
          args: ['-y', 'mcp-remote', info.url, '--header', 'Authorization: Bearer rt_YOUR_TOKEN'],
        },
      },
    }, null, 2);
    $('snip-curl').textContent =
      `curl -s -X POST ${info.url} \\\n  -H 'Authorization: Bearer rt_YOUR_TOKEN' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`;
  } catch (e) {
    $('mcp-tools').innerHTML = `<div class="txt-err">Failed to load: ${esc(e.message)}</div>`;
  }
}

// ---- channels ---------------------------------------------------------
let channelCache = [];
async function loadChannelsTab() {
  // Populate the operator-agent dropdown from the agent cache; the
  // Agents tab refresh already keeps `agentCache` warm.
  const opSel = $('ch-operator');
  const opts = (agentCache || []).map(a =>
    `<option value="${esc(a.id)}">${esc(a.id)}</option>`,
  ).join('');
  opSel.innerHTML = opts || '<option value="">(no agents yet — create one first)</option>';
  await refreshChannels();
}
async function refreshChannels() {
  try {
    const { channels } = await api('GET', '/admin/api/channels');
    channelCache = channels;
    renderChannels(channels);
  } catch (e) { toast(e.message, 'err'); }
}
function renderChannels(channels) {
  const target = $('ch-list');
  if (!channels.length) {
    target.innerHTML = '<em class="txt-muted">No channels yet. Add one below.</em>';
    return;
  }
  const rows = channels.map(c => {
    const cfg = c.config || {};
    const tokenPreview = typeof cfg.bot_token === 'string' ? esc(cfg.bot_token) : '—';
    const boundCell = typeof cfg.chat_id === 'number'
      ? `<code>${esc(String(cfg.chat_id))}</code>`
      : '<em class="txt-warn">(unbound — bot will reject everyone)</em>';
    return `
    <tr class="${c.enabled ? '' : 'disabled'}">
      <td class="id-cell">${esc(c.name)}</td>
      <td><span class="badge">${esc(c.kind)}</span></td>
      <td><code>${esc(c.operator_agent_id)}</code></td>
      <td><code>${tokenPreview}</code></td>
      <td>${boundCell}</td>
      <td>${c.enabled ? 'on' : 'off'}</td>
      <td class="row-actions">
        <button data-action="edit-channel" data-id="${c.id}">edit</button>
        <button data-action="toggle-channel" data-id="${c.id}" data-enabled="${c.enabled ? '0' : '1'}">${c.enabled ? 'disable' : 'enable'}</button>
        <button class="danger" data-action="delete-channel" data-id="${c.id}" data-name="${esc(c.name)}">delete</button>
      </td>
    </tr>`;
  }).join('');
  target.innerHTML = `<table><thead><tr><th>name</th><th>kind</th><th>operator</th><th>token</th><th>bound chat</th><th>state</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
/** Currently-loaded channel's bound chat_id, used by the recent-chats
 *  panel to mark which row is the active binding. */
let editingBoundChatId = null;
function loadChannelForm(c) {
  $('ch-id').value = c.id;
  $('ch-name').value = c.name;
  $('ch-name').readOnly = true;   // can't rename without delete+create
  $('ch-kind').value = c.kind;
  $('ch-kind').disabled = true;
  $('ch-operator').value = c.operator_agent_id;
  $('ch-token').value = '';
  $('ch-token').placeholder = 'leave blank to keep existing token';
  $('ch-enabled').checked = !!c.enabled;
  editingBoundChatId = typeof c.config?.chat_id === 'number' ? c.config.chat_id : null;
  $('ch-recent-wrap').classList.remove('hidden');
  refreshChannelRecentChats(c.id);
}
function clearChannelForm() {
  $('ch-id').value = '';
  $('ch-name').value = ''; $('ch-name').readOnly = false;
  $('ch-kind').disabled = false;
  $('ch-operator').selectedIndex = 0;
  $('ch-token').value = ''; $('ch-token').placeholder = '123456:ABC-DEF…';
  $('ch-enabled').checked = true;
  editingBoundChatId = null;
  $('ch-recent-wrap').classList.add('hidden');
  $('ch-recent').innerHTML = '—';
}
async function refreshChannelRecentChats(channelId) {
  const target = $('ch-recent');
  target.innerHTML = 'loading…';
  try {
    const { chats } = await api('GET', `/admin/api/channels/${channelId}/recent-chats`);
    if (!chats.length) {
      target.innerHTML = '<em class="txt-muted">No chats yet. DM the bot from your phone — it\'ll show up here.</em>';
      return;
    }
    target.innerHTML = chats.map(c => {
      const isBound = editingBoundChatId !== null && c.chat_id === editingBoundChatId;
      const who = c.username ? `@${esc(c.username)}` : `chat ${esc(String(c.chat_id))}`;
      const stateChip = isBound
        ? '<span class="badge ok-tint">bound</span>'
        : '';
      const action = isBound
        ? ''
        : `<button class="primary" data-action="bind-channel-chat" data-channel-id="${channelId}" data-chat-id="${c.chat_id}">Bind</button>`;
      return `
      <div class="ch-recent-row">
        <div class="flex1-min0">
          <div class="ch-recent-name">${who} ${stateChip} <span class="ch-recent-meta">${esc(c.chat_type)} · ${fmtRelative(c.seen_at)}</span></div>
          <div class="ch-recent-snippet">${esc(c.snippet || '(no text)')}</div>
        </div>
        <div>${action}</div>
      </div>`;
    }).join('');
  } catch (e) {
    target.innerHTML = `<em class="txt-err">${esc(e.message)}</em>`;
  }
}
async function bindChannelChat(channelId, chatId) {
  try {
    await api('POST', `/admin/api/channels/${channelId}/bind-chat`, { chat_id: chatId });
    editingBoundChatId = chatId;
    toast('bound');
    await refreshChannels();
    await refreshChannelRecentChats(channelId);
  } catch (e) { toast(e.message, 'err'); }
}
async function submitChannel() {
  const id = $('ch-id').value;
  const name = $('ch-name').value.trim();
  const kind = $('ch-kind').value;
  const operator = $('ch-operator').value;
  const token = $('ch-token').value.trim();
  const enabled = $('ch-enabled').checked;
  try {
    if (id) {
      // Editing — only operator + enabled + (optionally) a new token.
      // Chat binding is done separately via the "Bind" buttons in the
      // recent-chats panel, not via this form.
      const patch = { operator_agent_id: operator, enabled };
      if (token) patch.config = { bot_token: token, chat_id: editingBoundChatId };
      await api('PATCH', `/admin/api/channels/${id}`, patch);
      toast('updated');
    } else {
      if (!token) { toast('bot token required', 'err'); return; }
      // New channels start unbound; the user DMs the bot, then clicks Bind.
      await api('POST', '/admin/api/channels', {
        name, kind, operator_agent_id: operator,
        config: { bot_token: token, chat_id: null },
        enabled,
      });
      toast('created — now DM the bot and click Bind on the chat that appears');
    }
    clearChannelForm();
    refreshChannels();
  } catch (e) { toast(e.message, 'err'); }
}
async function toggleChannel(id, enabled) {
  try { await api('PATCH', `/admin/api/channels/${id}`, { enabled }); refreshChannels(); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteChannel(id, name) {
  if (!confirm(`Delete channel "${name}"? The bot will stop receiving messages immediately.`)) return;
  try { await api('DELETE', `/admin/api/channels/${id}`); refreshChannels(); }
  catch (e) { toast(e.message, 'err'); }
}

// ---- api keys ---------------------------------------------------------
async function loadClaudeToken() {
  const el = $('claude-token-state');
  if (!el) return;
  try {
    const d = await api('GET', '/admin/api/claude-token');
    const chip = d.token_set
      ? `<span class="hstat hstat-ok">token set</span> <code>${esc(d.token_hint || '')}</code>`
      : '<span class="hstat hstat-skip">no token stored</span>';
    // An env-provided token still works; say so, or clearing here looks broken.
    const envNote = d.env_fallback
      ? ' <span class="badge">CLAUDE_CODE_OAUTH_TOKEN also set in the service environment</span>'
      : '';
    el.innerHTML = chip + envNote;
  } catch (e) { el.textContent = e.message; }
}
async function saveClaudeToken() {
  const token = $('cs-token').value.trim();
  if (!token) { toast('paste a token first', 'err'); return; }
  try {
    await api('POST', '/admin/api/claude-token', { token });
    $('cs-token').value = '';   // never keep the secret in the DOM
    toast('saved — agents reloaded');
    loadClaudeToken();
  } catch (e) { toast(e.message, 'err'); }
}
async function clearClaudeToken() {
  if (!confirm('Clear the stored Claude session token? claude-direct agents stop working unless the service environment provides one.')) return;
  try {
    await api('DELETE', '/admin/api/claude-token');
    toast('cleared — agents reloaded');
    loadClaudeToken();
  } catch (e) { toast(e.message, 'err'); }
}

async function refreshApiKeys() {
  try {
    const { api_keys } = await api('GET', '/admin/api/api-keys');
    renderApiKeys(api_keys);
  } catch (e) { toast(e.message, 'err'); }
}
function renderApiKeys(keys) {
  const target = $('ak-list');
  if (!keys.length) {
    target.innerHTML = '<em class="txt-muted">No API keys yet. Mint one below.</em>';
    return;
  }
  const rows = keys.map(k => {
    const ageCell = k.revoked_at ? '' : ageBadge(k.created_at);
    return `
    <tr class="${k.revoked_at ? 'disabled' : ''}">
      <td class="id-cell">${esc(k.name)}</td>
      <td><span class="badge">${esc(k.provider)}</span></td>
      <td><code>${esc(k.prefix)}…</code></td>
      <td title="${k.created_at ? new Date(k.created_at * 1000).toISOString() : ''}">${fmtRelative(k.created_at)}</td>
      <td>${ageCell}</td>
      <td title="${k.last_used_at ? new Date(k.last_used_at * 1000).toISOString() : ''}">${fmtRelative(k.last_used_at)}</td>
      <td>${k.use_count}</td>
      <td>${k.revoked_at ? 'revoked' : 'active'}</td>
      <td class="row-actions">
        ${k.revoked_at
          ? `<button class="danger" data-action="delete-api-key" data-id="${k.id}">delete</button>`
          : `<button class="danger" data-action="revoke-api-key" data-id="${k.id}">revoke</button>`}
      </td>
    </tr>`;
  }).join('');
  target.innerHTML = `<table><thead><tr><th>name</th><th>provider</th><th>prefix</th><th>created</th><th>age</th><th>last used</th><th>uses</th><th>state</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
async function mintApiKey() {
  const name = $('ak-name').value.trim();
  const provider = $('ak-provider').value;
  const plaintext = $('ak-plaintext').value.trim();
  if (!name || !plaintext) { toast('name + plaintext required', 'err'); return; }
  try {
    const minted = await api('POST', '/admin/api/api-keys', { name, provider, plaintext });
    // Show plaintext exactly once; user must copy + dismiss.
    $('ak-minted-key').textContent = minted.plaintext;
    $('ak-minted-overlay').classList.add('open');
    $('ak-name').value = '';
    $('ak-plaintext').value = '';
    refreshApiKeys();
  } catch (e) { toast(e.message, 'err'); }
}
function closeMintedKeyModal() {
  $('ak-minted-overlay').classList.remove('open');
  $('ak-minted-key').textContent = '';
}
async function revokeApiKey(id) {
  if (!confirm('Revoke this API key? Agents using it will fail until they switch keys.')) return;
  try { await api('POST', `/admin/api/api-keys/${id}/revoke`); refreshApiKeys(); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteApiKey(id) {
  if (!confirm('Delete this revoked API key permanently?')) return;
  try { await api('DELETE', `/admin/api/api-keys/${id}`); refreshApiKeys(); }
  catch (e) { toast(e.message, 'err'); }
}
// Wire the API-key one-time-show modal's Copy button. The button is static
// HTML, so we can bind it once at script load instead of after every render.
{
  const copyBtnEl = $('ak-minted-copy');
  if (copyBtnEl) {
    copyBtnEl.addEventListener('click', async () => {
      const text = $('ak-minted-key').textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        copyBtnEl.textContent = 'copied!';
        setTimeout(() => { copyBtnEl.textContent = 'Copy'; }, 1500);
      } catch { toast('clipboard write failed — select + copy manually', 'err'); }
    });
  }
}

// ---- tokens -----------------------------------------------------------
async function refreshTokens() {
  try {
    const { tokens } = await api('GET', '/admin/api/tokens');
    renderTokens(tokens);
  } catch (e) { toast(e.message, 'err'); }
}
/** Age in days from a unix-seconds timestamp (or null when missing). Used
 *  by the Tokens + API Keys age badge — anything ≥180d wants rotating now,
 *  ≥90d is a softer nudge. The thresholds are conservative; long-lived
 *  bearers are the main token-leak risk we defend against (see THREAT_MODEL § A3). */
function ageDays(createdAtUnix) {
  if (!createdAtUnix) return null;
  return Math.floor((Date.now() / 1000 - createdAtUnix) / 86400);
}
function ageBadge(createdAtUnix) {
  const d = ageDays(createdAtUnix);
  if (d == null) return '';
  if (d < 90)  return `<span class="badge level-info" title="${d}d old — within rotation window">${d}d</span>`;
  if (d < 180) return `<span class="badge level-warn" title="${d}d old — consider rotating">${d}d</span>`;
  return                `<span class="badge level-error" title="${d}d old — rotate now">${d}d</span>`;
}

function renderTokens(tokens) {
  const target = $('token-list');
  if (!tokens.length) {
    target.innerHTML = '<em class="txt-muted">No tokens yet.</em>';
    return;
  }
  const rows = tokens.map(t => {
    const store = readTokenStore();
    const cached = store[String(t.id)];   // we have plaintext only for this session's mints
    const prefixCell = cached
      ? `<code>${esc(t.token_prefix)}…</code>${copyBtn(cached.token, 'copy token')}`
      : `<code>${esc(t.token_prefix)}…</code>${copyBtn(t.token_prefix, 'copy prefix')}`;
    const ageCell = t.revoked_at ? '' : ageBadge(t.created_at);
    return `
    <tr class="${t.revoked_at ? 'disabled' : ''}">
      <td class="id-cell">${esc(t.name)}</td>
      <td>${prefixCell}</td>
      <td title="${t.created_at ? new Date(t.created_at * 1000).toISOString() : ''}">${fmtRelative(t.created_at)}</td>
      <td>${ageCell}</td>
      <td title="${t.last_used_at ? new Date(t.last_used_at * 1000).toISOString() : ''}">${fmtRelative(t.last_used_at)}</td>
      <td>${t.use_count}</td>
      <td>${t.revoked_at ? 'revoked' : 'active'}</td>
      <td class="row-actions">
        ${t.revoked_at
          ? `<button class="danger" data-action="delete-token" data-id="${t.id}">delete</button>`
          : `<button class="danger" data-action="revoke-token" data-id="${t.id}">revoke</button>`}
      </td>
    </tr>`;
  }).join('');
  target.innerHTML = `<table><thead><tr><th>name</th><th>prefix</th><th>created</th><th>age</th><th>last used</th><th>uses</th><th>state</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
async function mintToken() {
  const name = $('f-token-name').value.trim();
  if (!name) return;
  try {
    const minted = await api('POST', '/admin/api/tokens', { name });
    $('f-token-name').value = '';
    // Cache plaintext in sessionStorage so the MCP try-it tab can use it.
    // Cleared when the browser tab closes. Survives reloads.
    rememberToken(minted.id, minted.name, minted.token);
    showMintedTokenModal(minted);
    refreshTokens(); refreshInfo();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- sessionStorage cache of plaintext tokens (for try-it only) ------
const TOKEN_STORE_KEY = 'ritsu.tokens';
function rememberToken(id, name, plaintext) {
  const store = readTokenStore();
  store[String(id)] = { name, token: plaintext };
  sessionStorage.setItem(TOKEN_STORE_KEY, JSON.stringify(store));
}
function forgetToken(id) {
  const store = readTokenStore();
  delete store[String(id)];
  sessionStorage.setItem(TOKEN_STORE_KEY, JSON.stringify(store));
}
function readTokenStore() {
  try { return JSON.parse(sessionStorage.getItem(TOKEN_STORE_KEY) || '{}'); }
  catch { return {}; }
}
function currentBearer() {
  // First non-revoked plaintext we have cached (this session's mints). The
  // resume-conversation handler passes it through /admin/api/mcp/call so
  // the call hits the MCP surface as the operator's MCP client would.
  const store = readTokenStore();
  for (const entry of Object.values(store)) {
    if (entry?.token) return entry.token;
  }
  return null;
}
function showMintedTokenModal(minted) {
  const root = $('modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-action="mint-modal-backdrop">
    <div class="modal">
      <h3>Token minted: ${esc(minted.name)}</h3>
      <p class="warn">⚠ This is the only time the plaintext token will be shown. Copy it now.</p>
      <pre id="token-plaintext">${esc(minted.token)}</pre>
      <div class="row-end mt-6">
        <button data-action="copy-mint-token">Copy</button>
        <button class="primary" data-action="close-mint-modal">I've saved it</button>
      </div>
    </div>
  </div>`;
}
function closeMintModal() { $('modal-root').innerHTML = ''; }
async function revokeToken(id) {
  if (!confirm('Revoke this token? Future MCP calls using it will be rejected.')) return;
  try { await api('POST', `/admin/api/tokens/${id}/revoke`); refreshTokens(); refreshInfo(); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteToken(id) {
  if (!confirm('Delete this revoked token? Frees the name for re-use.')) return;
  try { await api('DELETE', `/admin/api/tokens/${id}`); refreshTokens(); refreshInfo(); }
  catch (e) { toast(e.message, 'err'); }
}

// ---- logs -------------------------------------------------------------
let logStreamAbort = null;
let logPaused = false;
let logBuffer = [];   // raw events seen
const LOG_MAX = 500;
async function openLogStream() {
  if (logStreamAbort) return;
  // Initial backfill
  try {
    const { events } = await api('GET', '/admin/api/events/recent?limit=200');
    logBuffer = events.slice(-LOG_MAX);
    renderLogs();
  } catch (e) { toast(e.message, 'err'); }
  logStreamAbort = new AbortController();
  sseFetch('/admin/api/events/stream', (ev) => {
    if (logPaused) return;
    logBuffer.push(ev);
    if (logBuffer.length > LOG_MAX) logBuffer.shift();
    renderLogs();
  }, logStreamAbort.signal);
}
function closeLogStream() {
  if (logStreamAbort) { logStreamAbort.abort(); logStreamAbort = null; }
}
async function loadLogLevels() {
  const { level } = await api('GET', '/admin/api/log-level');
  const levels = ['debug', 'info', 'warn', 'error'];
  $('log-level').innerHTML = levels.map(l => `<option value="${l}" ${l===level?'selected':''}>${l}</option>`).join('');
  $('log-level').onchange = async (e) => {
    try { await api('POST', '/admin/api/log-level', { level: e.target.value }); toast(`log level: ${e.target.value}`); refreshInfo(); }
    catch (err) { toast(err.message, 'err'); }
  };
}
function renderLogs() {
  const msgFilter = $('log-filter-msg').value.toLowerCase();
  const agentFilter = $('log-filter-agent').value.toLowerCase();
  const visible = logBuffer.filter(e => {
    if (msgFilter && !String(e.msg ?? '').toLowerCase().includes(msgFilter)) return false;
    if (agentFilter) {
      const aid = String(e.agent_id ?? e.agent ?? e.id ?? '').toLowerCase();
      if (!aid.includes(agentFilter)) return false;
    }
    return true;
  });
  const rows = visible.map(e => {
    const { t, level, msg, ...extra } = e;
    const extraStr = Object.keys(extra).length ? JSON.stringify(extra) : '';
    return `<tr class="log-row">
      <td class="ts">${esc(fmtTime(t))}</td>
      <td class="level"><span class="badge level-${esc(level)}">${esc(level)}</span></td>
      <td class="msg">${esc(msg ?? '')}</td>
      <td class="extra">${esc(extraStr)}</td>
    </tr>`;
  }).join('');
  $('log-tbody').innerHTML = rows;
  if ($('log-autoscroll').checked) {
    const c = $('log-table');
    c.scrollTop = c.scrollHeight;
  }
}

// ---- tools tab --------------------------------------------------------
// Read-only "what tools does agent X actually have?" view. Combines:
//   1. tools_allowlist (built-in SDK tools, claude-sdk agents only)
//   2. MCP tools (in-process servers, gated by per-agent flags)
//   3. workspaces (the filesystem roots that back any FS-touching tool)
//
// MCP gating is derived client-side from the agent record to avoid a
// per-agent server round-trip. The gating rules MUST match what
// src/agent-host.ts actually wires up — if those rules drift, this view
// will lie. The mapping is captured below in MCP_TOOL_MAP; if you add
// or rename an MCP tool, update this table.
const MCP_TOOL_MAP = {
  memory: ['remember', 'update_memory', 'forget', 'list_memories'],
  agent_comms: ['ask_agent', 'list_agents'],
  agent_admin: ['create_agent', 'update_agent', 'reload_agent'],
  agent_monitor: ['list_agents', 'list_conversations', 'read_conversation', 'read_memory'],
  email: ['read_inbox', 'read_email', 'send_email'],
  social: ['read_mentions', 'read_my_posts', 'post_tweet', 'post_linkedin'],
  scheduler: ['schedule_create', 'schedule_list', 'schedule_remove', 'schedule_pause'],
};

/** The two runtimes name the same tool differently: the direct runtime reaches
 *  them over MCP (mcp__memory__remember), the api runtime as native function
 *  calls (memory_remember). Rendering one naming for both is a lie an operator
 *  copies into approval_tools, where it silently matches nothing. */
function toolName(runtime, server, tool) {
  if (runtime === 'api') return server === 'scheduler' ? tool : `${server}_${tool}`;
  return `mcp__${server}__${tool}`;
}

function deriveAgentTools(agent, pluginManifests = []) {
  // Memory + agent_comms are always wired (every agent gets them at host
  // construction). Everything else is capability- or allowlist-gated.
  const caps = new Set(agent.capabilities || []);
  const groups = [
    { server: 'memory', tools: MCP_TOOL_MAP.memory, note: `memory backend: ${agent.memory_backend}` },
    {
      server: 'agent_comms',
      tools: MCP_TOOL_MAP.agent_comms,
      note: (agent.can_call || []).length
        ? `can_call: ${agent.can_call.join(', ')}`
        : '(can_call empty — ask_agent has no allowed targets)',
    },
    { server: 'scheduler', tools: MCP_TOOL_MAP.scheduler, note: 'suppressed inside a scheduled run' },
    ...(caps.has('manage_agents')
      ? [{ server: 'agent_admin', tools: MCP_TOOL_MAP.agent_admin, note: 'capability: manage_agents' }]
      : []),
    ...(caps.has('monitor_agents')
      ? [{ server: 'agent_monitor', tools: MCP_TOOL_MAP.agent_monitor, note: 'capability: monitor_agents' }]
      : []),
    ...(caps.has('crm')
      ? [{ server: 'email', tools: MCP_TOOL_MAP.email, note: 'capability: crm — send_email always needs approval' }]
      : []),
    ...(caps.has('social')
      ? [{ server: 'social', tools: MCP_TOOL_MAP.social, note: 'capability: social — posting always needs approval' }]
      : []),
  ].map(g => ({
    label: `${toolName(agent.runtime, g.server, '*')}`,
    note: g.note,
    names: g.tools.map(t => toolName(agent.runtime, g.server, t)),
  }));
  // Plugins are always mcp__<id>__<tool> on both runtimes — the native loop
  // exposes plugin tools under the same names.
  for (const id of agent.plugins || []) {
    const manifest = pluginManifests.find(p => p.id === id);
    if (!manifest) continue;
    groups.push({
      label: `mcp__${id}__*`,
      note: `plugin: ${manifest.name || id}`,
      names: manifest.mcpTools || [],
    });
  }
  return { builtin: agent.tools_allowlist || [], groups };
}

let toolsAgentId = null;
async function loadToolsTab() {
  try {
    const { agents } = await api('GET', '/admin/agents');
    const cur = $('tools-agent-pick').value;
    $('tools-agent-pick').innerHTML = '<option value="">— pick —</option>' + agents.map(a =>
      `<option value="${esc(a.id)}" ${a.id === cur ? 'selected' : ''}>${glyphShape(a.id)}  ${esc(a.id)}</option>`,
    ).join('');
    $('tools-agent-pick').onchange = (e) => {
      toolsAgentId = e.target.value || null;
      if (toolsAgentId) renderToolsFor(toolsAgentId);
      else $('tools-view').innerHTML = '<em class="txt-muted">pick an agent above…</em>';
    };
    if (cur) { toolsAgentId = cur; renderToolsFor(cur); }
  } catch (e) { toast(e.message, 'err'); }
}

async function renderToolsFor(agentId) {
  const target = $('tools-view');
  target.innerHTML = 'loading…';
  try {
    // Pull the full agent record (definitive over agentCache, which omits
    // some derived fields on its list payload), plus the workspaces.
    const [agent, wsResp, plugResp] = await Promise.all([
      api('GET', `/admin/agents/${encodeURIComponent(agentId)}`),
      api('GET', `/admin/agents/${encodeURIComponent(agentId)}/workspaces`).catch(() => ({ workspaces: [] })),
      api('GET', '/admin/api/plugins').catch(() => ({ plugins: [] })),
    ]);
    const { builtin, groups } = deriveAgentTools(agent, plugResp.plugins || []);
    const wsList = wsResp.workspaces || [];

    const builtinSection = builtin.length
      ? builtin.map(t => `<span class="badge accent-tint">${esc(t)}</span>`).join('')
      : '<em class="txt-muted">(none — agent has no built-in SDK tools allowlisted)</em>';

    const mcpSection = groups.map(g => `
      <div class="mb-4">
        <div class="fw-600">${esc(g.label)}
          <span class="panel-sub-label ml-2">${esc(g.note)}</span>
        </div>
        <div class="mt-1">
          ${g.names.map(n => `<code class="mr-3 fs-md">${esc(n)}</code>`).join('')}
        </div>
      </div>
    `).join('');

    const wsSection = wsList.length
      ? `<table class="mt-3"><thead><tr><th>path</th><th>permissions</th><th></th></tr></thead><tbody>${
          wsList.map((w, i) => `
            <tr>
              <td class="id-cell">${esc(w.path)}</td>
              <td>${(w.permissions || []).map(p => `<span class="badge">${esc(p)}</span>`).join(' ')}</td>
              <td>${i === 0 ? '<span class="badge" title="lowest id is used as cwd">cwd</span>' : ''}</td>
            </tr>`).join('')
        }</tbody></table>`
      : '<em class="txt-muted">(none — FS-touching tools will fail at runtime)</em>';

    // Surface the runtime tier next to the tool inventory so the
    // plan-vs-metered distinction is unambiguous from here.
    const runtime = agent.runtime === 'api'
      ? `api (${esc(agent.provider)}, metered)`
      : `direct (${esc(agent.provider)}, plan)`;

    target.innerHTML = `
      <div class="tools-summary-line">
        ${glyphFor(agent.id)}<code>${esc(agent.id)}</code>
        <span class="txt-muted ml-3">runtime: ${runtime} · model: <code>${esc(agent.model)}</code></span>
      </div>
      <div class="panel panel-nested">
        <h2>Built-in SDK tools <span class="fw-400 tt-none txt-muted fs-sm">(claude-sdk allowlist)</span></h2>
        <div>${builtinSection}</div>
      </div>
      <div class="panel panel-nested">
        <h2>MCP tools <span class="fw-400 tt-none txt-muted fs-sm">(in-process)</span></h2>
        ${mcpSection}
      </div>
      <div class="panel panel-nested">
        <h2>Workspaces</h2>
        ${wsSection}
      </div>
    `;
  } catch (e) {
    target.innerHTML = `<div class="txt-err">failed: ${esc(e.message)}</div>`;
  }
}

// ---- OAuth clients tab ------------------------------------------------
// Operator view over the OAuth 2.1 + DCR client registry. Clients
// self-register via POST /oauth/register; this surface is read +
// revoke-only. revokeClient on the backend cascades to all of the
// client's live access + refresh tokens.
async function loadOAuthClientsTab() {
  try {
    const { clients } = await api('GET', '/admin/api/oauth/clients');
    renderOAuthClients(clients);
    // Collapse any previously-open per-client detail.
    $('oauth-client-detail').classList.add('hidden');
  } catch (e) { toast(e.message, 'err'); }
}

function renderOAuthClients(list) {
  const target = $('oauth-client-list');
  if (!list.length) {
    target.innerHTML = '<em class="txt-muted">No OAuth clients registered. Spec-compliant clients (claude.ai web, Claude Desktop Connectors) self-register via POST /oauth/register the first time they connect.</em>';
    return;
  }
  const rows = list.map(c => {
    const tc = c.token_counts || { access_active: 0, access_total: 0, refresh_active: 0, refresh_total: 0 };
    const sw = oauthClientSoftware(c);
    const redirects = (c.redirect_uris || [])
      .map(u => `<code class="fs-md">${esc(u)}</code>`).join('<br>');
    return `<tr class="${c.revoked_at ? 'disabled' : ''}">
      <td class="id-cell">${esc(c.client_name)}</td>
      <td><code class="fs-md">${esc(c.client_id.slice(0, 16))}…</code> ${copyBtn(c.client_id, 'copy id')}</td>
      <td>${redirects || '—'}</td>
      <td>${sw}</td>
      <td title="${new Date(c.created_at * 1000).toISOString()}">${fmtRelative(c.created_at)}</td>
      <td>${tc.access_active} / ${tc.access_total}</td>
      <td>${tc.refresh_active} / ${tc.refresh_total}</td>
      <td>${c.revoked_at ? 'revoked' : 'active'}</td>
      <td class="row-actions">
        <button data-action="oauth-client-tokens" data-client="${esc(c.client_id)}">tokens</button>
        ${c.revoked_at
          ? ''
          : `<button class="danger" data-action="revoke-oauth-client" data-client="${esc(c.client_id)}" data-name="${esc(c.client_name)}">revoke</button>`}
      </td>
    </tr>`;
  }).join('');
  target.innerHTML = `<table>
    <thead><tr>
      <th>name</th><th>client_id</th><th>redirect_uris</th><th>software</th>
      <th>created</th><th>access (live/total)</th><th>refresh (live/total)</th>
      <th>state</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function openOAuthClientTokens(clientId) {
  const detail = $('oauth-client-detail');
  detail.classList.remove('hidden');
  detail.innerHTML = 'loading…';
  try {
    const { tokens } = await api('GET', `/admin/api/oauth/clients/${encodeURIComponent(clientId)}/tokens`);
    if (!tokens.length) {
      detail.innerHTML = `<h3 class="section-title">tokens for <code>${esc(clientId.slice(0, 16))}…</code></h3>
        <em class="txt-muted">No tokens issued yet for this client.</em>`;
      return;
    }
    const now = Date.now() / 1000;
    const rows = tokens.map(t => {
      const expired = t.expires_at < now;
      const state = oauthTokenState(t, expired);
      const cls = oauthTokenStateClass(t, expired);
      return `<tr>
        <td><span class="badge">${esc(t.kind)}</span></td>
        <td><code class="fs-md">${esc(t.token_hash.slice(0, 16))}…</code></td>
        <td>${esc(t.scope)}</td>
        <td><code class="fs-md">${esc(t.resource)}</code></td>
        <td title="${new Date(t.expires_at * 1000).toISOString()}">${fmtRelative(t.expires_at)}</td>
        <td><span class="badge ${cls}">${state}</span></td>
      </tr>`;
    }).join('');
    detail.innerHTML = `<h3 class="section-title">tokens for <code>${esc(clientId.slice(0, 16))}…</code></h3>
      <table><thead><tr>
        <th>kind</th><th>token_hash</th><th>scope</th><th>resource</th><th>expires</th><th>state</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) {
    detail.innerHTML = `<em class="txt-err">failed: ${esc(e.message)}</em>`;
  }
}

async function revokeOAuthClient(clientId, clientName) {
  if (!confirm(`Revoke OAuth client "${clientName}" (${clientId})?\nThis also revokes ALL of its live access + refresh tokens (cascade is automatic).`)) return;
  try {
    await api('POST', `/admin/api/oauth/clients/${encodeURIComponent(clientId)}/revoke`);
    toast('client revoked');
    loadOAuthClientsTab();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- audit tab --------------------------------------------------------
// Read-only view of the admin_audit table. Mutating admin API calls
// (POST/PATCH/DELETE) get a row each; GETs don't. Server returns the
// full set (up to 500 rows) and the client filters in-memory so typing
// in a filter is instant.
let auditCache = [];
async function loadAuditTab() {
  try {
    const { audit } = await api('GET', '/admin/api/audit?limit=500');
    auditCache = audit;
    renderAudit();
  } catch (e) { toast(e.message, 'err'); }
}
function renderAudit() {
  const pathF   = ($('audit-filter-path')?.value || '').toLowerCase();
  const tokenF  = ($('audit-filter-token')?.value || '').toLowerCase();
  const methodF = $('audit-filter-method')?.value || '';
  const visible = auditCache.filter(r => {
    if (pathF && !String(r.path ?? '').toLowerCase().includes(pathF)) return false;
    if (tokenF && !String(r.token_name ?? '').toLowerCase().includes(tokenF)) return false;
    if (methodF && r.method !== methodF) return false;
    return true;
  });
  $('audit-tbody').innerHTML = visible.map(r => {
    const tokenCell = r.token_name
      ? esc(r.token_name)
      : '<em class="txt-muted">—</em>';
    // Reuse the existing log-level badge palette: 2xx=info, 3xx=warn, 4xx/5xx=error.
    const statusCls = statusBadgeClass(r.status);
    const time    = fmtTime(new Date(r.ts * 1000).toISOString());
    const fullIso = new Date(r.ts * 1000).toISOString();
    const sha     = r.body_sha256 ? ` · body sha256:${r.body_sha256.slice(0, 16)}…` : '';
    return `<tr class="log-row">
      <td class="ts" title="${esc(fullIso + sha)}">${esc(time)}</td>
      <td>${tokenCell}</td>
      <td><code class="fs-md">${esc(r.ip ?? '—')}</code></td>
      <td>${esc(r.method)}</td>
      <td><code>${esc(r.path)}</code></td>
      <td><span class="badge ${statusCls}">${r.status}</span></td>
      <td>${r.duration_ms ?? '—'}</td>
    </tr>`;
  }).join('');
}

// ---- approvals (human-in-the-loop) ------------------------------------
// A gated tool call blocks the agent's turn on a pending row server-side.
// The operator approves/rejects here (the Approvals tab) or inline in the
// chat panel — both share the same endpoints + the /approvals/stream SSE.
// The nav badge stays live on EVERY tab via a global stream opened at boot.
let approvalsSubtab = 'pending';
let approvalsSseAbort = null;

/** Open the global approvals stream once. Keeps the nav badge + (if shown)
 *  the Approvals list live regardless of which tab is active. */
function ensureApprovalsSse() {
  if (approvalsSseAbort) return;
  approvalsSseAbort = new AbortController();
  sseFetch('/admin/api/approvals/stream', handleApprovalsSseEvent, approvalsSseAbort.signal);
}

function handleApprovalsSseEvent(ev) {
  refreshApprovalBadge();
  if (activeTab === 'approvals') loadApprovalsList();
  // The chat panel handles its own inline copy via the same stream
  // (handlePanelApprovalEvent) when it's open.
}

async function refreshApprovalBadge() {
  try {
    const { pending } = await api('GET', '/admin/api/approvals/count');
    setApprovalBadge(pending);
  } catch { /* badge is best-effort */ }
}

function setApprovalBadge(n) {
  const el = $('nav-approvals-badge');
  if (!el) return;
  el.textContent = String(n);
  el.classList.toggle('hidden', !n);
}

function loadApprovalsTab() {
  ensureApprovalsSse();
  loadApprovalsList();
}

function setApprovalsSubtab(sub) {
  approvalsSubtab = sub;
  document.querySelectorAll('#approvals-subtabs .conv-kind-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.sub === sub));
  loadApprovalsList();
}

async function loadApprovalsList() {
  const target = $('approvals-list');
  if (!target) return;
  try {
    if (approvalsSubtab === 'blocked') {
      const { denials } = await api('GET', '/admin/api/comms-denials?limit=200');
      renderDenialsList(denials);
      $('approvals-summary').textContent = denials.length
        ? `${denials.length} blocked inter-agent call${denials.length === 1 ? '' : 's'} — refused by a guard, not a lying agent.`
        : 'No blocked calls.';
      return;
    }
    const { approvals } = await api('GET', `/admin/api/approvals?state=${approvalsSubtab}&limit=200`);
    renderApprovalsList(approvals);
    if (approvalsSubtab === 'pending') {
      setApprovalBadge(approvals.length);
      $('approvals-summary').textContent = approvals.length
        ? `${approvals.length} tool call${approvals.length === 1 ? '' : 's'} waiting on your sign-off.`
        : 'Nothing waiting — every agent is unblocked.';
    } else {
      $('approvals-summary').textContent = 'Recently approved / rejected.';
    }
  } catch (e) {
    target.innerHTML = `<div class="txt-err">${esc(e.message)}</div>`;
  }
}

function renderApprovalsList(list) {
  const target = $('approvals-list');
  if (!list.length) {
    target.innerHTML = approvalsSubtab === 'pending'
      ? '<div class="ap-empty">No pending approvals — nothing needs you right now.</div>'
      : '<div class="ap-empty">No decisions yet.</div>';
    return;
  }
  target.innerHTML = list.map(a => a.state === 'pending'
    ? approvalCardHtml(a)
    : approvalStampHtml(a)).join('');
}

/** Blocked inter-agent calls (ask_agent refused by a guard). Previously these
 *  were invisible — a denied call writes no transcript message, only a log
 *  line — so this is the surface that makes them visible. */
function renderDenialsList(denials) {
  const target = $('approvals-list');
  if (!denials.length) {
    target.innerHTML = '<div class="ap-empty">No blocked calls — no agent has been refused an inter-agent call.</div>';
    return;
  }
  target.innerHTML = denials.map(denialRowHtml).join('');
}

function denialReasonLabel(r) {
  return ({
    not_in_allowlist: 'not in allowlist',
    escalation: 'capability escalation',
    cycle: 'call cycle',
    depth: 'call depth',
    inflight: 'too many in flight',
  })[r] || r;
}

function denialRowHtml(d) {
  const cls = d.reason === 'escalation' ? ' denial-escalation' : '';
  const detail = d.detail ? `<span class="denial-detail">${esc(d.detail)}</span>` : '';
  const msg = d.message
    ? `<div class="denial-msg" title="${esc(d.message)}">“${esc(d.message.length > 240 ? d.message.slice(0, 240) + '…' : d.message)}”</div>`
    : '';
  return `<div class="denial-row${cls}">`
    + `<div class="denial-head">`
    +   `<span class="denial-x">✗</span>`
    +   `<span class="denial-pair"><code>${esc(d.caller)}</code> → <code>${esc(d.target)}</code></span>`
    +   `<span class="denial-reason">${esc(denialReasonLabel(d.reason))}</span>`
    +   detail
    +   `<span class="denial-ago">${approvalAgo(d.created_at)}</span>`
    + `</div>`
    + msg
    + `</div>`;
}

/** Glyph for an approval, by tool name — quick visual recognition. */
function approvalToolIcon(tool) {
  const t = (tool || '').toLowerCase();
  if (t.includes('bash') || t.includes('exec')) return '⌘';      // ⌘
  if (t.includes('write') || t.includes('edit')) return '✎';     // ✎
  if (t.includes('web') || t.includes('fetch') || t.includes('search')) return '🌐'; // 🌐
  if (t.includes('mail') || t.includes('email')) return '✉️'; // ✉️
  return '⚙️'; // ⚙️
}

/** Staleness class — drives the row tint. No auto-reject; visibility scales
 *  with neglect. */
function approvalStaleClass(a) {
  const age = Math.floor(Date.now() / 1000) - a.requested_at;
  if (age > 7 * 86400) return 'stale-7d';
  if (age > 86400) return 'stale-24h';
  if (age > 4 * 3600) return 'stale-4h';
  return '';
}

function approvalAgo(ts) {
  return fmtRelativeSeconds(Math.max(0, Math.floor(Date.now() / 1000) - ts));
}

function approvalArgsPreview(argsJson) {
  try {
    return esc(JSON.stringify(JSON.parse(argsJson), null, 2));
  } catch {
    return esc(String(argsJson));
  }
}

function approvalTruncate(s, n) {
  return s.length > n ? esc(s.slice(0, n)) + '<span class="txt-muted">… (' + (s.length - n) + ' more)</span>' : esc(s);
}

/**
 * Render a string with every non-ASCII / control character made VISIBLE,
 * tagged with its U+ code point. A spoofed recipient like "support@hdе.io"
 * (Cyrillic е) or one carrying bidi/zero-width controls renders identically to
 * the real thing in plain text — this unmasks it so the operator can't be
 * tricked into approving a send to an attacker domain. Returns { html, bad }.
 */
function approvalUnmask(s) {
  let bad = false;
  const html = [...String(s)].map(ch => {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp > 0x7e) {
      bad = true;
      const u = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
      return `<span class="ap-bad-char" title="${u}">${esc(ch)}[${u}]</span>`;
    }
    return esc(ch);
  }).join('');
  return { html, bad };
}

/**
 * Pull the security-critical fields out of an approval's args so they show on
 * the card by DEFAULT (no "show details" click). The destination of an
 * irreversible action — email recipient, post text, target agent — is exactly
 * what the operator must see before approving; hiding it behind a toggle is
 * how you get a one-click approval of something you never read.
 */
function approvalHighlights(a) {
  let args;
  try { args = JSON.parse(a.args_json); } catch { return []; }
  if (!args || typeof args !== 'object') return [];
  const t = (a.tool_name || '').toLowerCase();
  const rows = [];
  const add = (label, value, critical = false) => {
    if (value === undefined || value === null || value === '') return;
    const { html, bad } = approvalUnmask(typeof value === 'string' ? value : JSON.stringify(value));
    rows.push({ label, html, bad, critical });
  };
  if (t.includes('email')) {
    add('To', args.to, true);
    add('Subject', args.subject);
    rows.push({ label: 'Body', html: approvalTruncate(String(args.body ?? ''), 400), bad: false });
  } else if (t.includes('tweet') || t.includes('linkedin') || t.includes('post')) {
    rows.push({ label: 'Post', html: approvalTruncate(String(args.text ?? ''), 400), bad: false, critical: true });
  } else if (t.includes('ask_agent')) {
    add('To agent', args.agent_id, true);
    rows.push({ label: 'Message', html: approvalTruncate(String(args.message ?? ''), 400), bad: false });
  } else {
    for (const [k, v] of Object.entries(args).slice(0, 4)) {
      add(k, typeof v === 'string' ? v : JSON.stringify(v), false);
    }
  }
  return rows;
}

function approvalHighlightsHtml(a) {
  const rows = approvalHighlights(a);
  if (!rows.length) return '';
  const anyBad = rows.some(r => r.bad);
  const warn = anyBad
    ? '<div class="ap-spoof-warn">⚠ Non-standard characters in a field below — possible spoofing. Verify before approving.</div>'
    : '';
  const body = rows.map(r =>
    `<div class="ap-hl-row ${r.critical ? 'critical' : ''} ${r.bad ? 'bad' : ''}">` +
      `<span class="ap-hl-label">${esc(r.label)}</span>` +
      `<span class="ap-hl-val">${r.html}</span>` +
    `</div>`).join('');
  return `${warn}<div class="approval-highlights">${body}</div>`;
}

/** A pending approval card. Used on the Approvals page AND inline in the
 *  chat panel — handlers find their card via closest('.approval-card') so
 *  there are no duplicate-id collisions when the same approval shows in
 *  both places. */
/** If this approval is a capability escalation (carries the _escalation marker
 *  the comms guard adds to args), return the escalated capabilities; else null. */
function approvalEscalationInfo(argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const caps = args && args._escalation && args._escalation.capabilities;
    return Array.isArray(caps) ? caps : null;
  } catch {
    return null;
  }
}

function approvalCardHtml(a, inline = false) {
  const escCaps = approvalEscalationInfo(a.args_json);
  const escBanner = escCaps
    ? `<div class="approval-escalation-banner">⚠ capability escalation — approving lets <code>${esc(a.agent_id)}</code> act through an agent holding <strong>${esc(escCaps.join(', '))}</strong> it doesn't have. Only approve if you mean to.</div>`
    : '';
  return `<div class="approval-card ${inline ? 'inline' : ''} ${approvalStaleClass(a)}${escCaps ? ' escalation' : ''}" data-approval-id="${a.id}">
    ${escBanner}
    <div class="approval-main">
      <span class="approval-icon">${approvalToolIcon(a.tool_name)}</span>
      <div class="approval-body">
        <div class="approval-title">${esc(a.tool_name)}</div>
        <div class="approval-meta">${esc(a.agent_id)} · ${approvalAgo(a.requested_at)}</div>
        ${approvalHighlightsHtml(a)}
        <button type="button" class="approval-detail-toggle" data-action="toggle-approval-detail">▸ raw args</button>
        <pre class="approval-detail hidden">${approvalArgsPreview(a.args_json)}</pre>
        <textarea class="approval-reason hidden" placeholder="reason (optional — sent to the agent on reject)" rows="2"></textarea>
      </div>
    </div>
    <div class="approval-actions">
      <button type="button" class="primary" data-action="approve-approval">Approve</button>
      <button type="button" class="danger" data-action="reject-approval">Reject</button>
    </div>
  </div>`;
}

/** A decided approval — compact audit stamp. */
function approvalStampHtml(a) {
  const ok = a.state === 'approved';
  const reason = a.reason ? ` · “${esc(a.reason)}”` : '';
  return `<div class="approval-stamp ${ok ? 'ok' : 'rej'}">
    <span class="approval-stamp-mark">${ok ? '✓ approved' : '✗ rejected'}</span>
    <span class="approval-stamp-body">${esc(a.tool_name)} · ${esc(a.agent_id)}${reason}</span>
    <span class="approval-when">${approvalAgo(a.decided_at || a.requested_at)}</span>
  </div>`;
}

/** Approve (one click) or reject (two-step: first click reveals the reason
 *  box + relabels, second click submits). cardEl scopes the lookups. */
function approveApprovalClick(cardEl) {
  const id = Number(cardEl?.dataset.approvalId);
  if (!id) return;
  decideApproval(id, 'approved', '', cardEl);
}
function rejectApprovalClick(cardEl) {
  const id = Number(cardEl?.dataset.approvalId);
  if (!id) return;
  if (!cardEl.classList.contains('rejecting')) {
    cardEl.classList.add('rejecting');
    const r = cardEl.querySelector('.approval-reason');
    if (r) { r.classList.remove('hidden'); r.focus(); }
    const btn = cardEl.querySelector('[data-action="reject-approval"]');
    if (btn) btn.textContent = 'Confirm reject';
    return;
  }
  const reason = cardEl.querySelector('.approval-reason')?.value.trim() || '';
  decideApproval(id, 'rejected', reason, cardEl);
}

async function decideApproval(id, decision, reason, cardEl) {
  // Lock the card's buttons so a double-tap can't double-submit.
  cardEl?.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const body = { decision };
    if (reason) body.reason = reason;
    await api('POST', `/admin/api/approvals/${id}/decide`, body);
    toast(decision === 'approved' ? 'approved' : 'rejected', decision === 'approved' ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err');           // 409 = already decided (race)
    cardEl?.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
  // SSE drives the authoritative refresh (badge, list, inline flip). Nudge
  // the badge immediately for snappiness in case SSE is mid-reconnect.
  refreshApprovalBadge();
}

function toggleApprovalDetail(cardEl) {
  const pre = cardEl?.querySelector('.approval-detail');
  const btn = cardEl?.querySelector('.approval-detail-toggle');
  if (!pre || !btn) return;
  const show = pre.classList.contains('hidden');
  pre.classList.toggle('hidden', !show);
  btn.textContent = show ? '▾ hide raw args' : '▸ raw args';
}

// ---- extensions (connectors) ------------------------------------------
// Each extension is a connector that gives agents a new job. The operator
// configures credentials here (encrypted server-side, never returned); the
// per-agent on/off is the capability checkbox on the Agents tab.
// Each connector: its secret field ids in the form (prefix), namespace, the
// fields that count as "fully configured", and a status badge id.
const EXT_CONNECTORS = [
  { ns: 'email',   prefix: 'se', badge: 'ext-email-status',
    fields: ['imap_host', 'imap_port', 'smtp_host', 'smtp_port', 'user', 'pass', 'from_address'],
    core: ['imap_host', 'smtp_host', 'user', 'pass', 'from_address'],
    secretFields: ['pass'] },
  { ns: 'twitter', prefix: 'st', badge: 'ext-twitter-status',
    fields: ['api_key', 'api_secret', 'access_token', 'access_secret'],
    core: ['api_key', 'api_secret', 'access_token', 'access_secret'],
    secretFields: ['api_secret', 'access_secret'] },
  { ns: 'linkedin', prefix: 'sl', badge: 'ext-linkedin-status',
    fields: ['access_token', 'author_urn', 'api_version'],
    core: ['access_token', 'author_urn'],
    secretFields: ['access_token'] },
];

async function loadExtensionsTab() {
  try {
    const { connectors } = await api('GET', '/admin/api/secrets');
    for (const conn of EXT_CONNECTORS) {
      const remote = (connectors || []).find(c => c.namespace === conn.ns);
      const keys = new Map((remote?.keys || []).map(k => [k.name, k.set]));
      for (const f of conn.fields) {
        const el = $(`${conn.prefix}-${f}`);
        if (!el) continue;
        if (keys.get(f)) {
          el.classList.add('field-set');
          if (conn.secretFields.includes(f)) el.placeholder = '•••••• (set — blank keeps it)';
          else if (!el.value) el.placeholder = '(set — blank keeps it)';
        } else {
          el.classList.remove('field-set');
        }
      }
      const ok = conn.core.every(k => keys.get(k));
      const badge = $(conn.badge);
      if (badge) {
        badge.textContent = ok ? 'configured' : 'not configured';
        badge.className = `chip ${ok ? 'ok' : 'warn'}`;
      }
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function saveConnectorExt(ns) {
  const conn = EXT_CONNECTORS.find(c => c.ns === ns);
  if (!conn) return;
  let wrote = 0;
  try {
    for (const f of conn.fields) {
      const el = $(`${conn.prefix}-${f}`);
      const value = (el?.value || '').trim();
      if (!value) continue;
      await api('POST', '/admin/api/secrets', { namespace: ns, name: f, value });
      wrote++;
      if (conn.secretFields.includes(f)) el.value = ''; // don't keep secrets in the DOM
    }
    toast(wrote ? `saved ${wrote} field${wrote === 1 ? '' : 's'}` : 'nothing to save');
    loadExtensionsTab();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- event delegation -------------------------------------------------
// One document-level click listener routes every data-action attribute to
// the handler in ACTIONS. This is what lets script-src drop 'unsafe-inline':
// no inline onclick= attributes survive anywhere in the page.
const ACTIONS = {
  // generic / chrome
  'copy':                   (el) => copyClick(el),
  'sign-out':               () => signOut(),
  'switch-group':           (el) => switchGroup(el.dataset.group),
  'switch-tab':             (el) => switchTab(el.dataset.tab),

  // agents tab
  'tool-preset':            (el) => applyToolPreset(el.dataset.preset),
  'submit-agent':           (el) => submitAgent(el.dataset.method),
  'revert-agent':           () => revertAgent(),
  'clear-agent-form':       () => clearForm(),
  'run-test':               () => runTest(),
  'edit-agent':             (el) => {
    const a = agentCache.find(x => x.id === el.dataset.id);
    if (a) loadAgentForm(a);
  },
  'toggle-agent':           (el) => toggleAgent(el.dataset.id, el.dataset.enabled === '1'),
  'reload-agent':           (el) => reloadAgent(el.dataset.id),
  'delete-agent':           (el) => deleteAgent(el.dataset.id),

  // workspaces tab
  'delete-workspace':       (el) => deleteWorkspace(Number(el.dataset.id)),

  // tiles + slide-in chat panel
  'open-agent-panel':       (el) => openAgentPanel(el.dataset.agent),
  'tiles-refresh':          () => refreshTiles(),
  'ap-close':               () => closeAgentPanel(),
  'toggle-convo-picker':    (el, e) => toggleConvoPicker(e),
  'switch-panel-convo':     (el) => switchPanelConvo(Number(el.dataset.cid), el.dataset.readonly === '1'),
  'pick-attachment':        () => $('ap-file')?.click(),
  'remove-attachment':      (el) => removeAttachment(Number(el.dataset.idx)),
  'zoom-attachment':        (el) => openImageLightbox(el.getAttribute('src')),
  'close-lightbox':         () => closeImageLightbox(),

  // conversations tab
  'open-conversation':      (el) => openConversation(Number(el.dataset.id), el.dataset.agent, el.dataset.title || ''),
  'resume-conversation':    () => resumeConversation(),

  // memories tab
  'open-lineage':           (el) => openLineage(Number(el.dataset.id)),
  'edit-memory':            (el) => {
    const id = Number(el.dataset.id);
    const m = memCache.find(x => x.id === id);
    if (m) editMemory(id, m.content);
  },
  'delete-memory':          (el) => deleteMemory(Number(el.dataset.id)),

  // channels tab
  'edit-channel':           (el) => {
    const c = channelCache.find(x => String(x.id) === el.dataset.id);
    if (c) loadChannelForm(c);
  },
  'toggle-channel':         (el) => toggleChannel(Number(el.dataset.id), el.dataset.enabled === '1'),
  'delete-channel':         (el) => deleteChannel(Number(el.dataset.id), el.dataset.name),

  // jobs
  'save-job':               () => saveJob(),
  'reset-job':              () => resetJobForm(),
  'run-job':                (el) => patchJob(el.dataset.id, { run_now: true }),
  'toggle-job':             (el) => patchJob(el.dataset.id, { enabled: el.dataset.enable === '1' }),
  'job-runs':               (el) => showJobRuns(el.dataset.id),
  'delete-job':             (el) => deleteJob(el.dataset.id),
  'bind-channel-chat':      (el) => bindChannelChat(Number(el.dataset.channelId), Number(el.dataset.chatId)),
  'submit-channel':         () => submitChannel(),
  'clear-channel-form':     () => clearChannelForm(),

  // api keys tab
  'revoke-api-key':         (el) => revokeApiKey(Number(el.dataset.id)),
  'delete-api-key':         (el) => deleteApiKey(Number(el.dataset.id)),
  'close-minted-key-modal': () => closeMintedKeyModal(),

  // tokens tab
  'revoke-token':           (el) => revokeToken(Number(el.dataset.id)),
  'delete-token':           (el) => deleteToken(Number(el.dataset.id)),

  'toggle-plugin':          (el) => togglePlugin(el.dataset.id, el.dataset.enabled === '1'),
  'uninstall-plugin':       (el) => uninstallPlugin(el.dataset.id, el.dataset.name, el.dataset.tables),
  'load-plugin-agent':      (el) => loadPluginAgent(el.dataset.id),
  'backup-now':             () => backupNow(),
  'health-refresh':         () => loadHealthTab(),
  'claude-token-save':    () => saveClaudeToken(),
  'claude-token-clear':   () => clearClaudeToken(),
  'memory-save':            () => saveMemoryConfig(),
  'memory-probe':           () => probeFlashback(),
  'backup-export':          () => downloadWithAuth('/admin/api/export', `ritsu-export-${new Date().toISOString().slice(0, 10)}.json`),
  'backup-download':        (el) => downloadWithAuth(`/admin/api/backups/${encodeURIComponent(el.dataset.name)}`, el.dataset.name),
  'backup-delete':          (el) => deleteBackupFile(el.dataset.name),

  'copy-mint-token':        () => {
    const text = $('token-plaintext')?.textContent || '';
    navigator.clipboard.writeText(text).then(() => toast('copied'));
  },
  'close-mint-modal':       () => closeMintModal(),
  // Backdrop closes ONLY when the click lands on the backdrop itself —
  // a click inside the modal bubbles here too, but closest() returns the
  // backdrop, so we discriminate via e.target.
  'mint-modal-backdrop':    (el, e) => { if (e.target === el) closeMintModal(); },

  // logs tab
  'log-pause':              (el) => {
    logPaused = !logPaused;
    el.textContent = logPaused ? 'Resume' : 'Pause';
  },
  'log-clear':              () => { logBuffer = []; renderLogs(); },

  // audit tab
  'audit-refresh':          () => loadAuditTab(),

  // extensions tab
  'save-email-ext':         () => saveConnectorExt('email'),
  'save-twitter-ext':       () => saveConnectorExt('twitter'),
  'save-linkedin-ext':      () => saveConnectorExt('linkedin'),

  // approvals tab + inline cards
  'approvals-refresh':      () => loadApprovalsList(),
  'approvals-subtab':       (el) => setApprovalsSubtab(el.dataset.sub),
  'approve-approval':       (el) => approveApprovalClick(el.closest('.approval-card')),
  'reject-approval':        (el) => rejectApprovalClick(el.closest('.approval-card')),
  'toggle-approval-detail': (el) => toggleApprovalDetail(el.closest('.approval-card')),

  // oauth clients tab
  'oauth-client-tokens':    (el) => openOAuthClientTokens(el.dataset.client),
  'revoke-oauth-client':    (el) => revokeOAuthClient(el.dataset.client, el.dataset.name),
};

// ---- plugin bridge ----------------------------------------------------
// Plugins ship their own UI (served from /admin/plugins/<id>/) and register
// tab renderers + action handlers through window.ritsu. Core stays generic:
// it knows how to mount a plugin, not what any plugin does.
const pluginTabs = {};
const pluginActions = {};
const pluginChanges = {};
let installedPlugins = [];
window.ritsu = {
  api, esc, toast,
  registerTab(tabId, fn) { pluginTabs[tabId] = fn; if (activeTab === tabId) fn(document.getElementById(`pane-${tabId}`)); },
  registerAction(name, fn) { pluginActions[name] = fn; },
  registerChange(name, fn) { pluginChanges[name] = fn; },
};

async function loadPlugins() {
  let plugins = [];
  try { ({ plugins } = await api('GET', '/admin/api/plugins')); }
  catch { return; }
  installedPlugins = plugins;
  const primary = $('nav-primary');
  const main = document.querySelector('main');
  for (const p of plugins) {
    if (p.enabled === false) continue;
    for (const g of (p.nav || [])) {
      if (!NAV_GROUPS.some(x => x.id === g.id)) NAV_GROUPS.push(g);
      if (!primary.querySelector(`[data-group="${g.id}"]`)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.action = 'switch-group';
        btn.dataset.group = g.id;
        btn.textContent = g.label;
        primary.appendChild(btn);
      }
      for (const t of (g.tabs || [])) {
        TAB_TO_GROUP.set(t.id, g.id);
        if (!document.getElementById(`pane-${t.id}`)) {
          const sec = document.createElement('section');
          sec.id = `pane-${t.id}`;
          sec.className = 'pane';
          main.appendChild(sec);
        }
      }
    }
    if (p.assets?.css) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = p.assets.css;
      document.head.appendChild(link);
    }
    if (p.assets?.js) {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = p.assets.js;
      document.head.appendChild(s);
    }
  }
  renderNav();
  renderPluginCheckboxes(readPlugins());
}

// System → Plugins: the plugin manager (core — it manages plugins, isn't one).
// Lists every installed plugin with its version, surfaces, owned tables, and
// an enable/disable toggle. Disable is reversible (data kept); uninstall drops
// the plugin's tables.
async function loadPluginsManager() {
  try {
    const { plugins } = await api('GET', '/admin/api/plugins');
    renderPluginsManager(plugins);
  } catch (e) { toast(e.message, 'err'); }
}

function pluginSurfaces(p) {
  const s = [];
  if (p.nav?.length) s.push('UI');
  s.push('REST');
  return s.join(', ');
}

function renderPluginsManager(plugins) {
  const target = $('plugins-list');
  if (!plugins.length) { target.innerHTML = '<em class="txt-muted">No plugins installed.</em>'; return; }
  const rows = plugins.map(p => `
    <tr class="${p.enabled ? '' : 'disabled'}">
      <td class="id-cell">${esc(p.name)}</td>
      <td><code>${esc(p.id)}</code></td>
      <td>${esc(p.version || '—')}</td>
      <td>${pluginSurfaces(p)}</td>
      <td title="${esc((p.tables || []).join(', '))}">${(p.tables || []).length}</td>
      <td>${p.installed_at ? new Date(p.installed_at * 1000).toISOString().slice(0, 10) : '—'}</td>
      <td>${p.enabled ? '<span class="badge ok-tint">enabled</span>' : '<span class="badge">disabled</span>'}</td>
      <td class="row-actions">
        ${p.agent ? `<button data-action="load-plugin-agent" data-id="${esc(p.id)}" title="create the ${esc(p.agent.name)} agent from this plugin's preset">load agent</button>` : ''}
        <button data-action="toggle-plugin" data-id="${esc(p.id)}" data-enabled="${p.enabled ? 1 : 0}">${p.enabled ? 'disable' : 'enable'}</button>
        <button class="danger" data-action="uninstall-plugin" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-tables="${(p.tables || []).length}">uninstall</button>
      </td>
    </tr>`).join('');
  target.innerHTML = `<table><thead><tr><th>name</th><th>id</th><th>version</th><th>surfaces</th><th>tables</th><th>installed</th><th>state</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function togglePlugin(id, currentlyEnabled) {
  try {
    await api('PATCH', `/admin/api/plugins/${encodeURIComponent(id)}`, { enabled: !currentlyEnabled });
    toast(`Plugin ${currentlyEnabled ? 'disabled' : 'enabled'} — reload to apply it to the nav.`);
    loadPluginsManager();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- Backups --------------------------------------------------------------
async function loadSettingsTab() {
  try {
    const d = await api('GET', '/admin/api/settings');
    const sel = $('set-search-provider');
    // "(none)" is a real choice: it turns WebSearch off rather than leaving a
    // half-configured backend that fails at call time.
    sel.innerHTML = ['<option value="">(none — WebSearch disabled)</option>']
      .concat(d.search_providers.map(p => `<option value="${esc(p)}">${esc(p)}</option>`)).join('');
    sel.value = d.settings['search.provider'] || '';
    $('set-search-url').value = d.settings['search.url'] || '';
    $('set-search-key').placeholder = d.search_key_set
      ? '•••••• (set — blank keeps it)'
      : 'hosted providers only; encrypted at rest';
    for (const el of document.querySelectorAll('#runtime-form [data-setting]')) {
      const key = el.dataset.setting;
      el.value = d.settings[key] ?? '';
      el.placeholder = `default ${d.defaults[key]}`;
    }
    $('settings-note').textContent = '';
  } catch (e) { toast(e.message, 'err'); }
}
async function saveSettings() {
  const settings = {
    'search.provider': $('set-search-provider').value,
    'search.url': $('set-search-url').value,
  };
  for (const el of document.querySelectorAll('#runtime-form [data-setting]')) {
    settings[el.dataset.setting] = el.value;
  }
  const key = $('set-search-key').value.trim();
  try {
    await api('POST', '/admin/api/settings', { settings, ...(key ? { search_api_key: key } : {}) });
    $('set-search-key').value = '';   // never keep the secret in the DOM
    // Rate limits and retention are read at boot; say so rather than letting
    // the operator think a saved value took effect immediately.
    $('settings-note').textContent = 'saved — search applies now; retention and rate limits on next restart';
    toast('settings saved');
    loadSettingsTab();
  } catch (e) { toast(e.message, 'err'); }
}

async function loadMemoryTab() {
  try {
    const d = await api('GET', '/admin/api/memory');
    const fmt = s => `<strong>${esc(s.mode)}</strong>${s.remote ? ` → ${esc(s.remote)}` : ''}`;
    const boot = d.boot ? `running: ${fmt(d.boot)}` : 'running: (unknown)';
    const next = `after restart: ${fmt(d.effective_next_boot)}`;
    $('memory-state').innerHTML = [
      `<span class="badge">${boot}</span>`,
      `<span class="badge">${next}</span>`,
      `<span class="hstat ${d.stored.token_set ? 'hstat-ok' : 'hstat-skip'}">token ${d.stored.token_set ? 'set' : 'not set'}</span>`,
    ].join(' ');
    $('mem-url').value = d.stored.url;
    $('mem-mode').value = ['dual', 'flashback', 'sqlite'].includes(d.stored.mode) ? d.stored.mode : '';
    $('mem-timeout').value = d.stored.timeout_ms;
    $('mem-poll').value = d.stored.proposal_poll_ms;
  } catch (e) { toast(e.message, 'err'); }
}
async function saveMemoryConfig() {
  const fields = [
    ['url', $('mem-url').value], ['token', $('mem-token').value], ['mode', $('mem-mode').value],
    ['timeout_ms', $('mem-timeout').value], ['proposal_poll_ms', $('mem-poll').value],
  ];
  let wrote = 0;
  try {
    for (const [name, raw] of fields) {
      const value = (raw || '').trim();
      if (!value) continue;
      await api('POST', '/admin/api/secrets', { namespace: 'flashback', name, value });
      wrote++;
    }
    $('mem-token').value = '';  // never keep the secret in the DOM
    toast(wrote ? `saved ${wrote} field${wrote === 1 ? '' : 's'} — restart ritsu to apply` : 'nothing to save');
    loadMemoryTab();
  } catch (e) { toast(e.message, 'err'); }
}
async function probeFlashback() {
  try {
    const { checks } = await api('GET', '/admin/api/health');
    const fb = checks.find(c => c.id === 'flashback');
    if (!fb) { toast('no flashback check available', 'err'); return; }
    if (fb.status === 'ok') toast(`flashback reachable (${fb.latency_ms} ms)`);
    else toast(`flashback: ${fb.detail || fb.status}`, 'err');
  } catch (e) { toast(e.message, 'err'); }
}

async function loadHealthTab() {
  const target = $('health-list');
  const meta = $('health-meta');
  target.innerHTML = '<em class="txt-muted">running checks…</em>';
  meta.textContent = '';
  try {
    const t0 = Date.now();
    const { checks } = await api('GET', '/admin/api/health');
    const groups = ['core', 'providers', 'connectors'];
    const rows = groups.flatMap(g => {
      const inGroup = checks.filter(c => c.group === g);
      return inGroup.map((c, i) => `
        <tr>
          <td>${i === 0 ? `<span class="badge">${esc(g)}</span>` : ''}</td>
          <td>${esc(c.label)}</td>
          <td><span class="hstat hstat-${esc(c.status)}">${c.status === 'skip' ? '—' : esc(c.status)}</span></td>
          <td>${c.latency_ms != null ? `${c.latency_ms} ms` : ''}</td>
          <td class="txt-muted">${esc(c.detail ?? '')}</td>
        </tr>`);
    }).join('');
    target.innerHTML = `<table><thead><tr><th></th><th>check</th><th>status</th><th>latency</th><th>detail</th></tr></thead><tbody>${rows}</tbody></table>`;
    const bad = checks.filter(c => c.status === 'fail').length;
    meta.textContent = `${checks.length} checks, ${bad} failing · ${Date.now() - t0} ms`;
  } catch (e) {
    target.innerHTML = `<em class="txt-muted">health check failed: ${esc(e.message)}</em>`;
  }
}

async function loadBackupsTab() {
  const el = document.getElementById('backups-list');
  if (!el) return;
  try {
    const { backups, dir } = await api('GET', '/admin/api/backups');
    el.innerHTML = backups.length
      ? `<p class="txt-muted">Stored on the box at <code>${esc(dir)}</code></p>
         <table><thead><tr><th>when</th><th>size</th><th></th></tr></thead><tbody>${backups.map(b => `
           <tr><td>${new Date(b.created_at * 1000).toLocaleString()}</td>
               <td>${(b.size / 1024).toFixed(0)} KB</td>
               <td class="row-actions">
                 <button data-action="backup-download" data-name="${esc(b.name)}">download</button>
                 <button class="danger" data-action="backup-delete" data-name="${esc(b.name)}">delete</button>
               </td></tr>`).join('')}</tbody></table>`
      : '<em class="txt-muted">No backups yet — one is taken automatically on restart. Or click “Back up now”.</em>';
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

async function backupNow() {
  try { const b = await api('POST', '/admin/api/backup'); toast(`backed up (${(b.size / 1024).toFixed(0)} KB)`, 'ok'); loadBackupsTab(); }
  catch (e) { toast(e.message, 'err'); }
}

async function deleteBackupFile(name) {
  if (!confirm(`Delete backup ${name}?`)) return;
  try { await api('DELETE', `/admin/api/backups/${encodeURIComponent(name)}`); loadBackupsTab(); }
  catch (e) { toast(e.message, 'err'); }
}

// Authed downloads: a plain <a download> can't carry the admin token header, so
// fetch the file with auth, then trigger the download from a blob URL.
async function downloadWithAuth(path, filename) {
  try {
    const res = await fetch(path, { headers: { 'X-Ritsu-Admin-Token': getAdminToken() } });
    if (!res.ok) { toast(`download failed (${res.status})`, 'err'); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, 'err'); }
}

async function loadPluginAgent(id) {
  try {
    const r = await api('POST', `/admin/api/plugins/${encodeURIComponent(id)}/agent`, {});
    if (r.created) toast(`Created agent "${r.id}" — find it under Agents to edit or chat.`, 'ok');
    else toast(`Agent "${r.id}" already exists — left it untouched.`, 'warn');
  } catch (e) { toast(e.message, 'err'); }
}

async function uninstallPlugin(id, name, tableCount) {
  if (!confirm(`Uninstall "${name}"? This DROPS its ${tableCount} data table(s) permanently — not the same as disabling. Continue?`)) return;
  try {
    await api('DELETE', `/admin/api/plugins/${encodeURIComponent(id)}`);
    toast(`Uninstalled ${name}.`);
    loadPluginsManager();
  } catch (e) { toast(e.message, 'err'); }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const handler = ACTIONS[action] || pluginActions[action];
  if (handler) handler(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const handler = pluginChanges[el.dataset.change];
  if (handler) handler(el, e);
});

// ---- bootstrap --------------------------------------------------------
renderNav();
// Kick the initial-load endpoints in parallel; top-level await unwraps the
// promises here so SonarQube's S7785 sees plain awaits, not floating
// promises / .then() chains. refreshAgents depends on agent-types finishing
// first, so it's a sequential await after loadAgentTypes.
await loadAgentTypes();
await Promise.all([refreshAgents(), loadAvailableTools(), loadLogLevels(), refreshInfo(), loadPlugins()]);
setInterval(refreshInfo, 5000);

// Approvals: open the live stream + seed the nav badge so a pending
// approval is visible from any tab, not just when the Approvals tab is open.
ensureApprovalsSse();
refreshApprovalBadge();

// Tiles is the default tab → kick its polling immediately.
startTilesPolling();

// Live filters on the Agents tab (debounced search, instant selects).
$('agent-search')?.addEventListener('input', debounce(applyAgentFilters, 100));
$('agent-disp-filter')?.addEventListener('change', applyAgentFilters);
// Runtime tier drives which providers the form offers; keep the current
// selection when it survives the switch.
$('f-runtime')?.addEventListener('change', () => renderProviderDropdown($('f-runtime').value, $('f-provider').value));
renderProviderDropdown($('f-runtime')?.value || 'direct', 'claude');
$('agent-state-filter')?.addEventListener('change', applyAgentFilters);

// Re-run cross-tab warnings whenever the form changes shape.
$('agent-form')?.addEventListener('change', recomputeFormWarnings);
$('agent-form')?.addEventListener('input', debounce(recomputeFormWarnings, 150));
// The agent form has multiple action buttons (Create/Save/Revert/Clear),
// not a single submit. preventDefault stops a stray Enter from doing a
// default GET to the current URL.
$('agent-form')?.addEventListener('submit', (e) => e.preventDefault());

// Forms whose primary button is type="submit" go through here. Each one's
// real handler lives in the per-tab section above; this just wires the
// preventDefault + dispatch in one place (and is also why script-src can
// drop unsafe-inline — these used to be inline onsubmit= attributes).
$('ws-form')?.addEventListener('submit', (e) => { e.preventDefault(); addWorkspace(); });
$('mem-seed-form')?.addEventListener('submit', (e) => { e.preventDefault(); seedMemory(); });
$('ch-form')?.addEventListener('submit', (e) => { e.preventDefault(); submitChannel(); });
$('ak-form')?.addEventListener('submit', (e) => { e.preventDefault(); mintApiKey(); });
$('token-mint-form')?.addEventListener('submit', (e) => { e.preventDefault(); mintToken(); });

// Slide-in chat panel.
$('ap-ask-form')?.addEventListener('submit', (e) => { e.preventDefault(); sendPanelAsk(); });
$('ap-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPanelAsk(); }
});
// Textarea autosize → form height changes → re-pad the transcript.
$('ap-input')?.addEventListener('input', syncTranscriptPadding);

// Image attachments: paste into the box, drop onto the panel, or pick a file.
$('ap-input')?.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const files = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'))
    .map(it => it.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); addAttachmentFiles(files); }
});
$('ap-file')?.addEventListener('change', (e) => {
  addAttachmentFiles(e.target.files);
  e.target.value = ''; // allow re-picking the same file
});
const apPanelEl = $('agent-panel');
apPanelEl?.addEventListener('dragover', (e) => {
  if (panelReadOnly) return;
  if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
    e.preventDefault();
    apPanelEl.classList.add('ap-drag');
  }
});
apPanelEl?.addEventListener('dragleave', (e) => {
  if (e.target === apPanelEl) apPanelEl.classList.remove('ap-drag');
});
apPanelEl?.addEventListener('drop', (e) => {
  apPanelEl.classList.remove('ap-drag');
  const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addAttachmentFiles(files); }
});

// Live filters on the Logs tab.
$('log-filter-msg').addEventListener('input', renderLogs);
$('log-filter-agent').addEventListener('input', renderLogs);

// Live filters on the Audit tab. Filter inputs re-render from auditCache
// without re-fetching — typing in the filter stays instant.
$('audit-filter-path')?.addEventListener('input', debounce(renderAudit, 100));
$('audit-filter-token')?.addEventListener('input', debounce(renderAudit, 100));
$('audit-filter-method')?.addEventListener('change', renderAudit);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('.ap-lightbox')) { closeImageLightbox(); return; }
    if ($('ap-convo-picker').classList.contains('open')) { closeConvoPicker(); return; }
    if ($('agent-panel').classList.contains('open')) closeAgentPanel();
  }
});
// Click outside the picker to close it. Picker lives inside the panel so
// we check that the click target isn't inside the picker or the trigger.
// This listener runs AFTER the delegated action handler, so a click on the
// trigger (which opens the picker) hits the action first; this then sees
// trigger.contains(e.target) and bails. Same target order matters.
document.addEventListener('click', (e) => {
  const picker = $('ap-convo-picker');
  if (!picker.classList.contains('open')) return;
  const trigger = $('ap-meta');
  if (picker.contains(e.target) || trigger.contains(e.target)) return;
  closeConvoPicker();
});

// Keep the agent panel sized to the visual viewport. iOS Safari shrinks the
// visual viewport when the keyboard opens but does NOT shrink the layout
// viewport — so position:fixed + 100vh / bottom:0 ends up extending behind
// the keyboard, breaking scroll inside the transcript. visualViewport gives
// us the actual visible-above-keyboard rect; we propagate it via CSS vars.
function syncAgentPanelViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  if (vv) {
    root.setProperty('--vvh', `${vv.height}px`);
    root.setProperty('--vvtop', `${vv.offsetTop}px`);
  } else {
    root.setProperty('--vvh', `${window.innerHeight}px`);
    root.setProperty('--vvtop', '0px');
  }
  // Form height can shift with viewport changes (esp. iOS safe-area inset
  // when rotating). Re-sync transcript bottom padding to match.
  syncTranscriptPadding();
}
// Floating form's actual height varies with the textarea growing, iOS
// home-indicator safe-area, and screen size. Measure it and set the
// transcript's bottom padding to match so the last message is never
// hidden behind the form.
function syncTranscriptPadding() {
  const form = $('ap-ask-form');
  const transcript = $('ap-transcript');
  if (!form || !transcript) return;
  const h = form.offsetHeight;
  if (h > 0) transcript.style.paddingBottom = `${h + 16}px`;
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncAgentPanelViewport);
  window.visualViewport.addEventListener('scroll', syncAgentPanelViewport);
}
window.addEventListener('resize', syncAgentPanelViewport);
syncAgentPanelViewport();

// ---- jobs -------------------------------------------------------------
// The listing exists mostly for one column: why a job stopped. A null next
// run means finished, paused, uncomputable, or given up on, and without the
// reason an operator cannot tell which.

let jobCache = [];

async function loadJobsTab() {
  // Same source the channels tab uses for its operator dropdown — the Agents
  // tab keeps it warm, so this needs no endpoint of its own.
  const sel = $('job-agent');
  sel.innerHTML = (agentCache || []).map(a => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join('')
    || '<option value="">(no agents yet)</option>';
  await refreshJobs();
}

async function refreshJobs() {
  const target = $('job-list');
  try {
    const { jobs, unreadable } = await api('GET', '/admin/api/jobs');
    jobCache = jobs.filter(Boolean);
    renderJobs(jobCache, unreadable || []);
  } catch (err) {
    target.innerHTML = `<em class="txt-muted">${esc(String(err.message || err))}</em>`;
  }
}

function jobWhen(j) {
  if (j.disabled_reason) return `<em class="txt-warn">stopped — ${esc(j.disabled_reason)}</em>`;
  if (!j.next_run_at) return '<em class="txt-muted">not scheduled</em>';
  return esc(new Date(j.next_run_at).toLocaleString());
}

function renderJobs(jobs, unreadable = []) {
  const target = $('job-list');
  // A row that will not parse is not in `jobs` and never can be, so it needs
  // its own block. Without it the operator sees an empty list and concludes
  // nothing is there, while the job still occupies its id.
  const broken = unreadable.length
    ? `<p class="txt-warn">${unreadable.length} job${unreadable.length > 1 ? 's' : ''} could not be read and will not run:</p>`
      + '<table><thead><tr><th>job</th><th>why</th><th></th></tr></thead><tbody>'
      + unreadable.map(u => `<tr><td><code>${esc(u.id)}</code>${u.name ? ' — ' + esc(u.name) : ''}</td>`
        + `<td class="txt-muted">${esc(u.error)}</td>`
        + `<td><button class="danger" data-action="delete-job" data-id="${esc(u.id)}">delete</button></td></tr>`).join('')
      + '</tbody></table>'
    : '';
  if (!jobs.length) {
    target.innerHTML = broken || '<em class="txt-muted">No jobs yet. Add one below.</em>';
    return;
  }
  const rows = jobs.map(j => {
    const stopped = !!j.disabled_reason;
    const failures = j.consecutive_failures > 0
      ? ` <span class="txt-warn">(${j.consecutive_failures} failures)</span>` : '';
    const tz = j.schedule.tz ? `<br /><span class="txt-muted">${esc(j.schedule.tz)}</span>` : '';
    return `
    <tr class="${stopped ? 'disabled' : ''}">
      <td class="id-cell">${esc(j.id)}<br /><span class="txt-muted">${esc(j.name)}</span></td>
      <td>${esc(j.schedule.kind)} <code>${esc(j.schedule.spec)}</code>${tz}</td>
      <td><span class="badge">${esc(j.payload.kind)}</span></td>
      <td><code>${esc(j.owner || 'operator')}</code></td>
      <td>${jobWhen(j)}${failures}</td>
      <td>${esc(j.last_status || '—')}</td>
      <td class="row-actions">
        <button data-action="run-job" data-id="${esc(j.id)}">run now</button>
        <button data-action="toggle-job" data-id="${esc(j.id)}" data-enable="${stopped || !j.next_run_at ? '1' : '0'}">${stopped || !j.next_run_at ? 'enable' : 'pause'}</button>
        <button data-action="job-runs" data-id="${esc(j.id)}">history</button>
        <button class="danger" data-action="delete-job" data-id="${esc(j.id)}">delete</button>
      </td>
    </tr>`;
  }).join('');
  target.innerHTML = broken
    + `<table><thead><tr><th>job</th><th>schedule</th><th>payload</th><th>owner</th><th>next</th><th>last</th><th></th></tr></thead><tbody>${rows}</tbody></table><div id="job-runs"></div>`;
}

async function patchJob(id, body) {
  try { await api('PATCH', `/admin/api/jobs/${encodeURIComponent(id)}`, body); await refreshJobs(); }
  catch (err) { $('job-msg').textContent = String(err.message || err); }
}

async function deleteJob(id) {
  if (!confirm(`Delete job "${id}" and its run history?`)) return;
  await api('DELETE', `/admin/api/jobs/${encodeURIComponent(id)}`);
  await refreshJobs();
}

async function showJobRuns(id) {
  const box = $('job-runs');
  try {
    const { runs } = await api('GET', `/admin/api/jobs/${encodeURIComponent(id)}/runs`);
    if (!runs.length) { box.innerHTML = `<p class="txt-muted">No runs recorded for ${esc(id)}.</p>`; return; }
    box.innerHTML = `<h3>${esc(id)} — recent runs</h3><table><thead><tr><th>started</th><th>status</th><th>detail</th></tr></thead><tbody>${
      runs.map(r => `<tr><td>${esc(new Date(r.started_at).toLocaleString())}</td><td>${esc(r.status)}</td><td><code>${esc((r.error || r.output || '').slice(0, 300))}</code></td></tr>`).join('')
    }</tbody></table>`;
  } catch (err) {
    box.innerHTML = `<em class="txt-warn">${esc(String(err.message || err))}</em>`;
  }
}

function jobFormPayload() {
  const kind = $('job-payload').value;
  const body = $('job-body').value;
  if (kind === 'notify') return { kind, text: body };
  if (kind === 'script') return { kind, command: body };
  return { kind, agent_id: $('job-agent').value, message: body, conversation_id: null };
}

async function saveJob() {
  const msg = $('job-msg');
  const chans = $('job-channels').value.trim();
  try {
    const res = await api('POST', '/admin/api/jobs', {
      id: $('job-id').value.trim(),
      name: $('job-name').value.trim(),
      schedule: {
        kind: $('job-kind').value,
        spec: $('job-spec').value.trim(),
        tz: $('job-tz').value.trim() || null,
      },
      payload: jobFormPayload(),
      delivery: { channel_ids: chans ? chans.split(',').map(x => Number(x.trim())).filter(Number.isInteger) : [] },
    });
    // A job whose agent operates no channel still saves — it need not involve
    // one — but its replies would land in a thread nobody is reading.
    msg.textContent = res.warning ? `Saved. Warning: ${res.warning}` : 'Saved.';
    resetJobForm();
    await refreshJobs();
  } catch (err) {
    msg.textContent = String(err.message || err);
  }
}

function resetJobForm() {
  for (const id of ['job-id', 'job-name', 'job-spec', 'job-tz', 'job-body', 'job-channels']) $(id).value = '';
}

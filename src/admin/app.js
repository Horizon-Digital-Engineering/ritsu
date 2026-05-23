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
  { id: 'agents', label: 'Agents', tabs: [
    { id: 'agents',        label: 'Agents' },
    { id: 'workspaces',    label: 'Workspaces' },
    { id: 'memories',      label: 'Memories' },
    { id: 'conversations', label: 'Conversations' },
    { id: 'tools',         label: 'Tools' },
  ] },
  { id: 'comms', label: 'Comms', tabs: [
    { id: 'channels', label: 'Channels' },
    { id: 'mcp',      label: 'MCP' },
  ] },
  { id: 'auth', label: 'Auth', tabs: [
    { id: 'tokens',        label: 'Tokens' },
    { id: 'api-keys',      label: 'API Keys' },
    { id: 'oauth-clients', label: 'OAuth Clients' },
  ] },
  { id: 'system', label: 'System', tabs: [
    { id: 'logs',  label: 'Logs' },
    { id: 'audit', label: 'Audit' },
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
  if (name === 'mcp') loadMcpTools();
  else if (name === 'tokens') refreshTokens();
  else if (name === 'api-keys') refreshApiKeys();
  else if (name === 'oauth-clients') loadOAuthClientsTab();
  else if (name === 'channels') loadChannelsTab();
  else if (name === 'workspaces') loadWorkspacesTab();
  else if (name === 'conversations') loadConversationsTab();
  else if (name === 'memories') loadMemoriesTab();
  else if (name === 'tools') loadToolsTab();
  else if (name === 'logs') openLogStream();
  else if (name === 'audit') loadAuditTab();
  if (name !== 'logs') closeLogStream();
}

// ---- info bar --------------------------------------------------------------
async function refreshInfo() {
  try {
    const d = await api('GET', '/admin/api/info');
    $('version').textContent = `v${d.version}`;
    const authChip = `<span class="chip ${d.auth_effective === 'open' ? 'warn' : 'ok'}">mcp: ${d.auth_effective}</span>`;
    const modeChip = `<span class="chip">mode: ${d.auth_mode}</span>`;
    const levelChip = `<span class="chip">log: ${d.log_level}</span>`;
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
async function loadAvailableTools() {
  try {
    const { tools } = await api('GET', '/admin/api/tools/available');
    availableTools = tools;
    renderToolCheckboxes([]);
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
    if (disp && a.dispatcher !== disp) return false;
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
      <td><span class="badge dispatcher-${esc(a.dispatcher)}">${esc(a.dispatcher)}</span> ${esc(a.model)}</td>
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
  target.innerHTML = `<table><thead><tr><th>id</th><th>type</th><th>name</th><th>dispatcher / model</th><th>memory</th><th>last used</th><th>state</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
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
  const opts = ['<option value="">— none (claude-sdk only) —</option>']
    .concat(apiKeyCache.map(k => `<option value="${k.id}">${esc(k.name)} (${esc(k.provider)})</option>`));
  sel.innerHTML = opts.join('');
  if (selectedId != null) sel.value = String(selectedId);
}
function loadAgentForm(a) {
  editingAgentId = a.id;
  editingWorkspaces = null;   // force refetch on next recomputeFormWarnings
  $('f-id').value = a.id; $('f-id').readOnly = true;
  $('f-type').value = a.type;
  $('f-name').value = a.name;
  $('f-description').value = a.description;
  $('f-dispatcher').value = a.dispatcher;
  $('f-model').value = a.model;
  $('f-memory-backend').value = a.memory_backend;
  $('f-enabled').checked = !!a.enabled;
  $('f-system-prompt').value = a.system_prompt;
  $('f-provider').value = a.provider ?? '';
  renderApiKeyDropdown(a.api_key_ref ?? null);
  $('f-provider-options').value = a.provider_options && Object.keys(a.provider_options).length
    ? JSON.stringify(a.provider_options)
    : '';
  refreshApiKeyDropdown().then(() => { renderApiKeyDropdown(a.api_key_ref ?? null); });
  renderToolCheckboxes(a.tools_allowlist || []);
  renderCanCallCheckboxes(a.can_call || []);
  const caps = new Set(a.capabilities || []);
  $('f-cap-manage').checked = caps.has('manage_agents');
  $('f-cap-monitor').checked = caps.has('monitor_agents');
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
  $('f-provider').value = '';
  $('f-provider-options').value = '';
  renderApiKeyDropdown(null);
  refreshApiKeyDropdown();
  renderToolCheckboxes([]);
  renderCanCallCheckboxes([]);
  $('f-cap-manage').checked = false;
  $('f-cap-monitor').checked = false;
  $('f-revert').classList.add('hidden');
  $('test-pane').classList.remove('hidden'); // available for drafts too
  $('test-reply').classList.add('hidden');
  $('test-meta').textContent = '';
  recomputeFormWarnings();
}
async function submitAgent(method) {
  const provider = $('f-provider').value || null;
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
    description: $('f-description').value, dispatcher: $('f-dispatcher').value,
    model: $('f-model').value, memory_backend: $('f-memory-backend').value,
    enabled: $('f-enabled').checked, system_prompt: $('f-system-prompt').value,
    tools_allowlist: readToolsAllowlist(),
    can_call: readCanCall(),
    capabilities: [
      ...($('f-cap-manage').checked ? ['manage_agents'] : []),
      ...($('f-cap-monitor').checked ? ['monitor_agents'] : []),
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
  await ensureWorkspaceCache();
  banner.innerHTML = buildWarningHtml(readToolsAllowlist(), editingWorkspaces, editingAgentId);
}

/** Map (selected tools, workspace cache, editingAgentId) → the warning-banner
 *  HTML string. Pure function — easier to reason about than mutating banner
 *  in-flight across branches, and unit-testable if we ever want to. */
function buildWarningHtml(toolList, workspaces, agentId) {
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
  const lines = collectFormWarningLines(needs, anyFsTool, wsList, agentId);
  return lines.length ? `<div class="warn-banner">⚠ ${lines.join('<br>')}</div>` : '';
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
      dispatcher: $('f-dispatcher').value,
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
    $('ap-sub').textContent = `${def.model} · ${def.dispatcher}${def.enabled ? '' : ' · disabled'}`;
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
  } catch (e) {
    t.innerHTML = `<div class="txt-err">${esc(e.message)}</div>`;
  }
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
    return;
  }
  // Byline only when the caller is another *agent*. Everything else
  // (admin-ui, any MCP bearer token, etc.) is "you" — device doesn't
  // matter; the operator is one person.
  const agentIds = new Set((agentCache || []).map(a => a.id));
  t.innerHTML = visible.map(m => {
    const showByline = m.role === 'user' && m.caller_label && agentIds.has(m.caller_label);
    const byline = showByline
      ? `<div class="transcript-byline">${esc(m.caller_label)}</div>`
      : '';
    return `<div class="ap-msg ${m.role}">${byline}${esc(m.content)}</div>`;
  }).join('');
  t.scrollTop = t.scrollHeight;
}

function appendTranscript(role, content, pending = false) {
  const t = $('ap-transcript');
  if (t.querySelector('.ap-empty')) t.innerHTML = '';
  const div = document.createElement('div');
  div.className = `ap-msg ${role}${pending ? ' pending' : ''}`;
  div.textContent = content;
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
  return div;
}

async function sendPanelAsk() {
  if (panelAsking || !panelAgentId) return;
  const msg = $('ap-input').value.trim();
  if (!msg) return;
  panelAsking = true;
  $('ap-send').disabled = true;
  $('ap-input').value = '';
  appendTranscript('user', msg);
  const pendingNode = appendTranscript('assistant', '…', true);
  try {
    const body = { message: msg };
    if (panelConvoId) body.conversation_id = panelConvoId;
    const resp = await api('POST', `/admin/agents/${panelAgentId}/ask`, body);
    panelConvoId = resp.conversation_id;
    pendingNode.classList.remove('pending');
    pendingNode.textContent = resp.reply ?? '(empty reply)';
    // If the trigger label was "(empty)" before the first turn, refresh
    // it now that the convo has a first user message to title with.
    if ($('ap-meta').textContent === '(empty)') {
      const { messages } = await api('GET', `/admin/api/conversations/${panelConvoId}`);
      updateMetaFromMessages(messages);
    }
  } catch (e) {
    pendingNode.classList.remove('pending', 'assistant');
    pendingNode.classList.add('system');
    pendingNode.textContent = `error: ${e.message}`;
    toast(e.message, 'err');
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
  panelAgentId = null;
  panelConvoId = null;
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
let logSource = null;
let logPaused = false;
let logBuffer = [];   // raw events seen
const LOG_MAX = 500;
async function openLogStream() {
  if (logSource) return;
  // Initial backfill
  try {
    const { events } = await api('GET', '/admin/api/events/recent?limit=200');
    logBuffer = events.slice(-LOG_MAX);
    renderLogs();
  } catch (e) { toast(e.message, 'err'); }
  logSource = new EventSource('/admin/api/events/stream');
  logSource.onmessage = (e) => {
    if (logPaused) return;
    try {
      const ev = JSON.parse(e.data);
      logBuffer.push(ev);
      if (logBuffer.length > LOG_MAX) logBuffer.shift();
      renderLogs();
    } catch (err) {
      // Malformed SSE event payload (truncated stream, garbage line). One
      // bad event shouldn't break the live tail — log it and keep going.
      console.warn('log-tail parse error', err);
    }
  };
  logSource.onerror = () => {
    // EventSource auto-reconnects on transport errors; no manual handling
    // needed, but documenting that the empty body is deliberate.
  };
}
function closeLogStream() {
  if (logSource) { logSource.close(); logSource = null; }
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
};

function deriveAgentTools(agent) {
  // Memory + agent_comms MCP servers are always wired (every agent gets
  // them at host construction). Admin + monitor are capability-gated.
  const caps = new Set(agent.capabilities || []);
  const mcp = [
    {
      server: 'memory',
      tools: MCP_TOOL_MAP.memory,
      note: `memory backend: ${agent.memory_backend}`,
    },
    {
      server: 'agent_comms',
      tools: MCP_TOOL_MAP.agent_comms,
      note: (agent.can_call || []).length
        ? `can_call: ${agent.can_call.join(', ')}`
        : '(can_call empty — ask_agent has no allowed targets)',
    },
    ...(caps.has('manage_agents')
      ? [{ server: 'agent_admin', tools: MCP_TOOL_MAP.agent_admin, note: 'capability: manage_agents' }]
      : []),
    ...(caps.has('monitor_agents')
      ? [{ server: 'agent_monitor', tools: MCP_TOOL_MAP.agent_monitor, note: 'capability: monitor_agents' }]
      : []),
  ];
  return { builtin: agent.tools_allowlist || [], mcp };
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
    const [agent, wsResp] = await Promise.all([
      api('GET', `/admin/agents/${encodeURIComponent(agentId)}`),
      api('GET', `/admin/agents/${encodeURIComponent(agentId)}/workspaces`).catch(() => ({ workspaces: [] })),
    ]);
    const { builtin, mcp } = deriveAgentTools(agent);
    const wsList = wsResp.workspaces || [];

    const builtinSection = builtin.length
      ? builtin.map(t => `<span class="badge accent-tint">${esc(t)}</span>`).join('')
      : '<em class="txt-muted">(none — agent has no built-in SDK tools allowlisted)</em>';

    const mcpSection = mcp.map(s => `
      <div class="mb-4">
        <div class="fw-600">mcp__${esc(s.server)}__*
          <span class="panel-sub-label ml-2">${esc(s.note)}</span>
        </div>
        <div class="mt-1">
          ${s.tools.map(t => `<code class="mr-3 fs-md">mcp__${esc(s.server)}__${esc(t)}</code>`).join('')}
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

    // Surface the runtime / dispatcher next to the tool inventory so the
    // claude-sdk-vs-ritsu-agent distinction is unambiguous from here.
    const runtime = agent.provider
      ? `ritsu-agent (${esc(agent.provider)})`
      : 'claude-sdk (Max plan)';

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

  // oauth clients tab
  'oauth-client-tokens':    (el) => openOAuthClientTokens(el.dataset.client),
  'revoke-oauth-client':    (el) => revokeOAuthClient(el.dataset.client, el.dataset.name),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const handler = ACTIONS[action];
  if (handler) handler(el, e);
});

// ---- bootstrap --------------------------------------------------------
renderNav();
// Kick the initial-load endpoints in parallel; top-level await unwraps the
// promises here so SonarQube's S7785 sees plain awaits, not floating
// promises / .then() chains. refreshAgents depends on agent-types finishing
// first, so it's a sequential await after loadAgentTypes.
await loadAgentTypes();
await Promise.all([refreshAgents(), loadAvailableTools(), loadLogLevels(), refreshInfo()]);
setInterval(refreshInfo, 5000);

// Tiles is the default tab → kick its polling immediately.
startTilesPolling();

// Live filters on the Agents tab (debounced search, instant selects).
$('agent-search')?.addEventListener('input', debounce(applyAgentFilters, 100));
$('agent-disp-filter')?.addEventListener('change', applyAgentFilters);
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

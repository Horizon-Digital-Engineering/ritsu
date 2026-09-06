// ritsu agent workspace — the chat-first main surface.
//
// Served as a static asset at /admin/workspace.js so the page can keep
// script-src 'self'. Every interaction routes through the two document-level
// delegators at the bottom (data-action for clicks, data-change for selects),
// so no inline onclick=/onchange= attributes survive in the HTML or in
// JS-built innerHTML strings, and no style="…" attribute is ever emitted.
//
// The whole page is scoped to ONE agent at a time; the hash is the router:
//   #/a/<agentId>              → that agent's default chat
//   #/a/<agentId>/c/<convId>   → a specific chat
//   #/a/<agentId>/p/<projId>   → a project
//   #/a/<agentId>/files        → the workspace file browser

// ---- helpers ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** Short age for a unix timestamp: 5m, 3h, 6d, 2w. */
function fmtAge(epoch) {
  if (!epoch) return '';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.floor(d / (86400 * 7))}w`;
  return `${Math.floor(d / (86400 * 365))}y`;
}
function fmtRelativeSeconds(deltaSec) {
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  for (const u of units) {
    if (v < 1024 || u === 'GB') return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u}`;
    v /= 1024;
  }
  return `${Math.round(v)} GB`;
}

/** Stable hash → glyph + color for any agent id. Same id renders identically
 *  here and in the classic admin. */
const GLYPH_SHAPES = ['●', '■', '▲', '◆', '★', '◉', '◐', '◢'];
const GLYPH_HUES = [200, 280, 140, 30, 0, 320, 240, 100];
function agentHash(agentId) {
  let h = 5381;
  for (const c of String(agentId)) h = ((h << 5) + h + (c.codePointAt(0) ?? 0)) >>> 0;
  return h;
}
function glyphFor(agentId) {
  const h = agentHash(agentId);
  const shape = GLYPH_SHAPES[h % GLYPH_SHAPES.length];
  // Discrete hue index → a CSS rule keyed off data-hue-idx. The stylesheet
  // owns the hsl() triple so no inline style attribute is needed.
  const hueIdx = Math.floor(h / GLYPH_SHAPES.length) % GLYPH_HUES.length;
  return `<span class="agent-glyph" data-hue-idx="${hueIdx}">${shape}</span>`;
}

// ---- auth ------------------------------------------------------------------
// Same localStorage key as the classic admin, so one sign-in covers both UIs.
const ADMIN_TOKEN_KEY = 'ritsu.adminToken';
const LAST_AGENT_KEY = 'ritsu.workspace.lastAgent';
function getAdminToken() { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; }
function setAdminToken(t) { localStorage.setItem(ADMIN_TOKEN_KEY, t); }
function clearAdminToken() { localStorage.removeItem(ADMIN_TOKEN_KEY); }

// Many api() calls fire in parallel at page load; this shared promise keeps
// exactly ONE modal instead of five stacked dialogs.
let _tokenPromise = null;
function showAdminLogin(reason) {
  const overlay = $('admin-login');
  const form = $('admin-login-form');
  const input = $('admin-login-token');
  $('admin-login-msg').textContent = reason || 'Sign in with your admin token.';
  overlay.classList.add('open');
  input.value = '';
  // Defer focus so the password manager has time to autofill first.
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

/** Every admin API request carries the token via X-Ritsu-Admin-Token. A 401
 *  clears it and re-prompts, then retries once. */
async function api(method, path, body) {
  if (!getAdminToken()) {
    const got = await ensureAdminToken('Admin token required.');
    if (!got) throw new Error('admin token required');
  }
  const doFetch = () => {
    const headers = { 'X-Ritsu-Admin-Token': getAdminToken() };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
 * Authenticated SSE consumer. EventSource can't send custom headers, so
 * admin-gated streams use streaming fetch + manual parsing of the
 * text/event-stream wire format. Caller aborts the signal to stop the loop;
 * anything else reconnects after 2s.
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
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLines = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
          if (!dataLines.length) continue;
          try { onEvent(JSON.parse(dataLines.join('\n'))); }
          catch { /* malformed payload — skip, keep the stream alive */ }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      console.warn('sse reconnect in 2s:', e?.message ?? e);
      await new Promise(res => setTimeout(res, 2000));
    }
  }
}

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = $('toast');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

// ---- state -----------------------------------------------------------------
let agents = [];            // enabled agents, from /admin/agents
let agentId = null;         // the agent this whole page is scoped to
let agentDef = null;        // its full definition (model, for the vision hint)
let defaultChat = null;     // { conversation_id, channel }
let projects = [];
let convos = [];            // human conversations for this agent
let files = [];
let filesTruncated = false;
let hasWorkspaces = true;
let filesLoaded = false;
let filesLoading = false;
let convoId = null;         // the open chat
let searchQuery = '';
/** Server-side hits for the current query; null = not searching. */
let searchHits = null;
let searchSeq = 0;
let showArchived = false;
let sending = false;
let attachments = [];       // pasted/dropped/picked but not yet sent
let contextChips = [];      // { label, text } — server-fenced context to prepend
const inFlight = new Set(); // conversation ids someone is mid-turn on

// Sequence guards: a slow response for an agent/chat the operator has already
// navigated away from must not paint over the newer one.
let ctxSeq = 0;
let txSeq = 0;

// ---- routing ---------------------------------------------------------------
const chatPath = (id, cid) => `/a/${encodeURIComponent(id)}${cid ? `/c/${cid}` : ''}`;
const projectPath = (id, pid) => `/a/${encodeURIComponent(id)}/p/${pid}`;
const filesPath = (id) => `/a/${encodeURIComponent(id)}/files`;
const skillsPath = (id) => `/a/${encodeURIComponent(id)}/skills`;
function go(path) { location.hash = path; }

function parseHash() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  if (parts[0] !== 'a' || !parts[1]) return null;
  let id;
  try { id = decodeURIComponent(parts[1]); } catch { return null; }
  if (parts[2] === 'c' && Number.isInteger(Number(parts[3]))) return { id, view: 'chat', cid: Number(parts[3]) };
  if (parts[2] === 'p' && Number.isInteger(Number(parts[3]))) return { id, view: 'project', pid: Number(parts[3]) };
  if (parts[2] === 'files') return { id, view: 'files' };
  if (parts[2] === 'skills') return { id, view: 'skills' };
  return { id, view: 'chat', cid: null };
}

async function onRoute() {
  closeMenus();
  if (!agents.length) return;
  const r = parseHash();
  if (!r || !agents.some(a => a.id === r.id)) {
    const fallback = agents.find(a => a.id === localStorage.getItem(LAST_AGENT_KEY)) || agents[0];
    location.replace(`#${chatPath(fallback.id)}`);   // hashchange re-enters here
    return;
  }
  if (r.id !== agentId) {
    agentId = r.id;
    localStorage.setItem(LAST_AGENT_KEY, agentId);
    filesLoaded = false;
    files = [];
    convoId = null;
    previewCache.clear();
    clearAttachments();
    clearContextChips();
    await loadAgentContext();
  }
  await applyView(r);
  renderSidebar();
}

async function applyView(r) {
  showView(r.view);
  closeSidebar();
  if (r.view === 'chat') {
    const target = r.cid ?? defaultChat?.conversation_id ?? null;
    if (target !== convoId) await openChat(target);
    else renderChatHead();
  } else if (r.view === 'project') {
    renderProjectView(r.pid);
  } else if (r.view === 'skills') {
    await showSkillsView();
  } else {
    await showFilesView();
  }
}

function showView(view) {
  for (const v of ['chat', 'project', 'files', 'skills']) {
    $(`view-${v}`).classList.toggle('active', v === view);
  }
}

// ---- agent context ---------------------------------------------------------
async function loadAgents() {
  const { agents: all } = await api('GET', '/admin/agents');
  agents = (all || []).filter(a => a.enabled);
  return agents;
}

/** Everything the sidebar needs for one agent, fetched together. */
async function loadAgentContext() {
  const seq = ++ctxSeq;
  const enc = encodeURIComponent(agentId);
  setSidebarLoading();
  const [def, dc, projs, convList, ws, prompts] = await Promise.all([
    api('GET', `/admin/agents/${enc}`).catch(() => null),
    api('GET', `/admin/api/agents/${enc}/default-chat`).catch(() => null),
    api('GET', `/admin/api/agents/${enc}/projects`).catch(() => ({ projects: [] })),
    api('GET', `/admin/api/conversations?agent_id=${enc}&kind=human&limit=200`).catch(() => ({ conversations: [] })),
    api('GET', `/admin/agents/${enc}/workspaces`).catch(() => ({ workspaces: [] })),
    api('GET', `/admin/api/agents/${enc}/prompts`).catch(() => ({ prompts: [] })),
  ]);
  if (seq !== ctxSeq) return;
  savedPrompts = prompts?.prompts || [];
  agentDef = def;
  defaultChat = dc;
  projects = projs?.projects || [];
  convos = convList?.conversations || [];
  hasWorkspaces = (ws?.workspaces || []).length > 0;
  const name = def?.name || agentId;
  document.title = `ritsu — ${name}`;
  $('agent-btn-label').textContent = name;
  $('agent-btn-glyph').innerHTML = glyphFor(agentId);
  updateAttachHint();
}

/** Refetch just the lists the sidebar renders (no agent def / workspaces). */
async function refreshLists() {
  const seq = ctxSeq;
  const enc = encodeURIComponent(agentId);
  try {
    const [projs, convList] = await Promise.all([
      api('GET', `/admin/api/agents/${enc}/projects`),
      api('GET', `/admin/api/conversations?agent_id=${enc}&kind=human&limit=200`),
    ]);
    if (seq !== ctxSeq) return;
    projects = projs.projects || [];
    convos = convList.conversations || [];
    renderSidebar();
    if ($('view-chat').classList.contains('active')) renderChatHead();
  } catch { /* transient — the next SSE event or navigation retries */ }
}
const scheduleRefresh = debounce(refreshLists, 600);

// ---- sidebar ---------------------------------------------------------------
function matchesSearch(text) {
  return !searchQuery || String(text || '').toLowerCase().includes(searchQuery);
}

function setSidebarLoading() {
  $('side-default').innerHTML = '<div class="side-empty">loading…</div>';
  $('side-projects').innerHTML = '';
  $('side-chats').innerHTML = '';
}

function renderSidebar() {
  renderDefaultChat();
  renderProjectList();
  renderChatList();
  const route = parseHash();
  $('files-nav').classList.toggle('active', route?.view === 'files');
  $('skills-nav').classList.toggle('active', route?.view === 'skills');
}

function renderDefaultChat() {
  const target = $('side-default');
  if (!defaultChat) { target.innerHTML = '<div class="side-empty">no default chat</div>'; return; }
  const ch = defaultChat.channel;
  const label = 'Default chat';
  if (!matchesSearch(`${label} ${ch?.kind ?? ''} ${ch?.name ?? ''}`)) { target.innerHTML = ''; return; }
  const active = isChatOpen(defaultChat.conversation_id) ? ' active' : '';
  // A bound channel means this same thread is also fed by e.g. a chat bot —
  // worth badging, because replies can arrive with nobody at this keyboard.
  const badge = ch
    ? `<span class="chan-badge" title="${esc(ch.name || ch.kind)}">⚡ ${esc(ch.kind)}</span>`
    : '';
  target.innerHTML = `<div class="side-row">
    <button type="button" class="side-item${active}" data-action="open-chat" data-cid="${defaultChat.conversation_id}">
      <span class="side-item-lead" aria-hidden="true">⚡</span>
      <span class="side-item-title">${label}</span>${badge}
    </button>
  </div>`;
}

function renderProjectList() {
  const target = $('side-projects');
  const route = parseHash();
  const list = projects.filter(p => matchesSearch(p.name));
  if (!list.length) {
    target.innerHTML = projects.length
      ? '<div class="side-empty">no match</div>'
      : '<div class="side-empty">No projects yet — “+” to group chats and files.</div>';
    return;
  }
  target.innerHTML = list.map(p => {
    const active = route?.view === 'project' && route.pid === p.id ? ' active' : '';
    return `<div class="side-row">
      <button type="button" class="side-item${active}" data-action="open-project" data-pid="${p.id}">
        <span class="side-item-lead" aria-hidden="true">▸</span>
        <span class="side-item-title">${esc(p.name)}</span>
        <span class="side-item-meta">${p.chat_count}c ${p.file_count}f</span>
      </button>
      <button type="button" class="row-menu-btn" data-action="toggle-project-menu" data-pid="${p.id}" aria-label="Project actions">⋯</button>
      <div class="row-menu" data-menu-for="${p.id}">
        <button type="button" data-action="rename-project" data-pid="${p.id}" data-name="${esc(p.name)}">Rename</button>
        <button type="button" class="danger" data-action="delete-project" data-pid="${p.id}" data-name="${esc(p.name)}">Delete</button>
      </div>
    </div>`;
  }).join('');
}

const CHAT_GROUPS = [
  { label: 'Today', max: 86400 },
  { label: 'Previous 7 days', max: 86400 * 7 },
  { label: 'Previous 30 days', max: 86400 * 30 },
  { label: 'Older', max: Infinity },
];

/** Query the server for matches in message BODIES — the client filter only
 *  sees titles. Sequenced so a stale response can't overwrite a newer one. */
async function runDeepSearch() {
  const q = searchQuery;
  if (!q || q.length < 2 || !agentId) { searchHits = null; return; }
  const seq = ++searchSeq;
  try {
    const r = await api('GET', `/admin/api/search?agent_id=${encodeURIComponent(agentId)}&q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq || searchQuery !== q) return;
    searchHits = r.results || [];
    renderSidebar();
  } catch { /* search is best-effort; the client filter already ran */ }
}

function renderChatList() {
  const target = $('side-chats');

  // Deep-search mode: server hits (titles AND bodies, archived included),
  // each with a snippet of where it matched.
  if (searchQuery && searchHits) {
    if (!searchHits.length) { target.innerHTML = '<div class="side-empty">no match</div>'; return; }
    target.innerHTML = '<div class="side-group">Search results</div>'
      + searchHits.map(c => chatRowHtml(c, { snippet: c.snippet })).join('');
    return;
  }

  // Filed chats live under their project; the default chat is pinned above.
  const list = convos
    .filter(c => c.id !== defaultChat?.conversation_id && c.project_id == null)
    .filter(c => matchesSearch(c.title || '(new chat)'));
  if (!list.length && !convos.some(c => c.archived)) {
    target.innerHTML = convos.length
      ? '<div class="side-empty">no match</div>'
      : '<div class="side-empty">No chats yet.</div>';
    return;
  }
  const live = list.filter(c => !c.archived);
  const pinned = live.filter(c => c.pinned);
  const rest = live.filter(c => !c.pinned);
  const archived = list.filter(c => c.archived);

  const now = Date.now() / 1000;
  const buckets = CHAT_GROUPS.map(g => ({ ...g, rows: [] }));
  for (const c of rest) {
    const age = now - (c.started_at || 0);
    (buckets.find(b => age < b.max) ?? buckets[buckets.length - 1]).rows.push(c);
  }
  let html = '';
  if (pinned.length) html += '<div class="side-group">Pinned</div>' + pinned.map(c => chatRowHtml(c)).join('');
  html += buckets.filter(b => b.rows.length).map(b =>
    `<div class="side-group">${b.label}</div>` + b.rows.map(c => chatRowHtml(c)).join(''),
  ).join('');
  if (archived.length) {
    html += `<button type="button" class="side-group side-group-toggle" data-action="toggle-archived">`
      + `Archived (${archived.length}) ${showArchived ? '▾' : '▸'}</button>`;
    if (showArchived) html += archived.map(c => chatRowHtml(c)).join('');
  }
  target.innerHTML = html || '<div class="side-empty">No chats yet.</div>';
}

/** A message newer than the last read, in a chat nobody is looking at. */
function isUnread(c) {
  return !isChatOpen(c.id) && (c.last_message_at ?? 0) > (c.read_at ?? 0);
}

function chatRowHtml(c, opts = {}) {
  const active = isChatOpen(c.id) ? ' active' : '';
  const unread = isUnread(c);
  const title = (c.pinned ? '📌 ' : '') + (c.title?.trim() ? c.title : '(new chat)');
  const snippet = opts.snippet
    ? `<span class="side-item-snippet">${esc(opts.snippet)}</span>` : '';
  return `<div class="side-row">
    <button type="button" class="side-item${active}${unread ? ' unread' : ''}" data-action="open-chat" data-cid="${c.id}">
      <span class="side-item-title">${esc(title)}</span>${snippet}
      ${unread ? '<span class="unread-dot" aria-label="unread"></span>' : ''}
      <span class="side-item-age">${fmtAge(c.last_message_at || c.started_at)}</span>
    </button>
  </div>`;
}

function isChatOpen(cid) {
  return $('view-chat').classList.contains('active') && convoId === cid;
}

/** The messages on the RENDERED PATH, for copy/export/edit by index. */
let lastRendered = [];
/** Every message in the open chat — the tree the path is walked over. */
let lastMessages = [];
/** parentId (or 'root') → chosen child id, for the open chat. */
let pathChoice = {};
/** Set while editing a past user turn: the parent the new branch hangs from. */
let editing = null;

// ---- chat view -------------------------------------------------------------
function convoTitle(cid) {
  if (cid && cid === defaultChat?.conversation_id) return 'Default chat';
  const c = convos.find(x => x.id === cid);
  if (!c) return '(new chat)';
  return c.title?.trim() ? c.title : '(new chat)';
}

function renderChatHead() {
  $('chat-title').textContent = convoId ? convoTitle(convoId) : 'Chat';
  const c = convos.find(x => x.id === convoId);
  const bits = [];
  if (convoId) bits.push(`#${convoId}`);
  if (c?.message_count != null) bits.push(`${c.message_count} msg${c.message_count === 1 ? '' : 's'}`);
  if (c?.started_at) bits.push(`started ${fmtAge(c.started_at)} ago`);
  $('chat-sub').textContent = bits.join(' · ');

  // A chat filed under a project inherits that project's instructions, and
  // that is invisible from the transcript alone — badge it.
  const proj = c?.project_id != null ? projects.find(x => x.id === c.project_id) : null;
  const badge = $('chat-inherit');
  if (proj?.system_prompt) {
    badge.textContent = `inherits ${proj.name} instructions`;
    badge.dataset.pid = String(proj.id);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const isDefault = convoId === defaultChat?.conversation_id;
  $('chat-menu-wrap').classList.toggle('hidden', !convoId);
  // Renaming the default chat is fine; deleting/archiving the anchor is
  // refused server-side too — hiding the options just keeps the menu honest.
  $('chat-menu-delete').classList.toggle('hidden', isDefault);
  $('chat-menu-archive').classList.toggle('hidden', isDefault);
  $('chat-menu-pin').classList.toggle('hidden', isDefault);
  const cRow = convos.find(x => x.id === convoId);
  $('chat-menu-pin').textContent = cRow?.pinned ? 'Unpin' : 'Pin';
  $('chat-menu-archive').textContent = cRow?.archived ? 'Unarchive' : 'Archive';

  // The default chat is the pinned always-first thread — filing it under a
  // project would leave it in two places at once, so it isn't offered.
  const wrap = $('chat-file-wrap');
  const filable = convoId && !isDefault;
  wrap.classList.toggle('hidden', !filable);
  if (!filable) return;
  const sel = $('chat-project');
  const current = c?.project_id ?? '';
  sel.innerHTML = `<option value="">(none)</option>` +
    projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  sel.value = String(current);
}

async function openChat(cid) {
  convoId = cid;
  clearAttachments();
  clearContextChips();
  cancelEdit();
  closeArtifact();
  pathChoice = loadPathChoice(cid);
  lastMessages = [];
  renderChatHead();
  const t = $('transcript');
  if (!cid) { t.innerHTML = '<div class="empty">No conversation yet — send something below.</div>'; return; }
  const seq = ++txSeq;
  t.innerHTML = '<div class="empty">loading…</div>';
  markChatRead(cid);
  try {
    const { messages } = await api('GET', `/admin/api/conversations/${cid}`);
    if (seq !== txSeq) return;
    renderTranscript(messages);
    await refreshInlineApprovals();
  } catch (e) {
    if (seq !== txSeq) return;
    t.innerHTML = `<div class="empty txt-err">${esc(e.message)}</div>`;
  }
}

/** Clear the unread dot both locally (instant) and server-side. */
function markChatRead(cid) {
  const c = convos.find(x => x.id === cid);
  if (c) { c.read_at = Math.floor(Date.now() / 1000); renderSidebar(); }
  api('PATCH', `/admin/api/conversations/${cid}/read`).catch(() => { /* the dot returns on the next refresh */ });
}

// ---- edit / regenerate / continue -------------------------------------------
function startEdit(idx) {
  const m = lastRendered[idx];
  if (!m || m.role !== 'user') return;
  // Sending from here forks a sibling under the SAME parent, so the original
  // turn (and everything under it) stays reachable through the ‹ › arrows.
  editing = { parent_message_id: m.parent_message_id ?? null };
  $('edit-banner').classList.remove('hidden');
  const input = $('ask-input');
  input.value = m.content;
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function cancelEdit() {
  if (!editing) return;
  editing = null;
  $('edit-banner').classList.add('hidden');
  $('ask-input').value = '';
  autosize();
}

async function regenerateMsg(idx) {
  const m = lastRendered[idx];
  if (!m?.id || !convoId || sending) return;
  sending = true;
  $('ask-send').disabled = true;
  ensurePendingBubble();
  try {
    await api('POST', `/admin/api/conversations/${convoId}/regenerate`, { assistant_message_id: m.id });
    unpin(m.parent_message_id);   // the new sibling is newest — let it win
    await reloadTranscript();
    scheduleRefresh();
  } catch (e) {
    removePendingBubble();
    toast(e.message, 'err');
  } finally {
    sending = false;
    $('ask-send').disabled = false;
  }
}

/** Send a literal message as a normal turn (the Continue button). */
function sendLiteral(text) {
  cancelEdit();
  $('ask-input').value = text;
  autosize();
  sendAsk();
}

/** Authoritative re-render from server state — wipes optimistic bubbles and
 *  picks up out-of-band turns (another tab, a channel, an agent-to-agent call). */
async function reloadTranscript() {
  if (!convoId) return;
  const seq = ++txSeq;
  try {
    const { messages } = await api('GET', `/admin/api/conversations/${convoId}`);
    if (seq !== txSeq) return;
    renderTranscript(messages);
    await refreshInlineApprovals();
  } catch { /* SSE or the next navigation retries */ }
}

// ---- markdown (assistant messages) -----------------------------------------
// MD-PURE-START (node-testable: no DOM, only esc())
/**
 * Minimal, escape-first markdown for assistant replies. The whole input is
 * HTML-escaped BEFORE any transform, and every tag that appears in the output
 * comes from a literal below — content can only ever land inside text
 * positions or quoted, escaped attributes. Links are restricted to http(s).
 * Fenced code is lifted out first so nothing inside it is transformed.
 */
const THINK_RE = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;

/** Linear scan for ```lang fences. Replaces lazy-regex parsing, which
 *  backtracks super-linearly on unclosed fences in hostile input. Returns
 *  [{start, end, lang, body}] with `end` just past the closing backticks;
 *  `padAfterLang` additionally eats horizontal whitespace after the language
 *  word (the artifact scanner's historical tolerance). */
function scanFences(text, padAfterLang = false) {
  const out = [];
  let i = 0;
  for (;;) {
    const s = text.indexOf('```', i);
    if (s === -1) break;
    let p = s + 3;
    while (p < text.length && /[A-Za-z0-9_+.-]/.test(text[p])) p++;
    const lang = text.slice(s + 3, p);
    if (padAfterLang) while (p < text.length && text[p] !== '\n' && /\s/.test(text[p])) p++;
    if (text[p] === '\n') p++;
    const e = text.indexOf('```', p);
    if (e === -1) break;
    out.push({ start: s, end: e + 3, lang, body: text.slice(p, e) });
    i = e + 3;
  }
  return out;
}

/** Byte ranges covered by a ``` fence. Math extraction runs before the fence
 *  lift, so it consults these to leave TeX-shaped text inside code alone. */
function fenceRanges(text) {
  return scanFences(text).map(f => [f.start, f.end]);
}

/** A fenced block. `mermaid` keeps its source as the visible body: that is
 *  both the pre-render state and the render-failure state, so a diagram that
 *  cannot be drawn still shows what the agent wrote. */
function codeBlockHtml(b) {
  const code = esc(b.code.replace(/\n$/, ''));
  if ((b.lang || '').toLowerCase() === 'mermaid') {
    return `<div class="mermaid-box" data-mermaid="${code}"><div class="codebar">`
      + '<span class="codelang">mermaid</span>'
      + '<button type="button" class="codecopy" data-action="copy-mermaid">copy</button></div>'
      + `<div class="mermaid-out"><pre><code>${code}</code></pre></div></div>`;
  }
  return '<div class="codeblock"><div class="codebar">'
    + `<span class="codelang">${esc(b.lang || 'text')}</span>`
    + '<button type="button" class="codecopy" data-action="copy-code">copy</button></div>'
    + `<pre><code>${code}</code></pre></div>`;
}

/** KaTeX renders into this after the transcript paints; the escaped TeX is
 *  the element's body until then, and stays put if the render fails. */
function mathHtml(m) {
  const tex = esc(m.tex.trim());
  return m.display
    ? `<div class="math-block" data-tex="${tex}">${tex}</div>`
    : `<span class="math-inline" data-tex="${tex}">${tex}</span>`;
}

function reasoningHtml(body) {
  return '<details class="reasoning"><summary>Thought</summary>'
    + `<div class="reasoning-body">${esc(body)}</div></details>`;
}

function md(raw) {
  let text = String(raw ?? '');

  // Chain-of-thought comes out first and renders collapsed above the answer.
  const thoughts = [];
  text = text.replace(THINK_RE, (_, body) => { thoughts.push(body.trim()); return ''; });

  // Math before every other transform, so no emphasis/escape rule mangles the
  // TeX — but a $$ inside a code fence is source, not math.
  const maths = [];
  const fences = fenceRanges(text);
  text = text.replace(/\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)/g, (whole, blk, inl, idx) => {
    if (fences.some(([a, b]) => idx >= a && idx < b)) return whole;
    maths.push({ tex: blk !== undefined ? blk : inl, display: blk !== undefined });
    return `\uE000M${maths.length - 1}\uE000`;
  });

  const blocks = [];
  {
    const lifted = scanFences(text);
    if (lifted.length) {
      let rebuilt = '';
      let last = 0;
      for (const f of lifted) {
        blocks.push({ lang: f.lang, code: f.body });
        rebuilt += text.slice(last, f.start) + `\uE000B${blocks.length - 1}\uE000`;
        last = f.end;
      }
      text = rebuilt + text.slice(last);
    }
  }
  text = esc(text);
  text = text.replace(/`([^`\n]+)`/g, '<code class="md-ic">$1</code>');
  text = text
    .replace(/^#### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>');
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
  // esc() ran first, so a quote in the URL is already &quot; and cannot
  // break out of the attribute; the ^https? anchor shuts out javascript: etc.
  text = text.replace(/\[([^[\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text = text
    .replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/<\/blockquote>\n<blockquote>/g, '<br>');
  text = text.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (m, body) =>
    '\n<ul>' + body.trim().split('\n').map(l => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>\n');
  text = text.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (m, body) =>
    '\n<ol>' + body.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('') + '</ol>\n');
  text = text.replace(/^(?:---+|\*\*\*+)$/gm, '<hr>');
  text = text.replace(/\n{2,}/g, '\uE000P\uE000').replace(/\n/g, '<br>');
  text = text
    .replace(/\uE000P\uE000/g, '<div class="md-gap"></div>')
    .replace(/(<\/(?:h2|h3|h4|h5|ul|ol|blockquote)>|<hr>)<br>/g, '$1')
    .replace(/<br>(<(?:h2|h3|h4|h5|ul|ol|blockquote|hr)[ >])/g, '$1');
  text = text.replace(/\uE000B(\d+)\uE000(?:<br>)?/g, (_, i) => codeBlockHtml(blocks[+i]));
  // Display math is its own block, so it swallows the <br> the line break pass
  // left behind; inline math keeps it.
  text = text.replace(/\uE000M(\d+)\uE000(<br>)?/g, (_, i, br) => {
    const m = maths[+i];
    return mathHtml(m) + (m.display ? '' : (br || ''));
  });
  return thoughts.map(reasoningHtml).join('') + text;
}
// MD-PURE-END

// ---- message tree ----------------------------------------------------------
// Messages form a tree (regenerate and edit make SIBLINGS, never overwrite).
// Exactly one root-to-leaf path renders: at every fork the newest child wins
// unless pathChoice pins another, so switching a fork hides its whole subtree —
// the branch semantics operators already expect from a chat UI.

const pathKey = (cid) => `ritsu.workspace.path.${cid}`;

function loadPathChoice(cid) {
  if (!cid) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(pathKey(cid)) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function savePathChoice(cid, choice) {
  if (!cid) return;
  try {
    if (Object.keys(choice).length) localStorage.setItem(pathKey(cid), JSON.stringify(choice));
    else localStorage.removeItem(pathKey(cid));
  } catch { /* private mode / quota — the pin just doesn't survive a reload */ }
}
/** Drop the pin under one parent so a freshly-created sibling (the newest
 *  child) wins the walk again. */
function unpin(parentId) {
  delete pathChoice[parentId == null ? 'root' : parentId];
  savePathChoice(convoId, pathChoice);
}

/**
 * @returns {{path: Array<{msg: object, siblings: object[], parentKey: string|number}>, flat: boolean}}
 */
function computePath(messages, choice) {
  // Rows written before the tree existed carry a null parent across the board;
  // walking them would render exactly one message, so they render flat.
  if (!messages.some(m => m.parent_message_id != null)) {
    return { path: messages.map(m => ({ msg: m, siblings: [m], parentKey: 'root' })), flat: true };
  }
  const ids = new Set(messages.map(m => m.id).filter(id => id != null));
  const kids = new Map();
  for (const m of messages) {
    // A parent outside the fetched window can't be walked to — treat that
    // message as a root so the visible tail still renders.
    const p = m.parent_message_id != null && ids.has(m.parent_message_id) ? m.parent_message_id : 'root';
    const list = kids.get(p) ?? [];
    list.push(m);
    kids.set(p, list);
  }
  for (const list of kids.values()) list.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  const path = [];
  const seen = new Set();
  let key = 'root';
  for (;;) {
    const level = kids.get(key);
    if (!level?.length) break;
    const pick = level.find(m => m.id === choice[key]) ?? level[level.length - 1];
    if (pick.id == null || seen.has(pick.id)) break;   // cycle guard
    seen.add(pick.id);
    path.push({ msg: pick, siblings: level, parentKey: key });
    key = pick.id;
  }
  return { path, flat: false };
}

/** ‹ i/N › plus the per-message actions, in one strip under the bubble. */
function msgToolsHtml(node, i, flat, isLastAssistant) {
  const m = node.msg;
  const bits = [];
  if (!flat && node.siblings.length > 1) {
    const at = node.siblings.findIndex(s => s.id === m.id);
    const prev = node.siblings[at - 1];
    const next = node.siblings[at + 1];
    const k = esc(String(node.parentKey));
    bits.push('<span class="sib-nav">'
      + `<button type="button" class="sib-btn" data-action="pick-sibling" data-parent="${k}" data-child="${prev?.id ?? ''}"${prev ? '' : ' disabled'} aria-label="Previous version">‹</button>`
      + `<span class="sib-count">${at + 1}/${node.siblings.length}</span>`
      + `<button type="button" class="sib-btn" data-action="pick-sibling" data-parent="${k}" data-child="${next?.id ?? ''}"${next ? '' : ' disabled'} aria-label="Next version">›</button>`
      + '</span>');
  }
  if (m.role === 'user' && m.id != null && m.content) {
    bits.push(`<button type="button" class="msg-tool" data-action="edit-msg" data-idx="${i}">Edit</button>`);
  }
  if (isLastAssistant && m.id != null) {
    bits.push(`<button type="button" class="msg-tool" data-action="regen-msg" data-idx="${i}">Regenerate</button>`
      + '<button type="button" class="msg-tool" data-action="continue-msg">Continue</button>');
  }
  if (m.role === 'assistant' && artifactsIn(m.content).length) {
    bits.push(`<button type="button" class="msg-tool artifact-open" data-action="open-artifact" data-idx="${i}">Open artifact</button>`);
  }
  return bits.length ? `<div class="msg-tools">${bits.join('')}</div>` : '';
}

function renderTranscript(messages) {
  lastMessages = (messages || []).filter(m => m.role !== 'system');
  renderPath();
}

/** Paint the chosen path. Cheap enough to re-run on every arrow click, so a
 *  fork switch never refetches. */
function renderPath() {
  const t = $('transcript');
  if (!lastMessages.length) {
    lastRendered = [];
    t.innerHTML = '<div class="empty">No messages yet — send something below.</div>';
  } else {
    // Byline only when the caller is another agent; everything else (admin
    // token, MCP bearer, this browser) is just "you".
    const agentIds = new Set(agents.map(a => a.id));
    const { path, flat } = computePath(lastMessages, pathChoice);
    lastRendered = path.map(n => n.msg);
    let lastAssistant = -1;
    for (let i = 0; i < path.length; i++) if (path[i].msg.role === 'assistant') lastAssistant = i;
    t.innerHTML = path.map((node, i) => {
      const m = node.msg;
      const byline = m.role === 'user' && m.caller_label && agentIds.has(m.caller_label)
        ? `<div class="msg-byline">${esc(m.caller_label)}</div>` : '';
      const atts = m.attachments?.length
        ? `<div class="msg-atts">${m.attachments.map(a =>
            `<img class="att-img" data-action="zoom-attachment" src="data:${esc(a.media_type)};base64,${esc(a.data)}" alt="attachment">`).join('')}</div>`
        : '';
      // Assistant turns render as markdown; user turns stay literal text —
      // what the operator typed is what they see.
      const body = m.role === 'assistant' ? md(m.content) : esc(m.content).replace(/\n/g, '<br>');
      const copy = m.content
        ? `<button type="button" class="msg-copy" data-action="copy-msg" data-idx="${i}" aria-label="Copy message">copy</button>` : '';
      const when = m.created_at ? ` title="${esc(new Date(m.created_at * 1000).toLocaleString())}"` : '';
      const tools = msgToolsHtml(node, i, flat, i === lastAssistant);
      return `<div class="msg ${esc(m.role)}"${when}>${byline}${body}${atts}${tools}${copy}</div>`;
    }).join('');
  }
  if (convoId !== null && inFlight.has(convoId)) ensurePendingBubble();
  t.scrollTop = t.scrollHeight;
  renderMath(t);
  renderMermaid(t);
}

function appendMsg(role, content, attachmentUrls) {
  const t = $('transcript');
  if (t.querySelector('.empty')) t.innerHTML = '';
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (content) {
    const span = document.createElement('span');
    span.textContent = content;
    div.appendChild(span);
  }
  if (attachmentUrls?.length) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-atts';
    for (const url of attachmentUrls) {
      const img = document.createElement('img');
      img.className = 'att-img';
      img.src = url;
      img.alt = 'attachment';
      img.dataset.action = 'zoom-attachment';
      wrap.appendChild(img);
    }
    div.appendChild(wrap);
  }
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
  return div;
}

/** Idempotent: repeated ask-start events only ever produce one bubble. */
function ensurePendingBubble() {
  const t = $('transcript');
  if (t.querySelector('.msg.pending')) return;
  if (t.querySelector('.empty')) t.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'msg assistant pending';
  div.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
}
function removePendingBubble() {
  $('transcript').querySelector('.msg.pending')?.remove();
}

async function sendAsk() {
  if (sending || !agentId) return;
  const input = $('ask-input');
  const msg = input.value.trim();
  // An image-only turn ("look at this") is valid — require text OR an image.
  if (!msg && !attachments.length) return;
  sending = true;
  $('ask-send').disabled = true;
  closePalette();
  input.value = '';
  autosize();
  // Snapshot + clear so the tray empties immediately and a double-tap can't
  // resend; restored into the tray if the send fails.
  const sent = attachments;
  const chips = contextChips;
  const editParent = editing ? editing.parent_message_id : undefined;
  attachments = [];
  contextChips = [];
  renderAttachTray();
  const optimistic = appendMsg('user', msg, sent.map(a => a.url));
  try {
    // Chip text arrives from the server already wrapped in the untrusted
    // fence — it is prepended verbatim, never unwrapped or re-fenced.
    const prefix = chips.map(c => c.text).filter(Boolean).join('\n\n');
    const body = { message: prefix ? `${prefix}\n\n${msg}` : msg };
    if (convoId) body.conversation_id = convoId;
    if (editParent !== undefined) body.parent_message_id = editParent;
    if (sent.length) body.attachments = sent.map(a => ({ media_type: a.media_type, data: a.data }));
    const resp = await api('POST', `/admin/agents/${encodeURIComponent(agentId)}/ask`, body);
    if (resp?.conversation_id) convoId = resp.conversation_id;
    if (editParent !== undefined) { unpin(editParent); cancelEdit(); }
    await reloadTranscript();
    scheduleRefresh();
  } catch (e) {
    // Losing the operator's text into the void is the worst failure here, so
    // put the bubble away and the message (and images) back in the box.
    optimistic.remove();
    removePendingBubble();
    input.value = msg;
    autosize();
    attachments = sent;
    contextChips = chips;
    renderAttachTray();
    const friendly = /load failed|networkerror|failed to fetch/i.test(e.message)
      ? 'connection dropped — press Send to retry'
      : `error: ${e.message}`;
    const node = document.createElement('div');
    node.className = 'msg system';
    node.textContent = friendly;
    $('transcript').appendChild(node);
    toast(friendly, 'err');
  } finally {
    sending = false;
    $('ask-send').disabled = false;
    input.focus();
  }
}

function autosize() {
  const el = $('ask-input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

async function newChat() {
  if (!agentId) return;
  try {
    const r = await api('POST', `/admin/api/agents/${encodeURIComponent(agentId)}/conversations`);
    await refreshLists();
    go(chatPath(agentId, r.conversation_id));
    setTimeout(() => $('ask-input').focus(), 60);
  } catch (e) { toast(e.message, 'err'); }
}

async function fileChatUnder(sel) {
  if (!convoId) return;
  const raw = sel.value;
  const project_id = raw === '' ? null : Number(raw);
  try {
    await api('PATCH', `/admin/api/conversations/${convoId}/project`, { project_id });
    toast(project_id ? 'filed' : 'unfiled');
    await refreshLists();
  } catch (e) {
    toast(e.message, 'err');
    renderChatHead();   // snap the select back to the server's truth
  }
}

// ---- image attachments -----------------------------------------------------
const ATTACH_MAX = 4;
// 1568px is the resolution ceiling for most vision models; the newer high-res
// tier buys real fidelity up to 2576px, so those agents get the sharper cap.
const ATTACH_MAX_EDGE_DEFAULT = 1568;
const ATTACH_MAX_EDGE_HIRES = 2576;
const ATTACH_MAX_B64 = 6_800_000;   // ~5MB binary; the server enforces the same
const ATTACH_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// Best-effort guess. Unknown models default to "capable" so we don't nag; the
// hint only fires for models we are fairly sure are text-only.
const VISION_MODEL_RE = /claude|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|chatgpt-4o|o1|o3|o4|gemini|grok|llava|pixtral|qwen.*vl|llama.*vision|vision|moondream/i;

function attachMaxEdge() {
  return /opus-4-[78]/.test(agentDef?.model || '') ? ATTACH_MAX_EDGE_HIRES : ATTACH_MAX_EDGE_DEFAULT;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('failed to read file'));
    r.onload = () => {
      const s = String(r.result);
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.readAsDataURL(blob);
  });
}

// Decode → downscale → re-encode, bounding the payload. GIFs pass through
// untouched so animation survives (canvas would flatten them).
async function processImageFile(file) {
  if (!ATTACH_TYPES.includes(file.type)) throw new Error('unsupported image type (png/jpeg/webp/gif only)');
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
  bitmap.close?.();
  const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const toBlob = (q) => new Promise(res => canvas.toBlob(res, outType, q));
  let blob = await toBlob(0.85);
  let data = blob ? await blobToBase64(blob) : '';
  if (data.length > ATTACH_MAX_B64 && outType === 'image/jpeg') {
    blob = await toBlob(0.6);
    data = blob ? await blobToBase64(blob) : data;
  }
  if (!data) throw new Error('failed to encode image');
  if (data.length > ATTACH_MAX_B64) throw new Error('image too large after downscale (max ~5MB)');
  return { media_type: outType, data, url: `data:${outType};base64,${data}` };
}

async function addAttachmentFiles(fileList) {
  const list = Array.from(fileList || []).filter(f => f?.type?.startsWith('image/'));
  for (const f of list) {
    if (attachments.length >= ATTACH_MAX) { toast(`max ${ATTACH_MAX} images per message`, 'err'); break; }
    try { attachments.push(await processImageFile(f)); }
    catch (e) { toast(e.message || 'could not attach image', 'err'); }
  }
  renderAttachTray();
}

function renderAttachTray() {
  const tray = $('attach-tray');
  if (!attachments.length && !contextChips.length) {
    tray.classList.remove('show');
    tray.setAttribute('aria-hidden', 'true');
    tray.innerHTML = '';
    return;
  }
  tray.classList.add('show');
  tray.setAttribute('aria-hidden', 'false');
  tray.innerHTML = attachments.map((a, i) =>
    `<div class="attach-chip"><img src="${a.url}" alt="attachment ${i + 1}"><button type="button" data-action="remove-attachment" data-idx="${i}" title="remove" aria-label="Remove attachment">✕</button></div>`,
  ).join('') + contextChips.map((c, i) =>
    `<span class="ctx-chip" title="${esc(c.label)}"><span class="ctx-chip-label">${esc(c.label)}</span>`
    + `<button type="button" data-action="remove-chip" data-idx="${i}" title="remove" aria-label="Remove context">✕</button></span>`,
  ).join('');
}
function clearAttachments() { attachments = []; renderAttachTray(); }
function clearContextChips() { contextChips = []; renderAttachTray(); }

/** Warn (don't block) when this agent's model is probably text-only. */
function updateAttachHint() {
  const hint = $('attach-hint');
  const model = agentDef?.model;
  if (model && !VISION_MODEL_RE.test(model)) {
    hint.textContent = `heads up: ${model} may not be able to see images`;
    hint.classList.add('show');
    hint.setAttribute('aria-hidden', 'false');
  } else {
    hint.classList.remove('show');
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = '';
  }
}

function openLightbox(src) {
  if (!src) return;
  closeLightbox();
  const back = document.createElement('div');
  back.className = 'lightbox';
  back.dataset.action = 'close-lightbox';
  const img = document.createElement('img');
  img.src = src;
  img.alt = 'attachment';
  back.appendChild(img);
  document.body.appendChild(back);
}
function closeLightbox() { document.querySelectorAll('.lightbox').forEach(n => n.remove()); }

// ---- inline approval cards -------------------------------------------------
// A gated tool call the agent is blocked on shows as a card right in the
// transcript — approve/reject without leaving the chat.
async function refreshInlineApprovals() {
  if (!convoId) return;
  const t = $('transcript');
  t.querySelectorAll('.approval-card').forEach(el => el.remove());
  try {
    const { approvals } = await api('GET', `/admin/api/approvals?conversation_id=${convoId}`);
    for (const a of approvals) t.insertAdjacentHTML('beforeend', approvalCardHtml(a));
    if (approvals.length) t.scrollTop = t.scrollHeight;
  } catch { /* best-effort — the operations board is the durable queue */ }
}

/** Glyph for an approval, by tool name — quick visual recognition. */
function approvalToolIcon(tool) {
  const t = (tool || '').toLowerCase();
  if (t.includes('bash') || t.includes('exec')) return '⌘';
  if (t.includes('write') || t.includes('edit')) return '✎';
  if (t.includes('web') || t.includes('fetch') || t.includes('search')) return '🌐';
  if (t.includes('mail') || t.includes('email')) return '✉️';
  return '⚙️';
}
/** No auto-reject; the tint just gets louder the longer a decision sits. */
function approvalStaleClass(a) {
  const age = Math.floor(Date.now() / 1000) - a.requested_at;
  if (age > 7 * 86400) return 'stale-7d';
  if (age > 86400) return 'stale-24h';
  if (age > 4 * 3600) return 'stale-4h';
  return '';
}
function approvalAgo(ts) { return fmtRelativeSeconds(Math.max(0, Math.floor(Date.now() / 1000) - ts)); }
function approvalArgsPreview(argsJson) {
  try { return esc(JSON.stringify(JSON.parse(argsJson), null, 2)); }
  catch { return esc(String(argsJson)); }
}
function approvalTruncate(s, n) {
  return s.length > n ? `${esc(s.slice(0, n))}<span class="txt-muted">… (${s.length - n} more)</span>` : esc(s);
}

/**
 * Render a string with every non-ASCII / control character made VISIBLE and
 * tagged with its code point. A spoofed recipient carrying a lookalike glyph
 * or a bidi control renders identically to the real thing in plain text —
 * this unmasks it so nobody approves a send to an attacker domain.
 */
function approvalUnmask(s) {
  let bad = false;
  const html = [...String(s)].map(ch => {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp > 0x7e) {
      bad = true;
      const u = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      return `<span class="bad-char" title="${u}">${esc(ch)}[${u}]</span>`;
    }
    return esc(ch);
  }).join('');
  return { html, bad };
}

/** The security-critical fields of an approval, shown by DEFAULT: the
 *  destination of an irreversible action is exactly what must be read before
 *  approving, and hiding it behind a toggle is how it goes unread. */
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
  const warn = rows.some(r => r.bad)
    ? '<div class="spoof-warn">⚠ Non-standard characters in a field below — possible spoofing. Verify before approving.</div>'
    : '';
  const body = rows.map(r =>
    `<div class="hl-row ${r.critical ? 'critical' : ''} ${r.bad ? 'bad' : ''}">` +
      `<span class="hl-label">${esc(r.label)}</span>` +
      `<span class="hl-val">${r.html}</span>` +
    '</div>').join('');
  return `${warn}<div class="approval-highlights">${body}</div>`;
}

/** Capabilities this approval would escalate, if the comms guard marked it. */
function approvalEscalationInfo(argsJson) {
  try {
    const caps = JSON.parse(argsJson)?._escalation?.capabilities;
    return Array.isArray(caps) ? caps : null;
  } catch { return null; }
}

function approvalCardHtml(a) {
  const caps = approvalEscalationInfo(a.args_json);
  const banner = caps
    ? `<div class="approval-escalation-banner">⚠ capability escalation — approving lets <code>${esc(a.agent_id)}</code> act through an agent holding <strong>${esc(caps.join(', '))}</strong> it doesn't have. Only approve if you mean to.</div>`
    : '';
  const keys = 'Ctrl/Cmd+Alt+Enter approves · Ctrl/Cmd+Alt+Backspace rejects';
  return `<div class="approval-card ${approvalStaleClass(a)}${caps ? ' escalation' : ''}" data-approval-id="${a.id}" title="${keys}">
    ${banner}
    <div class="approval-main">
      <span class="approval-icon" aria-hidden="true">${approvalToolIcon(a.tool_name)}</span>
      <div class="approval-body">
        <div class="approval-title">${esc(a.tool_name)}</div>
        <div class="approval-meta">${esc(a.agent_id)} · ${approvalAgo(a.requested_at)}</div>
        ${approvalHighlightsHtml(a)}
        <button type="button" class="approval-detail-toggle" data-action="toggle-approval-detail">▸ raw args</button>
        <pre class="approval-detail hidden">${approvalArgsPreview(a.args_json)}</pre>
        <textarea class="approval-reason hidden" placeholder="reason (optional — sent to the agent on reject)" rows="2" aria-label="Rejection reason"></textarea>
      </div>
    </div>
    <div class="approval-actions">
      <button type="button" class="primary" data-action="approve-approval" title="${keys}">Approve</button>
      <button type="button" class="danger" data-action="reject-approval" title="${keys}">Reject</button>
    </div>
  </div>`;
}

function approvalStampHtml(a) {
  const ok = a.state === 'approved';
  const reason = a.reason ? ` · “${esc(a.reason)}”` : '';
  return `<div class="approval-stamp ${ok ? 'ok' : 'rej'}">
    <span class="approval-stamp-mark">${ok ? '✓ approved' : '✗ rejected'}</span>
    <span class="approval-stamp-body">${esc(a.tool_name)} · ${esc(a.agent_id)}${reason}</span>
    <span class="approval-when">${approvalAgo(a.decided_at || a.requested_at)}</span>
  </div>`;
}

/** Approve is one click; reject is two-step (first reveals the reason box). */
function approveApprovalClick(cardEl) {
  const id = Number(cardEl?.dataset.approvalId);
  if (id) decideApproval(id, 'approved', '', cardEl);
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
  decideApproval(id, 'rejected', cardEl.querySelector('.approval-reason')?.value.trim() || '', cardEl);
}

async function decideApproval(id, decision, reason, cardEl) {
  cardEl?.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const body = { decision };
    if (reason) body.reason = reason;
    await api('POST', `/admin/api/approvals/${id}/decide`, body);
    toast(decision === 'approved' ? 'approved' : 'rejected', decision === 'approved' ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err');   // 409 = already decided (race)
    cardEl?.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}

function toggleApprovalDetail(cardEl) {
  const pre = cardEl?.querySelector('.approval-detail');
  const btn = cardEl?.querySelector('.approval-detail-toggle');
  if (!pre || !btn) return;
  const show = pre.classList.contains('hidden');
  pre.classList.toggle('hidden', !show);
  btn.textContent = show ? '▾ hide raw args' : '▸ raw args';
}

// ---- project view ----------------------------------------------------------
function renderProjectView(pid) {
  const target = $('view-project');
  const p = projects.find(x => x.id === pid);
  if (!p) {
    target.innerHTML = '<div class="view-head"><div class="view-title-wrap"><h1 class="view-title">Project</h1></div></div>'
      + '<div class="view-body"><div class="empty">That project no longer exists.</div></div>';
    return;
  }
  const chats = convos.filter(c => c.project_id === pid);
  const tagged = files.filter(f => f.project_id === pid);
  const chatsHtml = chats.length
    ? chats.map(c => `<button type="button" class="link-row" data-action="open-chat" data-cid="${c.id}">
        <span class="link-row-title">${esc(c.title?.trim() ? c.title : '(new chat)')}</span>
        <span class="link-row-meta">${c.message_count} msg · ${fmtAge(c.started_at)}</span>
      </button>`).join('')
    : '<div class="empty">No chats filed here yet — open a chat and pick this project under “File under”.</div>';

  // files[] is only populated once the Files view has been visited; say so
  // rather than claiming the project has none.
  let filesHtml;
  if (!filesLoaded) {
    filesHtml = '<div class="empty">loading…</div>';
  } else if (tagged.length) {
    filesHtml = `<div class="table-wrap"><table class="ftable">
      <thead><tr><th>Path</th><th>Size</th><th>Modified</th><th></th></tr></thead>
      <tbody>${tagged.map(f => `<tr>
        <td class="path-cell">${esc(f.rel)}</td>
        <td class="num-cell">${fmtBytes(f.size)}</td>
        <td class="num-cell">${fmtAge(f.mtime)}</td>
        <td class="row-actions">
          <button type="button" data-action="download-file" data-path="${esc(f.path)}" title="Download">Download</button>
          <button type="button" data-action="untag-file" data-path="${esc(f.path)}" title="Remove from this project">Untag</button>
        </td>
      </tr>`).join('')}</tbody></table></div>`;
  } else {
    filesHtml = '<div class="empty">No files tagged here yet — tag one from the Files view.</div>';
  }

  target.innerHTML = `<div class="view-head">
      <div class="view-title-wrap">
        <h1 class="view-title">${esc(p.name)}</h1>
        <div class="view-sub">${p.chat_count} chat${p.chat_count === 1 ? '' : 's'} · ${p.file_count} file${p.file_count === 1 ? '' : 's'}</div>
      </div>
      <div class="head-actions">
        <button type="button" data-action="rename-project" data-pid="${p.id}" data-name="${esc(p.name)}">Rename</button>
        <button type="button" class="danger" data-action="delete-project" data-pid="${p.id}" data-name="${esc(p.name)}">Delete</button>
      </div>
    </div>
    <div class="view-body">
      <section class="block">
        <h2 class="block-head">Project instructions</h2>
        <div class="prompt-editor">
          <textarea id="proj-prompt" rows="6" spellcheck="false"
                    aria-label="Project instructions" placeholder="e.g. Answer as the compliance reviewer for this project…"></textarea>
          <div class="prompt-editor-row">
            <button type="button" class="primary" data-action="save-project-prompt" data-pid="${p.id}">Save</button>
            <span class="hint">Every chat filed under this project inherits these instructions. Empty clears them.</span>
          </div>
        </div>
      </section>
      <section class="block"><h2 class="block-head">Chats</h2>${chatsHtml}</section>
      <section class="block"><h2 class="block-head">Files</h2>${filesHtml}</section>
    </div>`;
  // Set as a value, not markup — the text can contain anything.
  $('proj-prompt').value = p.system_prompt || '';

  if (!filesLoaded && !filesLoading) {
    loadFiles().then(() => { if (parseHash()?.pid === pid) renderProjectView(pid); });
  }
}

async function newProject() {
  if (!agentId) return;
  const name = prompt('New project name');
  if (!name?.trim()) return;
  try {
    const p = await api('POST', `/admin/api/agents/${encodeURIComponent(agentId)}/projects`, { name: name.trim() });
    await refreshLists();
    go(projectPath(agentId, p.id));
  } catch (e) { toast(e.message, 'err'); }
}

async function renameProject(pid, current) {
  const name = prompt('Rename project', current);
  if (!name?.trim() || name.trim() === current) return;
  try {
    await api('PATCH', `/admin/api/projects/${pid}`, { name: name.trim() });
    await refreshLists();
    if (parseHash()?.pid === pid) renderProjectView(pid);
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteProject(pid, name) {
  const ok = confirm(`Delete project “${name}”?\n\nIts chats and files are only unfiled — no conversation is deleted and no file is removed from disk.`);
  if (!ok) return;
  try {
    await api('DELETE', `/admin/api/projects/${pid}`);
    await Promise.all([refreshLists(), reloadFilesIfLoaded()]);
    toast('project deleted');
    if (parseHash()?.pid === pid) go(chatPath(agentId));
  } catch (e) { toast(e.message, 'err'); }
}

// ---- files view ------------------------------------------------------------
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

async function loadFiles() {
  const seq = ctxSeq;
  filesLoading = true;
  try {
    const r = await api('GET', `/admin/api/agents/${encodeURIComponent(agentId)}/files`);
    if (seq !== ctxSeq) return;
    files = r.files || [];
    filesTruncated = !!r.truncated;
    filesLoaded = true;
  } catch (e) {
    files = [];
    filesLoaded = true;
    toast(e.message, 'err');
  } finally {
    filesLoading = false;
  }
}
async function reloadFilesIfLoaded() { if (filesLoaded) await loadFiles(); }

async function showFilesView() {
  $('view-files').innerHTML = '<div class="view-head"><div class="view-title-wrap"><h1 class="view-title">Files</h1></div></div>'
    + '<div class="view-body"><div class="empty">loading…</div></div>';
  await loadFiles();
  if (parseHash()?.view === 'files') renderFilesView();
}

function renderFilesView() {
  const target = $('view-files');
  const sub = hasWorkspaces
    ? `${files.length} file${files.length === 1 ? '' : 's'} across this agent's workspace roots`
    : 'no workspace roots';
  const head = `<div class="view-head">
      <div class="view-title-wrap">
        <h1 class="view-title">Files</h1>
        <div class="view-sub">${sub}</div>
      </div>
      <div class="head-actions">
        ${hasWorkspaces ? '<button type="button" data-action="pick-upload">Upload</button>' : ''}
        <button type="button" data-action="reload-files">Refresh</button>
      </div>
    </div>`;

  if (!hasWorkspaces) {
    target.innerHTML = `${head}<div class="view-body"><div class="empty-center">
      <p>This agent has no workspace roots.</p>
      <p>Add one in the <a href="/admin">classic admin</a>, under Agents → Workspaces.</p>
    </div></div>`;
    return;
  }
  if (!files.length) {
    target.innerHTML = `${head}<div class="view-body"><div class="empty-center">
      <p>No files in this agent's workspace yet.</p>
      <p>Upload one, or let the agent write it.</p>
    </div></div>`;
    return;
  }

  const banner = filesTruncated ? '<div class="banner">listing capped at 5000 entries</div>' : '';
  const rows = files.map(f => `<tr>
      <td class="path-cell" title="${esc(f.path)}">${esc(f.rel)}</td>
      <td class="num-cell">${fmtBytes(f.size)}</td>
      <td class="num-cell">${fmtAge(f.mtime)}</td>
      <td>${projectSelectHtml(f)}</td>
      <td class="row-actions">
        <button type="button" data-action="download-file" data-path="${esc(f.path)}" title="Download" aria-label="Download file">↓</button>
        <button type="button" class="danger" data-action="delete-file" data-path="${esc(f.path)}" title="Delete" aria-label="Delete file">✕</button>
      </td>
    </tr>`).join('');

  target.innerHTML = `${head}<div class="view-body">${banner}<div class="table-wrap"><table class="ftable">
      <thead><tr><th>Path</th><th>Size</th><th>Modified</th><th>Project</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>`;
}

function projectSelectHtml(f) {
  const opts = [`<option value=""${f.project_id == null ? ' selected' : ''}>(none)</option>`]
    .concat(projects.map(p =>
      `<option value="${p.id}"${p.id === f.project_id ? ' selected' : ''}>${esc(p.name)}</option>`));
  return `<select class="tag-select" data-change="tag-file" data-path="${esc(f.path)}" aria-label="Project for this file">${opts.join('')}</select>`;
}

async function tagFile(path, projectId) {
  try {
    await api('POST', `/admin/api/agents/${encodeURIComponent(agentId)}/files/tag`, { path, project_id: projectId });
    await Promise.all([loadFiles(), refreshLists()]);
    rerenderCurrentView();
  } catch (e) {
    toast(e.message, 'err');
    rerenderCurrentView();   // snap the select back to the server's truth
  }
}

/** The download endpoint needs the admin header, so a bare <a href> can't
 *  reach it — fetch the bytes and hand the browser an object URL instead. */
async function downloadFile(path) {
  const url = `/admin/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(path)}`;
  try {
    const r = await fetch(url, { headers: { 'X-Ritsu-Admin-Token': getAdminToken() } });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw new Error(j?.error || `${r.status}`);
    }
    const blob = await r.blob();
    const obj = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = obj;
    a.download = path.split('/').pop() || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(obj), 10_000);
  } catch (e) { toast(`download failed: ${e.message}`, 'err'); }
}

async function uploadFiles(fileList) {
  const list = Array.from(fileList || []);
  if (!list.length) return;
  let wrote = 0;
  for (const f of list) {
    if (f.size > MAX_UPLOAD_BYTES) { toast(`${f.name}: over the 25MB upload limit`, 'err'); continue; }
    const name = f.name.split(/[\\/]/).pop() || 'upload';
    const path = `uploads/${name}`;
    let data;
    try { data = await blobToBase64(f); }
    catch { toast(`${name}: could not read file`, 'err'); continue; }
    try {
      await api('POST', `/admin/api/agents/${encodeURIComponent(agentId)}/files`, { path, data, overwrite: false });
      wrote++;
    } catch (e) {
      if (/file exists/i.test(e.message) && confirm(`${path} already exists. Overwrite it?`)) {
        try {
          await api('POST', `/admin/api/agents/${encodeURIComponent(agentId)}/files`, { path, data, overwrite: true });
          wrote++;
        } catch (e2) { toast(`${name}: ${e2.message}`, 'err'); }
      } else if (!/file exists/i.test(e.message)) {
        toast(`${name}: ${e.message}`, 'err');
      }
    }
  }
  if (wrote) toast(`uploaded ${wrote} file${wrote === 1 ? '' : 's'}`);
  await loadFiles();
  rerenderCurrentView();
}

async function deleteFile(path) {
  if (!confirm(`Delete this file from the workspace?\n\n${path}\n\nThis removes it from disk.`)) return;
  try {
    await api('DELETE', `/admin/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(path)}`);
    toast('file deleted');
    await Promise.all([loadFiles(), refreshLists()]);
    rerenderCurrentView();
  } catch (e) { toast(e.message, 'err'); }
}

function rerenderCurrentView() {
  const r = parseHash();
  if (r?.view === 'files') renderFilesView();
  else if (r?.view === 'project') renderProjectView(r.pid);
}

// ---- live updates ----------------------------------------------------------
let convoSseAbort = null;
let approvalSseAbort = null;

function openStreams() {
  if (!convoSseAbort) {
    convoSseAbort = new AbortController();
    sseFetch('/admin/api/conversations/stream', onConvoEvent, convoSseAbort.signal);
  }
  if (!approvalSseAbort) {
    approvalSseAbort = new AbortController();
    sseFetch('/admin/api/approvals/stream', onApprovalEvent, approvalSseAbort.signal);
  }
}
function closeStreams() {
  convoSseAbort?.abort();
  approvalSseAbort?.abort();
  convoSseAbort = null;
  approvalSseAbort = null;
  inFlight.clear();
}

/** The stream carries every conversation event on the server; filter here. */
function onConvoEvent(ev) {
  if (ev.agent_id === agentId) scheduleRefresh();
  if (ev.kind === 'ask-start') inFlight.add(ev.conversation_id);
  if (ev.kind === 'ask-end') inFlight.delete(ev.conversation_id);
  if (ev.conversation_id !== convoId) return;
  if (ev.kind === 'message') reloadTranscript();
  else if (ev.kind === 'ask-start') ensurePendingBubble();
  else if (ev.kind === 'ask-end') removePendingBubble();
}

function onApprovalEvent(ev) {
  const a = ev?.approval;
  if (!a || a.conversation_id !== convoId) return;
  if (ev.kind === 'requested') {
    refreshInlineApprovals();
  } else if (ev.kind === 'decided') {
    // Flip the card to a stamp in place; the next full transcript reload
    // clears it once the agent's follow-up message lands.
    const card = $('transcript').querySelector(`.approval-card[data-approval-id="${Number(a.id)}"]`);
    if (card) card.outerHTML = approvalStampHtml(a);
  }
}

// Mobile Safari suspends backgrounded tabs hard: in-flight fetches die and the
// SSE connection can sit there delivering nothing. On every return to visible,
// force-reconnect and re-read the thread.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !agentId) return;
  closeStreams();
  openStreams();
  reloadTranscript();
  scheduleRefresh();
});

// ---- sidebar / menu chrome -------------------------------------------------
function openSidebar() {
  $('sidebar').classList.add('open');
  $('scrim').classList.add('show');
  document.querySelector('[data-action="toggle-sidebar"]')?.setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('scrim').classList.remove('show');
  document.querySelector('[data-action="toggle-sidebar"]')?.setAttribute('aria-expanded', 'false');
}
function closeMenus() {
  const menu = $('agent-menu');
  menu.classList.remove('open');
  menu.setAttribute('aria-hidden', 'true');
  $('agent-btn').setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.row-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.row-menu-btn.open').forEach(b => b.classList.remove('open'));
}

function toggleAgentMenu() {
  const menu = $('agent-menu');
  if (menu.classList.contains('open')) { closeMenus(); return; }
  closeMenus();
  menu.innerHTML = agents.map(a => `<button type="button" role="menuitem"
      class="agent-menu-item${a.id === agentId ? ' current' : ''}" data-action="pick-agent" data-agent="${esc(a.id)}">
      ${glyphFor(a.id)}
      <span class="agent-menu-body">
        <span class="agent-menu-name">${esc(a.name)}</span>
        <span class="agent-menu-desc">${esc(a.description)}</span>
      </span>
    </button>`).join('') || '<div class="side-empty">No enabled agents.</div>';
  menu.classList.add('open');
  menu.setAttribute('aria-hidden', 'false');
  $('agent-btn').setAttribute('aria-expanded', 'true');
}

function toggleProjectMenu(btn) {
  const menu = btn.parentElement?.querySelector('.row-menu');
  const wasOpen = menu?.classList.contains('open');
  closeMenus();
  if (menu && !wasOpen) { menu.classList.add('open'); btn.classList.add('open'); }
}

// iOS Safari shrinks the visual viewport for the keyboard but not the layout
// viewport, so a plain 100dvh shell would run behind the keyboard. Feed the
// real visible height to CSS. (element.style writes aren't style-src gated.)
function syncViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty('--vvh', `${vv ? vv.height : window.innerHeight}px`);
}

// ---- vendored renderers (mermaid + katex) -----------------------------------
// Both vendor scripts are `defer`, so a transcript can paint before they land.
// Nothing waits on them: the escaped source is already on screen and gets
// upgraded in place once the global appears.
function libReady(name) {
  if (globalThis[name]) return Promise.resolve(globalThis[name]);
  return new Promise(resolve => {
    let tries = 0;
    const tick = () => {
      if (globalThis[name]) resolve(globalThis[name]);
      else if (++tries > 120) resolve(null);   // ~6s, then give up quietly
      else setTimeout(tick, 50);
    };
    tick();
  });
}

function renderMath(root) {
  const nodes = [...root.querySelectorAll('[data-tex]:not(.math-done)')];
  if (!nodes.length) return;
  libReady('katex').then(katex => {
    if (!katex) return;
    for (const el of nodes) {
      el.classList.add('math-done');
      const src = el.textContent;
      try {
        katex.render(el.dataset.tex, el, { throwOnError: false, displayMode: el.classList.contains('math-block') });
      } catch {
        el.textContent = src;   // put the source back if katex bailed hard
      }
    }
  });
}

// Mermaid emits its theme CSS as a <style> inside the SVG, which style-src
// 'self' refuses. CSSOM is not policed by CSP, so the rules are lifted out and
// adopted through a constructed sheet instead — they are already scoped to the
// diagram's own id, so adopting them document-wide is safe.
let mermaidSheet = null;
let mermaidCss = '';
function adoptMermaidCss(css) {
  try {
    if (!mermaidSheet) {
      mermaidSheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, mermaidSheet];
    }
    if (mermaidCss.length > 400_000) mermaidCss = '';   // long session, stale diagrams
    mermaidCss += css;
    mermaidSheet.replaceSync(mermaidCss);
  } catch { /* no constructable stylesheets — the diagram renders unstyled */ }
}

function applyDecls(el, decls) {
  for (const d of String(decls).split(';')) {
    const i = d.indexOf(':');
    if (i > 0) {
      try { el.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); } catch { /* skip a bad declaration */ }
    }
  }
}

/**
 * style-src 'self' refuses style="…" attributes, and mermaid puts plenty of
 * them on the shapes it draws. Rename them in the SVG SOURCE so none ever
 * enters the live document, then replay each declaration through CSSOM, which
 * CSP does not police. Without this the diagram renders unstyled AND logs a
 * violation per element. Doing it on the string beats parsing first: an XML
 * parse can reject mermaid's HTML labels, and a DOMParser 'text/html'
 * document is NOT CSP-inert (it enforces the creating page's style-src).
 * mermaid's output is machine-generated and its text is escaped, so the
 * attribute form is unambiguous here.
 */
function mountSvg(out, svgText) {
  // Parse into an inert template first, then transform via DOM — regex over
  // markup is exactly the sanitization pattern that gets bypassed. An inert
  // template runs nothing; CSP style-src doesn't police it either, so the
  // style attributes are readable there, replayed through CSSOM on the live
  // nodes, and mermaid's <style> blocks are adopted and removed the same way.
  const tpl = document.createElement('template');
  tpl.innerHTML = svgText;
  for (const styleEl of tpl.content.querySelectorAll('style')) {
    adoptMermaidCss(styleEl.textContent || '');
    styleEl.remove();
  }
  const styled = [...tpl.content.querySelectorAll('[style]')];
  const decls = styled.map(el => {
    const d = el.getAttribute('style');
    el.removeAttribute('style');
    return d;
  });
  out.replaceChildren(tpl.content);
  // The moved nodes are the SAME node objects — styled[] references stay valid.
  styled.forEach((el, i) => applyDecls(el, decls[i]));
}

let mermaidInit = false;
let mermaidSeq = 0;
function renderMermaid(root) {
  const boxes = [...root.querySelectorAll('.mermaid-box:not(.mermaid-done)')];
  if (!boxes.length) return;
  libReady('mermaid').then(async (mermaid) => {
    if (!mermaid) return;
    if (!mermaidInit) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      mermaidInit = true;
    }
    for (const box of boxes) {
      box.classList.add('mermaid-done');
      const out = box.querySelector('.mermaid-out');
      if (!out) continue;
      try {
        const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, box.dataset.mermaid || '');
        mountSvg(out, svg);
      } catch (e) {
        // The source code block is still there — add one muted line saying why
        // it isn't a diagram.
        if (box.querySelector('.mermaid-err')) continue;
        const err = document.createElement('div');
        err.className = 'mermaid-err';
        err.textContent = `mermaid: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`;
        box.appendChild(err);
      }
    }
  });
}

// ---- artifacts --------------------------------------------------------------
// An assistant turn carrying a whole page or drawing gets a preview panel:
// a ```html / ```svg fence, a full document, or a bare <svg> block.
function artifactsIn(content) {
  const src = String(content ?? '');
  const found = [];
  for (const f of scanFences(src, true)) {
    const kind = f.lang.toLowerCase();
    if (kind === 'html' || kind === 'svg') found.push({ kind, code: f.body.trim() });
  }
  if (!found.length) {
    const doc = src.match(/<!doctype html[\s\S]*<\/html>/i)
      || src.match(/<html[\s>][\s\S]*<\/html>/i)
      || src.match(/<!doctype html[\s\S]*$/i);
    if (doc) found.push({ kind: 'html', code: doc[0].trim() });
    else {
      const svg = src.match(/<svg[\s>][\s\S]*?<\/svg>/i);
      if (svg) found.push({ kind: 'svg', code: svg[0].trim() });
    }
  }
  return found.filter(a => a.code);
}

function artifactLabel(a) {
  const t = a.code.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
  if (t?.[1].trim()) return t[1].trim().slice(0, 60);
  const first = a.code.split('\n').map(l => l.trim()).find(Boolean) || a.kind;
  return first.slice(0, 60);
}

// default-src 'none' with no connect-src: the frame cannot fetch, XHR, or open
// a socket anywhere. Combined with sandbox="allow-scripts" (and deliberately
// NO allow-same-origin) the page runs in an opaque origin with no reach.
const ARTIFACT_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
  + 'script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:;">';

/** The artifact with the deny-everything CSP as the FIRST head element. */
function artifactDoc(a) {
  const src = a.code;
  if (a.kind === 'svg' || !/<html[\s>]|<!doctype/i.test(src)) {
    return `<!doctype html><html><head>${ARTIFACT_CSP}</head><body>${src}</body></html>`;
  }
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (h) => h + ARTIFACT_CSP);
  if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, (h) => `${h}<head>${ARTIFACT_CSP}</head>`);
  return `<!doctype html><html><head>${ARTIFACT_CSP}</head><body>${src.replace(/<!doctype[^>]*>/i, '')}</body></html>`;
}

let artifacts = [];
let artifactIdx = 0;

function collectArtifacts() {
  const out = [];
  for (const m of lastRendered) {
    if (m.role !== 'assistant') continue;
    for (const a of artifactsIn(m.content)) out.push(a);
  }
  return out;
}

function openArtifactFromMsg(msgIdx) {
  artifacts = collectArtifacts();
  if (!artifacts.length) return;
  let n = 0;
  for (let i = 0; i < msgIdx && i < lastRendered.length; i++) {
    if (lastRendered[i].role === 'assistant') n += artifactsIn(lastRendered[i].content).length;
  }
  showArtifact(Math.min(n, artifacts.length - 1));
}

function showArtifact(i) {
  const a = artifacts[i];
  if (!a) return;
  artifactIdx = i;
  const sel = $('artifact-versions');
  sel.innerHTML = artifacts.map((x, k) => `<option value="${k}">v${k + 1} — ${esc(artifactLabel(x))}</option>`).join('');
  sel.value = String(i);
  $('artifact-frame').srcdoc = artifactDoc(a);
  $('artifact-panel').classList.remove('hidden');
  document.querySelector('.main').classList.add('with-artifact');
}

function closeArtifact() {
  $('artifact-panel').classList.add('hidden');
  document.querySelector('.main').classList.remove('with-artifact');
  $('artifact-frame').removeAttribute('srcdoc');
  artifacts = [];
}

// ---- generic modal ----------------------------------------------------------
function closeModal() { $('modal-host').replaceChildren(); }

/** Build a modal; `fill(card)` populates the card element. */
function openModal(fill, wide) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.dataset.action = 'modal-backdrop';
  const card = document.createElement('div');
  card.className = wide ? 'modal-card wide' : 'modal-card';
  back.appendChild(card);
  $('modal-host').appendChild(back);
  fill(card);
  return card;
}

// ---- composer palette -------------------------------------------------------
// "/" at position 0 opens commands + the saved-prompt library; "@" lists
// agents. Arrow keys move, Enter picks, Esc closes.
const PALETTE_BUILTINS = [
  { name: 'new', desc: 'start a new chat', action: 'new-chat' },
  { name: 'fork', desc: 'fork this chat', action: 'fork-chat' },
  { name: 'export', desc: 'export as markdown', action: 'export-chat' },
  { name: 'rename', desc: 'rename this chat', action: 'rename-chat' },
  { name: 'archive', desc: 'archive / unarchive', action: 'archive-chat' },
  { name: 'files', desc: 'open the file browser', action: 'open-files' },
];

let savedPrompts = [];
let paletteRows = [];
let paletteIdx = 0;

async function loadPrompts() {
  try {
    const r = await api('GET', `/admin/api/agents/${encodeURIComponent(agentId)}/prompts`);
    savedPrompts = r?.prompts || [];
  } catch { savedPrompts = []; }
}

function paletteOpen() { return $('palette').classList.contains('open'); }

function closePalette() {
  const el = $('palette');
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '';
  paletteRows = [];
}

/** Re-derive the palette from the composer's current text. */
function syncPalette() {
  const v = $('ask-input').value;
  const lead = v.slice(0, 1);
  if ((lead !== '/' && lead !== '@') || v.includes('\n')) { closePalette(); return; }
  const filter = v.slice(1).trim().toLowerCase();
  const rows = [];
  if (lead === '@') {
    for (const a of agents) {
      if (!filter || a.id.toLowerCase().includes(filter) || (a.name || '').toLowerCase().includes(filter)) {
        rows.push({ kind: 'agent', label: `@${a.id}`, desc: a.name || '', id: a.id });
      }
    }
  } else {
    for (const b of PALETTE_BUILTINS) {
      if (b.name.startsWith(filter)) rows.push({ kind: 'builtin', label: `/${b.name}`, desc: b.desc, action: b.action });
    }
    for (const p of savedPrompts) {
      if (!filter || p.name.toLowerCase().includes(filter)) {
        rows.push({ kind: 'prompt', label: `/${p.name}`, desc: p.agent_id ? '' : 'all agents', id: p.id });
      }
    }
  }
  // Nothing matches any more — the operator is writing a message that merely
  // starts with "/" or "@", so get out of the way and let Enter send it.
  if (!rows.length) { closePalette(); return; }
  if (lead === '/') rows.push({ kind: 'manage', label: 'manage prompts…', desc: '' });
  paletteRows = rows;
  // The filter just changed, so the previous highlight is meaningless — the
  // top row is the one the operator is aiming at.
  paletteIdx = 0;
  renderPalette();
}

function renderPalette() {
  const el = $('palette');
  el.innerHTML = paletteRows.map((r, i) =>
    `<button type="button" role="option" aria-selected="${i === paletteIdx}"`
    + ` class="palette-row${i === paletteIdx ? ' active' : ''}${r.kind === 'manage' ? ' palette-foot' : ''}"`
    + ` data-action="palette-pick" data-i="${i}">`
    + `<span class="palette-name">${esc(r.label)}</span>`
    + `<span class="palette-desc">${esc(r.desc)}</span></button>`).join('');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}

function movePalette(delta) {
  if (!paletteRows.length) return;
  paletteIdx = (paletteIdx + delta + paletteRows.length) % paletteRows.length;
  renderPalette();
  $('palette').querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
}

function pickPalette(i) {
  const row = paletteRows[i];
  if (!row) return;
  const input = $('ask-input');
  closePalette();
  if (row.kind === 'builtin') {
    input.value = '';
    autosize();
    ACTIONS[row.action]?.(document.body);
  } else if (row.kind === 'agent') {
    input.value = '';
    autosize();
    go(chatPath(row.id));
  } else if (row.kind === 'manage') {
    input.value = '';
    autosize();
    openPromptManager();
  } else {
    const p = savedPrompts.find(x => x.id === row.id);
    if (!p) return;
    const vars = parseVars(p.content);
    if (vars.length) openVarForm(p, vars);
    else applyPromptText(p.content);
  }
}

function applyPromptText(text) {
  const input = $('ask-input');
  input.value = text;
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ---- prompt variables -------------------------------------------------------
// {{name}} | {{name|type}} | {{name|type:prop="a,b"}}
const VAR_TYPES = new Set(['text', 'textarea', 'select', 'number', 'checkbox', 'date']);
// Whitespace tolerance lives in code (trim), not the pattern: \s* wrapping a
// lazy class was ambiguous enough to backtrack super-linearly.
const varRe = () => /\{\{([^}|]*)(?:\|\s*([A-Za-z]+)\s*(?::([^}]*))?)?\}\}/g;

function parseVars(content) {
  const out = [];
  const seen = new Set();
  const re = varRe();
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const type = (m[2] || 'text').toLowerCase();
    const props = {};
    // prop="a,b" | prop=[a,b] | prop=bare
    for (const pm of String(m[3] || '').matchAll(/([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|\[([^\]]*)\]|([^",[\s][^,\s]*))/g)) {
      props[pm[1]] = String(pm[2] ?? pm[3] ?? pm[4] ?? '').trim();
    }
    out.push({ name, type: VAR_TYPES.has(type) ? type : 'text', props });
  }
  return out;
}

function substituteVars(content, values) {
  return content.replace(varRe(), (whole, rawName) => {
    const k = rawName.trim();
    return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : whole;
  });
}

function openVarForm(prompt_, vars) {
  openModal((card) => {
    card.innerHTML = `<h2 class="modal-title">${esc(prompt_.name)}</h2>`
      + '<div class="modal-body" id="var-fields"></div>'
      + '<div class="modal-actions"><button type="button" data-action="close-modal">Cancel</button>'
      + '<button type="button" class="primary" data-action="apply-vars">Insert</button></div>';
    const host = card.querySelector('#var-fields');
    for (const v of vars) {
      const field = document.createElement('div');
      field.className = v.type === 'checkbox' ? 'field-row' : 'field';
      const label = document.createElement('label');
      label.textContent = v.name;
      let input;
      if (v.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 4;
      } else if (v.type === 'select') {
        input = document.createElement('select');
        for (const opt of String(v.props.options || '').split(',').map(o => o.trim()).filter(Boolean)) {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          input.appendChild(o);
        }
      } else {
        input = document.createElement('input');
        input.type = v.type === 'number' ? 'number' : v.type === 'checkbox' ? 'checkbox' : v.type === 'date' ? 'date' : 'text';
      }
      input.dataset.var = v.name;
      input.dataset.vtype = v.type;
      if (v.type === 'checkbox') { field.appendChild(input); field.appendChild(label); }
      else { field.appendChild(label); field.appendChild(input); }
      host.appendChild(field);
    }
    card.dataset.promptId = String(prompt_.id);
    host.querySelector('[data-var]')?.focus();
  });
}

function applyVarForm() {
  const card = $('modal-host').querySelector('.modal-card');
  if (!card) return;
  const p = savedPrompts.find(x => x.id === Number(card.dataset.promptId));
  if (!p) { closeModal(); return; }
  const values = {};
  for (const el of card.querySelectorAll('[data-var]')) {
    values[el.dataset.var] = el.dataset.vtype === 'checkbox' ? (el.checked ? 'yes' : 'no') : el.value;
  }
  closeModal();
  applyPromptText(substituteVars(p.content, values));
}

// ---- prompt library modal ---------------------------------------------------
function openPromptManager() {
  openModal((card) => {
    card.innerHTML = '<h2 class="modal-title">Saved prompts</h2>'
      + '<div class="modal-body"><div class="prompt-list" id="prompt-rows"></div></div>'
      + '<div class="modal-actions"><button type="button" data-action="new-prompt">New prompt</button>'
      + '<span class="flex1"></span><button type="button" data-action="close-modal">Close</button></div>';
    const host = card.querySelector('#prompt-rows');
    host.innerHTML = savedPrompts.length
      ? savedPrompts.map(p => `<div class="prompt-list-row">
          <span class="prompt-list-name">${esc(p.name)}</span>
          <span class="prompt-scope">${p.agent_id ? esc(p.agent_id) : 'all agents'}</span>
          <button type="button" data-action="edit-prompt" data-pid="${p.id}">Edit</button>
          <button type="button" class="danger" data-action="delete-prompt" data-pid="${p.id}">Delete</button>
        </div>`).join('')
      : '<div class="empty">No saved prompts yet.</div>';
  });
}

function openPromptEditor(pid) {
  const p = pid ? savedPrompts.find(x => x.id === pid) : null;
  openModal((card) => {
    card.innerHTML = `<h2 class="modal-title">${p ? 'Edit prompt' : 'New prompt'}</h2>`
      + '<div class="modal-body">'
      + '<div class="field"><label for="pe-name">Name</label><input id="pe-name" type="text" spellcheck="false"></div>'
      + '<div class="field"><label for="pe-content">Content</label>'
      + '<textarea id="pe-content" rows="10" spellcheck="false"></textarea>'
      + '<span class="hint">{{name}}, {{name|select:options="a,b"}} — variables prompt for a value when fired.</span></div>'
      + '<div class="field-row"><input id="pe-global" type="checkbox"><label for="pe-global">All agents</label>'
      + `${p ? '<span class="hint">scope is fixed after creation</span>' : ''}</div>`
      + '</div>'
      + '<div class="modal-actions"><button type="button" data-action="close-modal">Cancel</button>'
      + `<button type="button" class="primary" data-action="save-prompt" data-pid="${p ? p.id : ''}">Save</button></div>`;
    card.querySelector('#pe-name').value = p?.name || '';
    card.querySelector('#pe-content').value = p?.content || '';
    // The server's prompt PATCH takes {name?, content?} only, so an existing
    // prompt's scope can't be moved from here.
    const g = card.querySelector('#pe-global');
    g.checked = p ? p.agent_id == null : false;
    g.disabled = !!p;
    card.querySelector('#pe-name').focus();
  });
}

async function savePrompt(pid) {
  const card = $('modal-host').querySelector('.modal-card');
  const name = card?.querySelector('#pe-name')?.value.trim() || '';
  const content = card?.querySelector('#pe-content')?.value || '';
  if (!name || !content.trim()) { toast('name and content are required', 'err'); return; }
  try {
    if (pid) await api('PATCH', `/admin/api/prompts/${pid}`, { name, content });
    else await api('POST', '/admin/api/prompts', { name, content, agent_id: card.querySelector('#pe-global').checked ? null : agentId });
    await loadPrompts();
    openPromptManager();
    toast('saved');
  } catch (e) { toast(e.message, 'err'); }
}

async function deletePrompt(pid) {
  const p = savedPrompts.find(x => x.id === pid);
  if (!confirm(`Delete the saved prompt “${p?.name ?? pid}”?`)) return;
  try {
    await api('DELETE', `/admin/api/prompts/${pid}`);
    await loadPrompts();
    openPromptManager();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- context chips ----------------------------------------------------------
async function attachWebpage() {
  const url = prompt('Fetch a web page as context:', 'https://');
  if (!url?.trim() || url.trim() === 'https://') return;
  try {
    const r = await api('POST', `/admin/api/agents/${encodeURIComponent(agentId)}/fetch-url`, { url: url.trim() });
    // Already wrapped in the untrusted fence server-side — stored verbatim and
    // prepended verbatim; never unwrapped.
    contextChips.push({ label: r.host || 'page', text: r.text || '' });
    renderAttachTray();
    toast('page attached');
  } catch (e) { toast(e.message, 'err'); }
}

function openChatPicker() {
  const list = convos.filter(c => c.id !== convoId);
  openModal((card) => {
    card.innerHTML = '<h2 class="modal-title">Reference a chat</h2>'
      + '<div class="modal-body"><div class="prompt-list">'
      + (list.length
        ? list.map(c => `<button type="button" class="link-row" data-action="pick-ref-chat" data-cid="${c.id}">
            <span class="link-row-title">${esc(c.title?.trim() ? c.title : '(new chat)')}</span>
            <span class="link-row-meta">#${c.id} · ${fmtAge(c.started_at)}</span>
          </button>`).join('')
        : '<div class="empty">No other chats for this agent.</div>')
      + '</div></div>'
      + '<div class="modal-actions"><button type="button" data-action="close-modal">Cancel</button></div>';
  });
}

async function referenceChat(cid) {
  closeModal();
  try {
    const r = await api('POST', `/admin/api/conversations/${cid}/as-context`);
    contextChips.push({ label: `chat #${cid}`, text: r.text || '' });
    renderAttachTray();
    toast('chat attached');
  } catch (e) { toast(e.message, 'err'); }
}

// ---- sidebar hover preview --------------------------------------------------
// Desktop only: a phone has no hover, and the popover would fight the tap.
const previewCache = new Map();   // cid → { at, messages }
let hoverTimer = null;

function hoverCapable() {
  return window.matchMedia('(hover: hover) and (min-width: 801px)').matches;
}

function scheduleHoverPreview(row) {
  if (!hoverCapable()) return;
  const cid = Number(row.dataset.cid);
  if (!cid || cid === convoId) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showHoverPreview(row, cid), 350);
}

function hideHoverPreview() {
  clearTimeout(hoverTimer);
  const el = $('hover-preview');
  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');
}

async function showHoverPreview(row, cid) {
  let entry = previewCache.get(cid);
  if (!entry || Date.now() - entry.at > 30_000) {
    try {
      const { messages } = await api('GET', `/admin/api/conversations/${cid}?limit=20`);
      entry = { at: Date.now(), messages: messages || [] };
      previewCache.set(cid, entry);
    } catch { return; }
  }
  if (!row.isConnected || !hoverCapable()) return;
  const rows = entry.messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-2);
  const el = $('hover-preview');
  el.innerHTML = rows.length
    ? rows.map(m => {
        const text = String(m.content ?? '').replace(/\s+/g, ' ').trim();
        const clipped = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        return `<div class="hp-row"><span class="hp-role">${esc(m.role === 'user' ? 'you' : 'agent')}</span>`
          + `<span class="hp-text">${esc(clipped)}</span></div>`;
      }).join('')
    : '<div class="hp-empty">No messages yet.</div>';
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
  // element.style writes are not covered by style-src, so positioning here
  // keeps the CSP at 'self'.
  const r = row.getBoundingClientRect();
  el.style.left = `${Math.round(r.right + 10)}px`;
  el.style.top = `${Math.round(Math.min(r.top, window.innerHeight - el.offsetHeight - 12))}px`;
}

// ---- skills view ------------------------------------------------------------
let skillList = [];

async function loadSkills() {
  try {
    const r = await api('GET', '/admin/api/skills');
    skillList = r?.skills || [];
  } catch (e) {
    skillList = [];
    toast(e.message, 'err');
  }
}

async function showSkillsView() {
  $('view-skills').innerHTML = '<div class="view-head"><div class="view-title-wrap"><h1 class="view-title">Skills</h1></div></div>'
    + '<div class="view-body"><div class="empty">loading…</div></div>';
  await loadSkills();
  if (parseHash()?.view === 'skills') renderSkillsView();
}

function renderSkillsView() {
  const head = `<div class="view-head">
      <div class="view-title-wrap">
        <h1 class="view-title">Skills</h1>
        <div class="view-sub">${skillList.length} skill${skillList.length === 1 ? '' : 's'} · markdown instruction sets agents load on demand</div>
      </div>
      <div class="head-actions">
        <button type="button" data-action="new-skill">New skill</button>
        <button type="button" data-action="reload-skills">Refresh</button>
      </div>
    </div>`;
  if (!skillList.length) {
    $('view-skills').innerHTML = `${head}<div class="view-body"><div class="empty-center">
      <p>No skills yet.</p><p>Create one and bind it to an agent — the body only loads when the agent asks for it.</p>
    </div></div>`;
    return;
  }
  const rows = skillList.map(s => {
    const bound = (s.agents || []).includes(agentId);
    return `<tr data-action="edit-skill" data-sid="${s.id}">
      <td class="skill-name">${esc(s.name)}</td>
      <td>${esc(s.description || '')}</td>
      <td class="num-cell">${(s.agents || []).length}</td>
      <td class="num-cell">${fmtAge(s.updated_at)}</td>
      <td class="bind-cell" data-action="noop">
        <label><input type="checkbox" data-change="bind-skill" data-sid="${s.id}"${bound ? ' checked' : ''}>bound to ${esc(agentId)}</label>
      </td>
      <td class="row-actions">
        <button type="button" class="danger" data-action="delete-skill" data-sid="${s.id}" data-name="${esc(s.name)}">Delete</button>
      </td>
    </tr>`;
  }).join('');
  $('view-skills').innerHTML = `${head}<div class="view-body"><div class="table-wrap"><table class="ftable">
      <thead><tr><th>Name</th><th>Description</th><th>Agents</th><th>Updated</th><th>Bind</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>`;
}

async function openSkillEditor(sid) {
  let skill = null;
  if (sid) {
    try { skill = await api('GET', `/admin/api/skills/${sid}`); }
    catch (e) { toast(e.message, 'err'); return; }
  }
  openModal((card) => {
    card.innerHTML = `<h2 class="modal-title">${skill ? 'Edit skill' : 'New skill'}</h2>`
      + '<div class="modal-body">'
      + '<div class="field"><label for="sk-name">Name</label><input id="sk-name" type="text" spellcheck="false"></div>'
      + '<div class="field"><label for="sk-desc">Description</label><input id="sk-desc" type="text"></div>'
      + '<div class="field"><label for="sk-content">Content (markdown)</label>'
      + '<textarea id="sk-content" class="tall" spellcheck="false"></textarea></div>'
      + '</div>'
      + '<div class="modal-actions"><button type="button" data-action="close-modal">Cancel</button>'
      + `<button type="button" class="primary" data-action="save-skill" data-sid="${skill ? skill.id : ''}">Save</button></div>`;
    card.querySelector('#sk-name').value = skill?.name || '';
    card.querySelector('#sk-desc').value = skill?.description || '';
    card.querySelector('#sk-content').value = skill?.content || '';
    card.querySelector('#sk-name').focus();
  }, true);
}

async function saveSkill(sid) {
  const card = $('modal-host').querySelector('.modal-card');
  const name = card?.querySelector('#sk-name')?.value.trim() || '';
  const description = card?.querySelector('#sk-desc')?.value.trim() || '';
  const content = card?.querySelector('#sk-content')?.value || '';
  if (!name || !content.trim()) { toast('name and content are required', 'err'); return; }
  try {
    if (sid) await api('PATCH', `/admin/api/skills/${sid}`, { name, description, content });
    else await api('POST', '/admin/api/skills', { name, description, content });
    closeModal();
    await loadSkills();
    if (parseHash()?.view === 'skills') renderSkillsView();
    toast('saved');
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteSkill(sid, name) {
  if (!confirm(`Delete the skill “${name}”?\n\nThis unbinds it from all agents; chats keep whatever they already loaded.`)) return;
  try {
    await api('DELETE', `/admin/api/skills/${sid}`);
    await loadSkills();
    if (parseHash()?.view === 'skills') renderSkillsView();
    toast('skill deleted');
  } catch (e) { toast(e.message, 'err'); }
}

async function toggleSkillBind(sid, bound) {
  const enc = encodeURIComponent(agentId);
  try {
    if (bound) await api('POST', `/admin/api/agents/${enc}/skills`, { skill_id: sid });
    else await api('DELETE', `/admin/api/agents/${enc}/skills/${sid}`);
    await loadSkills();
    if (parseHash()?.view === 'skills') renderSkillsView();
  } catch (e) {
    toast(e.message, 'err');
    if (parseHash()?.view === 'skills') renderSkillsView();   // snap back
  }
}

// ---- project instructions ---------------------------------------------------
async function saveProjectPrompt(pid) {
  const box = $('proj-prompt');
  if (!box) return;
  const text = box.value.trim();
  try {
    await api('PATCH', `/admin/api/projects/${pid}/prompt`, { system_prompt: text || null });
    const p = projects.find(x => x.id === pid);
    if (p) p.system_prompt = text || null;
    toast(text ? 'instructions saved' : 'instructions cleared');
    renderChatHead();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- action delegation -----------------------------------------------------
const ACTIONS = {
  'copy-msg': async (el) => {
    const m = lastRendered[Number(el.dataset.idx)];
    if (!m) return;
    try { await navigator.clipboard.writeText(m.content); toast('copied'); }
    catch { toast('copy failed — clipboard needs a secure context', 'err'); }
  },
  'copy-code': async (el) => {
    const code = el.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
    try { await navigator.clipboard.writeText(code); el.textContent = 'copied'; setTimeout(() => { el.textContent = 'copy'; }, 1200); }
    catch { toast('copy failed — clipboard needs a secure context', 'err'); }
  },
  'toggle-chat-menu': () => {
    $('chat-menu').classList.toggle('open');
  },
  'toggle-archived': () => { showArchived = !showArchived; renderSidebar(); },
  'pin-chat': async () => {
    closeMenus();
    const c = convos.find(x => x.id === convoId);
    if (!c) return;
    try {
      await api('PATCH', `/admin/api/conversations/${convoId}/flags`, { pinned: !c.pinned });
      c.pinned = !c.pinned;
      renderChatHead(); renderSidebar();
    } catch (e) { toast(e.message, 'err'); }
  },
  'archive-chat': async () => {
    closeMenus();
    const c = convos.find(x => x.id === convoId);
    if (!c) return;
    try {
      await api('PATCH', `/admin/api/conversations/${convoId}/flags`, { archived: !c.archived });
      c.archived = !c.archived;
      renderChatHead(); renderSidebar();
      toast(c.archived ? 'archived — still searchable' : 'unarchived');
    } catch (e) { toast(e.message, 'err'); }
  },
  'fork-chat': async () => {
    closeMenus();
    if (!convoId) return;
    try {
      const r = await api('POST', `/admin/api/conversations/${convoId}/fork`, {});
      await loadAgentContext();
      go(`/a/${encodeURIComponent(agentId)}/c/${r.conversation_id}`);
      toast('forked');
    } catch (e) { toast(e.message, 'err'); }
  },
  'export-chat': () => {
    closeMenus();
    if (!lastRendered.length) { toast('nothing to export'); return; }
    const title = convoTitle(convoId);
    const lines = [`# ${title}`, ''];
    for (const m of lastRendered) {
      lines.push(`## ${m.role}${m.caller_label ? ` (${m.caller_label})` : ''}`, '', m.content, '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'chat'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  'rename-chat': async () => {
    closeMenus();
    if (!convoId) return;
    const current = convoTitle(convoId);
    const name = prompt('Chat title (empty reverts to automatic):', current === '(new chat)' ? '' : current);
    if (name === null) return;
    try {
      await api('PATCH', `/admin/api/conversations/${convoId}/title`, { title: name.trim() || null });
      const c = convos.find(x => x.id === convoId);
      if (c) c.title = name.trim();
      renderChatHead(); renderSidebar();
    } catch (e) { toast(e.message, 'err'); }
  },
  'delete-chat': async () => {
    closeMenus();
    if (!convoId) return;
    if (!confirm('Delete this chat and its messages? This cannot be undone.')) return;
    try {
      await api('DELETE', `/admin/api/conversations/${convoId}`);
      convos = convos.filter(x => x.id !== convoId);
      renderSidebar();
      go(`/a/${encodeURIComponent(agentId)}`);   // land on the default chat
    } catch (e) { toast(e.message, 'err'); }
  },
  'toggle-sidebar': () => ($('sidebar').classList.contains('open') ? closeSidebar() : openSidebar()),
  'close-sidebar': closeSidebar,
  'toggle-agent-menu': toggleAgentMenu,
  'pick-agent': (el) => { closeMenus(); go(chatPath(el.dataset.agent)); },
  'new-chat': newChat,
  'open-chat': (el) => go(chatPath(agentId, Number(el.dataset.cid))),
  'open-project': (el) => go(projectPath(agentId, Number(el.dataset.pid))),
  'open-files': () => go(filesPath(agentId)),
  'new-project': newProject,
  'toggle-project-menu': (el) => toggleProjectMenu(el),
  'rename-project': (el) => { closeMenus(); renameProject(Number(el.dataset.pid), el.dataset.name); },
  'delete-project': (el) => { closeMenus(); deleteProject(Number(el.dataset.pid), el.dataset.name); },
  'pick-attachment': () => { closeMenus(); $('ask-file').click(); },
  'remove-attachment': (el) => { attachments.splice(Number(el.dataset.idx), 1); renderAttachTray(); },
  'toggle-attach-menu': (el) => toggleProjectMenu(el),
  'attach-webpage': () => { closeMenus(); attachWebpage(); },
  'reference-chat': () => { closeMenus(); openChatPicker(); },
  'pick-ref-chat': (el) => referenceChat(Number(el.dataset.cid)),
  'remove-chip': (el) => { contextChips.splice(Number(el.dataset.idx), 1); renderAttachTray(); },
  'copy-mermaid': async (el) => {
    const src = el.closest('.mermaid-box')?.dataset.mermaid ?? '';
    try { await navigator.clipboard.writeText(src); el.textContent = 'copied'; setTimeout(() => { el.textContent = 'copy'; }, 1200); }
    catch { toast('copy failed — clipboard needs a secure context', 'err'); }
  },
  'pick-sibling': (el) => {
    const child = Number(el.dataset.child);
    if (!child) return;
    pathChoice[el.dataset.parent] = child;
    savePathChoice(convoId, pathChoice);
    renderPath();
    refreshInlineApprovals();
  },
  'edit-msg': (el) => startEdit(Number(el.dataset.idx)),
  'cancel-edit': cancelEdit,
  'regen-msg': (el) => regenerateMsg(Number(el.dataset.idx)),
  'continue-msg': () => sendLiteral('continue'),
  'open-artifact': (el) => openArtifactFromMsg(Number(el.dataset.idx)),
  'close-artifact': closeArtifact,
  'copy-artifact': async () => {
    try { await navigator.clipboard.writeText(artifacts[artifactIdx]?.code ?? ''); toast('copied'); }
    catch { toast('copy failed — clipboard needs a secure context', 'err'); }
  },
  'palette-pick': (el) => pickPalette(Number(el.dataset.i)),
  'close-modal': closeModal,
  'modal-backdrop': (el, e) => { if (e.target === el) closeModal(); },
  'apply-vars': applyVarForm,
  'new-prompt': () => openPromptEditor(null),
  'edit-prompt': (el) => openPromptEditor(Number(el.dataset.pid)),
  'save-prompt': (el) => savePrompt(el.dataset.pid ? Number(el.dataset.pid) : null),
  'delete-prompt': (el) => deletePrompt(Number(el.dataset.pid)),
  'open-skills': () => go(skillsPath(agentId)),
  'new-skill': () => openSkillEditor(null),
  'edit-skill': (el) => openSkillEditor(Number(el.dataset.sid)),
  'save-skill': (el) => saveSkill(el.dataset.sid ? Number(el.dataset.sid) : null),
  'delete-skill': (el) => deleteSkill(Number(el.dataset.sid), el.dataset.name),
  'reload-skills': async () => { await loadSkills(); renderSkillsView(); },
  'save-project-prompt': (el) => saveProjectPrompt(Number(el.dataset.pid)),
  'open-inherited-project': (el) => { const pid = Number(el.dataset.pid); if (pid) go(projectPath(agentId, pid)); },
  'noop': () => {},
  'zoom-attachment': (el) => openLightbox(el.getAttribute('src')),
  'close-lightbox': closeLightbox,
  'approve-approval': (el) => approveApprovalClick(el.closest('.approval-card')),
  'reject-approval': (el) => rejectApprovalClick(el.closest('.approval-card')),
  'toggle-approval-detail': (el) => toggleApprovalDetail(el.closest('.approval-card')),
  'pick-upload': () => $('upload-file').click(),
  'reload-files': async () => { await loadFiles(); rerenderCurrentView(); },
  'download-file': (el) => downloadFile(el.dataset.path),
  'delete-file': (el) => deleteFile(el.dataset.path),
  'untag-file': (el) => tagFile(el.dataset.path, null),
};

const CHANGES = {
  'file-chat': (el) => fileChatUnder(el),
  'tag-file': (el) => tagFile(el.dataset.path, el.value === '' ? null : Number(el.value)),
  'pick-artifact': (el) => showArtifact(Number(el.value)),
  'bind-skill': (el) => toggleSkillBind(Number(el.dataset.sid), el.checked),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  ACTIONS[el.dataset.action]?.(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  CHANGES[el.dataset.change]?.(el, e);
});

// Click-outside closes the popovers. Registered AFTER the action delegator so
// the click that opened a menu is handled first; the toggle check then bails.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="toggle-agent-menu"], [data-action="toggle-project-menu"], [data-action="toggle-chat-menu"], [data-action="toggle-attach-menu"]')) return;
  if (e.target.closest('.agent-menu, .row-menu')) return;
  closeMenus();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.lightbox')) { closeLightbox(); return; }
  if ($('modal-host').firstChild) { closeModal(); return; }
  if (paletteOpen()) { closePalette(); return; }
  if ($('agent-menu').classList.contains('open') || document.querySelector('.row-menu.open')) { closeMenus(); return; }
  if (editing) { cancelEdit(); return; }
  if (!$('artifact-panel').classList.contains('hidden')) { closeArtifact(); return; }
  if ($('sidebar').classList.contains('open')) closeSidebar();
});

// Decide the oldest pending approval without reaching for the mouse. Alt is in
// the chord because Ctrl/Cmd+Enter alone is too easy to hit while typing.
document.addEventListener('keydown', (e) => {
  if (!e.altKey || !(e.ctrlKey || e.metaKey)) return;
  if (e.key !== 'Enter' && e.key !== 'Backspace') return;
  if (!$('view-chat').classList.contains('active')) return;
  const card = $('transcript').querySelector('.approval-card');
  if (!card) return;
  e.preventDefault();
  if (e.key === 'Enter') approveApprovalClick(card);
  else rejectApprovalClick(card);
});

// ---- composer wiring -------------------------------------------------------
$('ask-form').addEventListener('submit', (e) => { e.preventDefault(); sendAsk(); });
$('ask-input').addEventListener('keydown', (e) => {
  // The palette owns the arrows and Enter while it is open.
  if (paletteOpen()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pickPalette(paletteIdx); return; }
    if (e.key === 'Tab') { e.preventDefault(); pickPalette(paletteIdx); return; }
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAsk(); }
});
$('ask-input').addEventListener('input', () => { autosize(); syncPalette(); });
$('ask-input').addEventListener('blur', () => {
  // Let a click on a palette row land before the dropdown disappears.
  setTimeout(() => { if (document.activeElement !== $('ask-input')) closePalette(); }, 150);
});
$('ask-input').addEventListener('paste', (e) => {
  const files_ = Array.from(e.clipboardData?.items || [])
    .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
    .map(it => it.getAsFile())
    .filter(Boolean);
  if (files_.length) { e.preventDefault(); addAttachmentFiles(files_); }
});
$('ask-file').addEventListener('change', (e) => {
  addAttachmentFiles(e.target.files);
  e.target.value = '';   // allow re-picking the same file
});
$('upload-file').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
});

const composer = $('ask-form');
composer.addEventListener('dragover', (e) => {
  if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
  e.preventDefault();
  composer.classList.add('dragging');
});
composer.addEventListener('dragleave', (e) => { if (e.target === composer) composer.classList.remove('dragging'); });
composer.addEventListener('drop', (e) => {
  composer.classList.remove('dragging');
  const dropped = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
  if (dropped.length) { e.preventDefault(); addAttachmentFiles(dropped); }
});

$('sidebar').addEventListener('mouseover', (e) => {
  const row = e.target.closest('[data-action="open-chat"][data-cid]');
  if (row) scheduleHoverPreview(row);
});
$('sidebar').addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-action="open-chat"][data-cid]')) hideHoverPreview();
});
$('sidebar').addEventListener('scroll', hideHoverPreview, true);

$('side-search').addEventListener('input', debounce((e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderSidebar();          // instant client-side pass
  runDeepSearch();          // then the server pass over message bodies
}, 120));

window.addEventListener('hashchange', () => { onRoute(); });
window.visualViewport?.addEventListener('resize', syncViewport);
window.addEventListener('resize', syncViewport);

// ---- bootstrap -------------------------------------------------------------

/** Pending-approvals badge on the rail's Operations icon. A cheap COUNT(*)
 *  poll — the ops board itself is the live surface. */
async function refreshRailOpsBadge() {
  try {
    const { pending } = await api('GET', '/admin/api/approvals/count');
    const badge = $('rail-ops-badge');
    if (!badge) return;
    badge.textContent = String(pending);
    badge.classList.toggle('hidden', !pending);
  } catch { /* badge is best-effort */ }
}

async function boot() {
  syncViewport();
  refreshRailOpsBadge();
  setInterval(refreshRailOpsBadge, 30_000);
  try {
    await loadAgents();
  } catch (e) {
    $('view-chat').classList.add('active');
    // Built as DOM nodes: the message can carry server-derived text, and
    // textContent is inert without any escaping.
    const div = document.createElement('div');
    div.className = 'empty txt-err';
    div.textContent = `could not load agents: ${e.message}`;
    $('transcript').replaceChildren(div);
    return;
  }
  if (!agents.length) {
    $('view-chat').classList.add('active');
    $('agent-btn-label').textContent = 'no agents';
    $('transcript').innerHTML = '<div class="empty-center"><p>No enabled agents yet.</p>'
      + '<p>Create one in the <a href="/admin">classic admin</a>.</p></div>';
    return;
  }
  openStreams();
  await onRoute();
}

boot();

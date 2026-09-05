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
let sending = false;
let attachments = [];       // pasted/dropped/picked but not yet sent
const inFlight = new Set(); // conversation ids someone is mid-turn on

// Sequence guards: a slow response for an agent/chat the operator has already
// navigated away from must not paint over the newer one.
let ctxSeq = 0;
let txSeq = 0;

// ---- routing ---------------------------------------------------------------
const chatPath = (id, cid) => `/a/${encodeURIComponent(id)}${cid ? `/c/${cid}` : ''}`;
const projectPath = (id, pid) => `/a/${encodeURIComponent(id)}/p/${pid}`;
const filesPath = (id) => `/a/${encodeURIComponent(id)}/files`;
function go(path) { location.hash = path; }

function parseHash() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  if (parts[0] !== 'a' || !parts[1]) return null;
  let id;
  try { id = decodeURIComponent(parts[1]); } catch { return null; }
  if (parts[2] === 'c' && Number.isInteger(Number(parts[3]))) return { id, view: 'chat', cid: Number(parts[3]) };
  if (parts[2] === 'p' && Number.isInteger(Number(parts[3]))) return { id, view: 'project', pid: Number(parts[3]) };
  if (parts[2] === 'files') return { id, view: 'files' };
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
    clearAttachments();
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
  } else {
    await showFilesView();
  }
}

function showView(view) {
  for (const v of ['chat', 'project', 'files']) {
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
  const [def, dc, projs, convList, ws] = await Promise.all([
    api('GET', `/admin/agents/${enc}`).catch(() => null),
    api('GET', `/admin/api/agents/${enc}/default-chat`).catch(() => null),
    api('GET', `/admin/api/agents/${enc}/projects`).catch(() => ({ projects: [] })),
    api('GET', `/admin/api/conversations?agent_id=${enc}&kind=human&limit=200`).catch(() => ({ conversations: [] })),
    api('GET', `/admin/agents/${enc}/workspaces`).catch(() => ({ workspaces: [] })),
  ]);
  if (seq !== ctxSeq) return;
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

function renderChatList() {
  const target = $('side-chats');
  // Filed chats live under their project; the default chat is pinned above.
  const list = convos
    .filter(c => c.id !== defaultChat?.conversation_id && c.project_id == null)
    .filter(c => matchesSearch(c.title || '(new chat)'));
  if (!list.length) {
    target.innerHTML = convos.length
      ? '<div class="side-empty">no match</div>'
      : '<div class="side-empty">No chats yet.</div>';
    return;
  }
  const now = Date.now() / 1000;
  const buckets = CHAT_GROUPS.map(g => ({ ...g, rows: [] }));
  for (const c of list) {
    const age = now - (c.started_at || 0);
    (buckets.find(b => age < b.max) ?? buckets[buckets.length - 1]).rows.push(c);
  }
  target.innerHTML = buckets.filter(b => b.rows.length).map(b =>
    `<div class="side-group">${b.label}</div>` + b.rows.map(chatRowHtml).join(''),
  ).join('');
}

function chatRowHtml(c) {
  const active = isChatOpen(c.id) ? ' active' : '';
  const title = c.title?.trim() ? c.title : '(new chat)';
  return `<div class="side-row">
    <button type="button" class="side-item${active}" data-action="open-chat" data-cid="${c.id}">
      <span class="side-item-title">${esc(title)}</span>
      <span class="side-item-age">${fmtAge(c.started_at)}</span>
    </button>
  </div>`;
}

function isChatOpen(cid) {
  return $('view-chat').classList.contains('active') && convoId === cid;
}

/** The message list behind the current transcript render, for copy actions. */
let lastRendered = [];

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

  const isDefault = convoId === defaultChat?.conversation_id;
  $('chat-menu-wrap').classList.toggle('hidden', !convoId);
  // Renaming the default chat is fine; deleting the anchor is refused
  // server-side too — hiding the option just keeps the menu honest.
  $('chat-menu-delete').classList.toggle('hidden', isDefault);

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
  renderChatHead();
  const t = $('transcript');
  if (!cid) { t.innerHTML = '<div class="empty">No conversation yet — send something below.</div>'; return; }
  const seq = ++txSeq;
  t.innerHTML = '<div class="empty">loading…</div>';
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
function md(raw) {
  const blocks = [];
  let text = String(raw ?? '').replace(/```([A-Za-z0-9_+.-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang, code });
    return `\u0000B${blocks.length - 1}\u0000`;
  });
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
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text = text
    .replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/<\/blockquote>\n<blockquote>/g, '<br>');
  text = text.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (m, body) =>
    '\n<ul>' + body.trim().split('\n').map(l => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>\n');
  text = text.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (m, body) =>
    '\n<ol>' + body.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('') + '</ol>\n');
  text = text.replace(/^(?:---+|\*\*\*+)$/gm, '<hr>');
  text = text.replace(/\n{2,}/g, '\u0000P\u0000').replace(/\n/g, '<br>');
  text = text
    .replace(/\u0000P\u0000/g, '<div class="md-gap"></div>')
    .replace(/(<\/(?:h2|h3|h4|h5|ul|ol|blockquote)>|<hr>)<br>/g, '$1')
    .replace(/<br>(<(?:h2|h3|h4|h5|ul|ol|blockquote|hr)[ >])/g, '$1');
  text = text.replace(/\u0000B(\d+)\u0000(?:<br>)?/g, (_, i) => {
    const b = blocks[+i];
    return '<div class="codeblock"><div class="codebar">'
      + `<span class="codelang">${esc(b.lang || 'text')}</span>`
      + '<button type="button" class="codecopy" data-action="copy-code">copy</button></div>'
      + `<pre><code>${esc(b.code.replace(/\n$/, ''))}</code></pre></div>`;
  });
  return text;
}
// MD-PURE-END

function renderTranscript(messages) {
  const t = $('transcript');
  const visible = (messages || []).filter(m => m.role !== 'system');
  if (!visible.length) {
    t.innerHTML = '<div class="empty">No messages yet — send something below.</div>';
  } else {
    // Byline only when the caller is another agent; everything else (admin
    // token, MCP bearer, this browser) is just "you".
    const agentIds = new Set(agents.map(a => a.id));
    lastRendered = visible;
    t.innerHTML = visible.map((m, i) => {
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
      return `<div class="msg ${esc(m.role)}">${byline}${body}${atts}${copy}</div>`;
    }).join('');
  }
  if (convoId !== null && inFlight.has(convoId)) ensurePendingBubble();
  t.scrollTop = t.scrollHeight;
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
  input.value = '';
  autosize();
  // Snapshot + clear so the tray empties immediately and a double-tap can't
  // resend; restored into the tray if the send fails.
  const sent = attachments;
  clearAttachments();
  const optimistic = appendMsg('user', msg, sent.map(a => a.url));
  try {
    const body = { message: msg };
    if (convoId) body.conversation_id = convoId;
    if (sent.length) body.attachments = sent.map(a => ({ media_type: a.media_type, data: a.data }));
    const resp = await api('POST', `/admin/agents/${encodeURIComponent(agentId)}/ask`, body);
    if (resp?.conversation_id) convoId = resp.conversation_id;
    await reloadTranscript();
    scheduleRefresh();
  } catch (e) {
    // Losing the operator's text into the void is the worst failure here, so
    // put the bubble away and the message (and images) back in the box.
    optimistic.remove();
    removePendingBubble();
    input.value = msg;
    autosize();
    if (sent.length) { attachments = sent; renderAttachTray(); }
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
  if (!attachments.length) {
    tray.classList.remove('show');
    tray.setAttribute('aria-hidden', 'true');
    tray.innerHTML = '';
    return;
  }
  tray.classList.add('show');
  tray.setAttribute('aria-hidden', 'false');
  tray.innerHTML = attachments.map((a, i) =>
    `<div class="attach-chip"><img src="${a.url}" alt="attachment ${i + 1}"><button type="button" data-action="remove-attachment" data-idx="${i}" title="remove" aria-label="Remove attachment">✕</button></div>`,
  ).join('');
}
function clearAttachments() { attachments = []; renderAttachTray(); }

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
  } catch { /* best-effort — the classic admin's Approvals tab is durable */ }
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
  return `<div class="approval-card ${approvalStaleClass(a)}${caps ? ' escalation' : ''}" data-approval-id="${a.id}">
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
      <button type="button" class="primary" data-action="approve-approval">Approve</button>
      <button type="button" class="danger" data-action="reject-approval">Reject</button>
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
      <section class="block"><h2 class="block-head">Chats</h2>${chatsHtml}</section>
      <section class="block"><h2 class="block-head">Files</h2>${filesHtml}</section>
    </div>`;

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
  'pick-attachment': () => $('ask-file').click(),
  'remove-attachment': (el) => { attachments.splice(Number(el.dataset.idx), 1); renderAttachTray(); },
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
  if (e.target.closest('[data-action="toggle-agent-menu"], [data-action="toggle-project-menu"], [data-action="toggle-chat-menu"]')) return;
  if (e.target.closest('.agent-menu, .row-menu')) return;
  closeMenus();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.lightbox')) { closeLightbox(); return; }
  if ($('agent-menu').classList.contains('open') || document.querySelector('.row-menu.open')) { closeMenus(); return; }
  if ($('sidebar').classList.contains('open')) closeSidebar();
});

// ---- composer wiring -------------------------------------------------------
$('ask-form').addEventListener('submit', (e) => { e.preventDefault(); sendAsk(); });
$('ask-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAsk(); }
});
$('ask-input').addEventListener('input', autosize);
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

$('side-search').addEventListener('input', debounce((e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderSidebar();
}, 120));

window.addEventListener('hashchange', () => { onRoute(); });
window.visualViewport?.addEventListener('resize', syncViewport);
window.addEventListener('resize', syncViewport);

// ---- bootstrap -------------------------------------------------------------
async function boot() {
  syncViewport();
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

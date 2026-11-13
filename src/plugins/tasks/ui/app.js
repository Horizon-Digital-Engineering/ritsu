const { api, esc, toast, registerTab, registerAction, registerChange } = window.ritsu;
const P = '/admin/api/plugins/tasks';
const AGENT = 'tasks-assistant';

// Fire-and-forget for handlers that start async work and move on: a rejection
// becomes a visible toast instead of an unhandled promise in the console.
function background(promise) { promise.catch(e => toast(e?.message || String(e), 'err')); }

let sessions = [];
let current = null;      // { session, items }
let tagCache = [];
let backlog = { q: '', tag: '', items: [], done: [] };

// ---- shared pieces ----------------------------------------------------------

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysUntil(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const [ty, tm, td] = todayIso().split('-').map(Number);
  return Math.round((new Date(y, m - 1, d) - new Date(ty, tm - 1, td)) / 86400000);
}

function dueText(iso) {
  const n = daysUntil(iso);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 0) return `${-n}d overdue`;
  return `in ${n}d`;
}

function dueChip(iso) {
  if (!iso) return '';
  const cls = daysUntil(iso) < 0 ? 'tk-due over' : 'tk-due';
  return `<span class="${cls}" title="${esc(iso)}">${esc(dueText(iso))}</span>`;
}

function tagChips(tags) {
  return tags.map(t => `<span class="tk-tag">${esc(t)}</span>`).join('');
}

function chatHref(cid) {
  return `/admin/workspace#/a/${AGENT}/c/${cid}`;
}

function statusNote(i) {
  if (i.status === 'dropped') {
    const why = i.drop_reason ? `: ${esc(i.drop_reason)}` : '';
    return `<span class="tk-dropped">dropped${why}</span>`;
  }
  if (i.blocker) return `<span class="tk-blocker">blocked: ${esc(i.blocker)}</span>`;
  return '';
}

function itemRow(i, opts) {
  const o = opts || {};
  const checked = i.status === 'done' ? ' checked' : '';
  const notes = i.notes ? `<div class="tk-notes">${esc(i.notes)}</div>` : '';
  const high = i.priority ? '<span class="tk-high" title="high priority">!</span>' : '';
  const pull = o.pull ? `<button type="button" class="tk-mini" data-action="tk-pull" data-id="${i.id}" title="Add to the latest session">pull</button>` : '';
  const drop = i.status === 'open' ? `<button type="button" class="tk-mini" data-action="tk-drop" data-id="${i.id}" title="Drop with a reason">drop</button>` : '';
  const reopen = i.status === 'dropped' ? `<button type="button" class="tk-mini" data-action="tk-reopen" data-id="${i.id}">reopen</button>` : '';
  const childCls = o.child ? ' tk-child' : '';
  return `<div class="tk-row ${esc(i.status)}${childCls}" data-item="${i.id}">
    <input type="checkbox" data-change="tk-done" data-id="${i.id}" aria-label="done"${checked}>
    <div class="tk-main">
      <div class="tk-title-line">${high}<span class="tk-title">${esc(i.title)}</span>${tagChips(i.tags)}${dueChip(i.due)}${statusNote(i)}</div>
      ${notes}
    </div>
    <div class="tk-actions">${pull}${drop}${reopen}</div>
  </div>`;
}

/** Subtasks render under their parent when the parent is in the same list. */
function itemList(items, opts) {
  if (!items.length) return '';
  const ids = new Set(items.map(i => i.id));
  const top = items.filter(i => i.parent_id == null || !ids.has(i.parent_id));
  return top.map(i => {
    const kids = items.filter(k => k.parent_id === i.id).map(k => itemRow(k, { ...opts, child: true })).join('');
    return itemRow(i, opts) + kids;
  }).join('');
}

function splitByStatus(items) {
  return {
    open: items.filter(i => i.status === 'open'),
    closed: items.filter(i => i.status !== 'open'),
  };
}

// ---- Session tab --------------------------------------------------------------

function sessionSkeleton() {
  return `
    <div class="panel">
      <div class="tk-toolbar">
        <form id="tk-new-form" class="tk-new">
          <input id="tk-topic" placeholder="topic (optional): taxes, house, general" maxlength="120">
          <button type="submit" class="primary">New session</button>
        </form>
        <span class="flex1"></span>
        <label class="tk-pick-label">viewing <select id="tk-session-pick" data-change="tk-pick" aria-label="Session"></select></label>
      </div>
      <p class="txt-muted tk-hint">A session is a chat. Open one, say what you want to work on today, and the list builds itself. Nothing carries over unless you ask.</p>
      <div id="tk-session">loading…</div>
    </div>`;
}

function renderSessionPane(pane) {
  pane.innerHTML = sessionSkeleton();
  pane.querySelector('#tk-new-form').addEventListener('submit', (e) => { e.preventDefault(); background(newSession()); });
  background(loadSessions().then(() => loadSession(current?.session.id ?? sessions[0]?.id ?? null)));
}

async function loadSessions() {
  const r = await api('GET', `${P}/sessions?limit=60`);
  sessions = r.sessions;
  const sel = document.getElementById('tk-session-pick');
  if (!sel) return;
  const opts = sessions.map(s => `<option value="${s.id}">${esc(s.title)}</option>`);
  sel.innerHTML = opts.join('') || '<option value="">no sessions yet</option>';
  if (current) sel.value = String(current.session.id);
}

async function loadSession(id) {
  const box = document.getElementById('tk-session');
  if (!box) return;
  if (id == null) {
    current = null;
    box.innerHTML = '<p class="txt-muted">No sessions yet. Start one above.</p>';
    return;
  }
  current = await api('GET', `${P}/sessions/${id}`);
  const sel = document.getElementById('tk-session-pick');
  if (sel) sel.value = String(id);
  renderSession();
}

function renderSession() {
  const box = document.getElementById('tk-session');
  if (!box || !current) return;
  const { session, items } = current;
  const { open, closed } = splitByStatus(items);
  const total = items.filter(i => i.status !== 'dropped').length;
  const doneCount = items.filter(i => i.status === 'done').length;
  const count = total ? `${doneCount} of ${total} done` : 'empty';
  const openHtml = open.length ? itemList(open) : '<p class="txt-muted">Nothing open in this session.</p>';
  const closedHtml = closed.length ? `<details class="tk-closed"><summary>${closed.length} closed</summary>${itemList(closed)}</details>` : '';
  box.innerHTML = `
    <div class="tk-session-head">
      <h2 class="tk-session-title">${esc(session.title)}</h2>
      <span class="tk-count">${esc(count)}</span>
      <a class="chip action" href="${chatHref(session.conversation_id)}">open chat</a>
    </div>
    ${openHtml}${closedHtml}`;
}

async function newSession() {
  const topic = document.getElementById('tk-topic').value.trim();
  await api('POST', `/admin/api/plugins/tasks/agent`, {});
  // The agent's default chat is whichever human thread exists first; make sure
  // it does before this session's chat, or the session would become it.
  await api('GET', `/admin/api/agents/${AGENT}/default-chat`);
  const { conversation_id } = await api('POST', `/admin/api/agents/${AGENT}/conversations`, {});
  const s = await api('POST', `${P}/sessions`, { conversation_id, topic });
  await api('PATCH', `/admin/api/conversations/${conversation_id}/title`, { title: s.title });
  location.href = chatHref(conversation_id);
}

async function setDone(id, done) {
  const session_id = current?.session.id ?? null;
  await api('PATCH', `${P}/items/${id}`, { status: done ? 'done' : 'open', session_id });
  await refreshAll();
}

async function dropItem(id) {
  const reason = prompt('Drop it. Why? (optional)');
  if (reason === null) return;
  await api('PATCH', `${P}/items/${id}`, { status: 'dropped', reason, session_id: current?.session.id ?? null });
  await refreshAll();
}

async function reopenItem(id) {
  await api('PATCH', `${P}/items/${id}`, { status: 'open', session_id: current?.session.id ?? null });
  await refreshAll();
}

async function pullItem(id) {
  const target = current?.session.id ?? sessions[0]?.id;
  if (!target) { toast('start a session first', 'err'); return; }
  await api('POST', `${P}/sessions/${target}/items`, { item_id: id });
  toast('added to the session', 'ok');
  await refreshAll();
}

async function refreshAll() {
  if (document.getElementById('tk-session') && current) await loadSession(current.session.id);
  if (document.getElementById('tk-backlog')) await loadBacklog();
}

// ---- Backlog tab ----------------------------------------------------------------

function backlogSkeleton() {
  return `
    <div class="panel">
      <form id="tk-add-form" class="tk-add">
        <input id="tk-add-title" placeholder="add to the backlog…" required maxlength="200">
        <input id="tk-add-tags" placeholder="tags, comma separated" maxlength="120">
        <button type="submit" class="primary">Add</button>
      </form>
      <form id="tk-search-form" class="tk-search">
        <input id="tk-q" type="search" placeholder="search title and notes" maxlength="200">
        <button type="submit">Search</button>
      </form>
      <div id="tk-tags" class="tk-tags"></div>
      <div id="tk-backlog">loading…</div>
    </div>`;
}

function renderBacklogPane(pane) {
  pane.innerHTML = backlogSkeleton();
  pane.querySelector('#tk-add-form').addEventListener('submit', (e) => { e.preventDefault(); background(addItem()); });
  pane.querySelector('#tk-search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    backlog.q = document.getElementById('tk-q').value.trim();
    background(loadBacklog());
  });
  background(loadSessions().then(loadBacklog));
}

async function loadBacklog() {
  const qs = new URLSearchParams();
  if (backlog.q) qs.set('q', backlog.q);
  if (backlog.tag) qs.set('tag', backlog.tag);
  const [open, done, tags] = await Promise.all([
    api('GET', `${P}/items?status=open&limit=500&${qs}`),
    api('GET', `${P}/items?status=done&limit=50&${qs}`),
    api('GET', `${P}/tags`),
  ]);
  backlog.items = open.items;
  backlog.done = done.items;
  tagCache = tags.tags;
  renderTags();
  renderBacklog();
}

function renderTags() {
  const box = document.getElementById('tk-tags');
  if (!box) return;
  const all = backlog.tag ? '' : ' active';
  const chips = tagCache.map(t => {
    const active = backlog.tag === t.tag ? ' active' : '';
    return `<button type="button" class="fin-chip${active}" data-action="tk-tag" data-tag="${esc(t.tag)}">${esc(t.tag)} <span class="txt-muted">${t.count}</span></button>`;
  });
  box.innerHTML = `<button type="button" class="fin-chip${all}" data-action="tk-tag" data-tag="">all</button>${chips.join('')}`;
}

function groupByTag(items) {
  const groups = new Map();
  for (const i of items) {
    const key = i.tags[0] || 'untagged';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function renderBacklog() {
  const box = document.getElementById('tk-backlog');
  if (!box) return;
  const canPull = sessions.length > 0;
  let openHtml = '<p class="txt-muted">Nothing open. Either you are done or you have not started.</p>';
  if (backlog.items.length) {
    openHtml = groupByTag(backlog.items).map(([tag, items]) => {
      const head = `<h3 class="tk-group-head">${esc(tag)} <span class="txt-muted">${items.length}</span></h3>`;
      return `<div class="tk-group">${head}${itemList(items, { pull: canPull })}</div>`;
    }).join('');
  }
  const doneHtml = backlog.done.length ? `<details class="tk-closed"><summary>recently done (${backlog.done.length})</summary>${itemList(backlog.done)}</details>` : '';
  box.innerHTML = openHtml + doneHtml;
}

async function addItem() {
  const title = document.getElementById('tk-add-title').value.trim();
  if (!title) return;
  const tags = document.getElementById('tk-add-tags').value.split(',').map(s => s.trim()).filter(Boolean);
  await api('POST', `${P}/items`, { title, tags });
  document.getElementById('tk-add-title').value = '';
  await loadBacklog();
}

// ---- Sessions (history) tab -------------------------------------------------------

function renderHistoryPane(pane) {
  pane.innerHTML = '<div class="panel"><h2>Sessions</h2><div id="tk-history">loading…</div></div>';
  background(loadHistory());
}

async function loadHistory() {
  const box = document.getElementById('tk-history');
  if (!box) return;
  const { sessions: rows } = await api('GET', `${P}/sessions?limit=200`);
  if (!rows.length) { box.innerHTML = '<p class="txt-muted">No sessions yet.</p>'; return; }
  const tr = rows.map(s => {
    const dropped = s.dropped ? `<span class="txt-muted"> · ${s.dropped} dropped</span>` : '';
    return `<tr>
      <td>${esc(s.date)}</td>
      <td>${esc(s.topic || '—')}</td>
      <td class="num">${s.open}</td>
      <td class="num">${s.done}${dropped}</td>
      <td class="row-actions"><button type="button" class="tk-mini" data-action="tk-view" data-id="${s.id}">view</button> <a class="tk-mini-link" href="${chatHref(s.conversation_id)}">chat</a></td>
    </tr>`;
  }).join('');
  box.innerHTML = `<table class="tk-table"><thead><tr><th>date</th><th>topic</th><th class="num">open</th><th class="num">done</th><th></th></tr></thead><tbody>${tr}</tbody></table>`;
}

function viewSession(id) {
  const tab = document.querySelector('[data-tab="tasks-session"], [data-action="switch-tab"][data-id="tasks-session"]');
  current = { session: { id }, items: [] };
  if (tab) tab.click();
  else location.hash = 'tasks-session';
  background(loadSession(id));
}

registerTab('tasks-session', renderSessionPane);
registerTab('tasks-backlog', renderBacklogPane);
registerTab('tasks-history', renderHistoryPane);
registerAction('tk-drop', (el) => background(dropItem(Number(el.dataset.id))));
registerAction('tk-reopen', (el) => background(reopenItem(Number(el.dataset.id))));
registerAction('tk-pull', (el) => background(pullItem(Number(el.dataset.id))));
registerAction('tk-tag', (el) => { backlog.tag = el.dataset.tag; background(loadBacklog()); });
registerAction('tk-view', (el) => viewSession(Number(el.dataset.id)));
registerChange('tk-done', (el) => background(setDone(Number(el.dataset.id), el.checked)));
registerChange('tk-pick', (el) => background(loadSession(Number(el.value))));

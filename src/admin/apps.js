// Plugin app page — one plugin's UI as a first-class surface at /admin/apps/<id>.
//
// The shell is generic: it reads the plugin's manifest, draws its tabs, hosts
// its panes, and exposes the same window.ritsu bridge Studio used to, so a
// plugin's app.js runs here unchanged. Served as a static asset so the page
// keeps script-src 'self'; every interaction routes through the delegated
// listeners at the bottom (data-action clicks, data-change inputs) — no
// inline handlers, no style="…" attributes.

// ---- helpers ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, kind = 'ok') {
  const el = $('toast');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  setTimeout(() => { el.classList.add('hidden'); }, 3000);
}

// ---- auth ------------------------------------------------------------------
// Same localStorage key as the other admin pages, so one sign-in covers all.
const ADMIN_TOKEN_KEY = 'ritsu.adminToken';
function getAdminToken() { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; }
function setAdminToken(t) { localStorage.setItem(ADMIN_TOKEN_KEY, t); }
function clearAdminToken() { localStorage.removeItem(ADMIN_TOKEN_KEY); }

let _tokenPromise = null;
function showAdminLogin(reason) {
  const overlay = $('admin-login');
  const form = $('admin-login-form');
  const input = $('admin-login-token');
  $('admin-login-msg').textContent = reason || 'Sign in with your admin token.';
  overlay.classList.add('open');
  input.value = '';
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

// ---- plugin bridge ---------------------------------------------------------
// Same contract Studio offered: a plugin registers a renderer per tab id, and
// named handlers for its data-action / data-change elements. A renderer runs
// when its tab becomes active, or at once if it registers while already
// active (the plugin script loads after the first tab is shown).
// Maps, not objects: a tab or action name from the URL can never reach a prototype member.
const pluginTabs = new Map();
const pluginActions = new Map();
const pluginChanges = new Map();
let tabs = [];
let activeTab = null;

window.ritsu = {
  api, esc, toast,
  registerTab(tabId, fn) { pluginTabs.set(tabId, fn); if (activeTab === tabId) fn($(`pane-${tabId}`)); },
  registerAction(name, fn) { pluginActions.set(name, fn); },
  registerChange(name, fn) { pluginChanges.set(name, fn); },
};

function renderTabs() {
  $('app-tabs').innerHTML = tabs.map(t =>
    `<button type="button" data-action="switch-tab" data-tab="${esc(t.id)}" class="${t.id === activeTab ? 'active' : ''}">${esc(t.label)}</button>`,
  ).join('');
}

function switchTab(id) {
  if (!tabs.some(t => t.id === id)) return;
  activeTab = id;
  document.querySelectorAll('#app-main .pane').forEach(p => p.classList.toggle('active', p.id === `pane-${id}`));
  renderTabs();
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  const render = pluginTabs.get(id);
  if (render) render($(`pane-${id}`));
}

function tabFromHash() {
  const id = decodeURIComponent(location.hash.replace(/^#/, ''));
  return tabs.some(t => t.id === id) ? id : (tabs[0]?.id ?? null);
}

// ---- agent button ----------------------------------------------------------
// A plugin's preset agent is the "ask about this" entry point. If the operator
// already loaded it, link straight into its chat; otherwise offer to create it.
async function renderAgentAction(p) {
  const box = $('app-actions');
  if (!p.agent) { box.innerHTML = ''; return; }
  let exists = false;
  try {
    const { agents } = await api('GET', '/admin/agents');
    exists = (agents || []).some(a => a.id === p.agent.id);
  } catch { /* button falls back to "set up" */ }
  box.innerHTML = exists
    ? `<a class="chip action" href="/admin/workspace#/a/${encodeURIComponent(p.agent.id)}">Ask ${esc(p.agent.name)}</a>`
    : `<button type="button" class="chip action" data-action="load-agent" title="Create the ${esc(p.agent.name)} agent from this app's preset">Set up ${esc(p.agent.name)}</button>`;
}

async function loadAgent(p) {
  try {
    await api('POST', `/admin/api/plugins/${encodeURIComponent(p.id)}/agent`, {});
    toast(`${p.agent.name} is ready`, 'ok');
    await renderAgentAction(p);
  } catch (e) { toast(e.message, 'err'); }
}

// ---- mount -----------------------------------------------------------------
let plugin = null;

function showMissing(id, reason) {
  document.title = 'ritsu — app';
  $('app-name').textContent = id || 'app';
  $('app-main').innerHTML = `<section class="pane active"><div class="panel app-missing"><h2>Not available</h2>
    <p>${esc(reason)}</p><p>Manage plugins in <a href="/admin">Studio</a> under Server › Plugins.</p></div></section>`;
}

async function boot() {
  const m = /^\/admin\/apps\/([^/]+)/.exec(location.pathname);
  const id = m ? decodeURIComponent(m[1]) : '';
  let plugins = [];
  try { ({ plugins } = await api('GET', '/admin/api/plugins')); }
  catch (e) { showMissing(id, `could not load plugins: ${e.message}`); return; }
  plugin = plugins.find(p => p.id === id);
  if (!plugin) { showMissing(id, `No plugin named "${id}" is installed.`); return; }
  if (plugin.enabled === false) { showMissing(id, `${plugin.name} is disabled.`); return; }

  document.title = `ritsu — ${plugin.name}`;
  $('app-name').textContent = plugin.name;
  $('app-desc').textContent = plugin.description || '';
  tabs = (plugin.nav || []).flatMap(g => g.tabs || []);
  if (!tabs.length) { showMissing(id, `${plugin.name} has no UI.`); return; }

  const main = $('app-main');
  main.innerHTML = '';
  for (const t of tabs) {
    const sec = document.createElement('section');
    sec.id = `pane-${t.id}`;
    sec.className = 'pane';
    main.appendChild(sec);
  }
  switchTab(tabFromHash());
  renderAgentAction(plugin);

  if (plugin.assets?.css) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = plugin.assets.css;
    document.head.appendChild(link);
  }
  if (plugin.assets?.js) {
    const s = document.createElement('script');
    s.type = 'module';
    s.src = plugin.assets.js;
    document.head.appendChild(s);
  }
}

// ---- delegated handlers ----------------------------------------------------
const ACTIONS = {
  'switch-tab': (el) => switchTab(el.dataset.tab),
  'load-agent': () => { if (plugin) loadAgent(plugin); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = ACTIONS[el.dataset.action] || pluginActions.get(el.dataset.action);
  if (handler) handler(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const handler = pluginChanges.get(el.dataset.change);
  if (handler) handler(el, e);
});

window.addEventListener('hashchange', () => { const t = tabFromHash(); if (t && t !== activeTab) switchTab(t); });

await boot();

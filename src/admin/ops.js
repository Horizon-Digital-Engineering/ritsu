// ritsu operations board — the "watch" surface.
//
// One page absorbs the operator's monitoring loop: pending approvals (with
// approve/reject), scheduled jobs, channels, health checks, a live log tail,
// and blocked inter-agent calls. Everything renders from the same admin API
// the classic panel uses; live updates ride the approvals + events SSE
// streams with polling as the fallback for the slow-moving cards.
//
// Served as a static asset at /admin/ops.js so the page keeps script-src
// 'self'. Every interaction routes through the delegated listeners at the
// bottom (data-action clicks, data-change inputs) — no inline handlers, no
// style="…" attributes, same contract as workspace.js.

// ---- helpers ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtRelativeSeconds(deltaSec) {
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}
/** "in 4m" / "in 2h" for a future unix timestamp; past reads as "now". */
function fmtUntil(epoch) {
  const d = Math.floor(epoch - Date.now() / 1000);
  if (d <= 0) return 'now';
  if (d < 60) return `in ${d}s`;
  if (d < 3600) return `in ${Math.floor(d / 60)}m`;
  if (d < 86400) return `in ${Math.floor(d / 3600)}h`;
  return `in ${Math.floor(d / 86400)}d`;
}

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

/** Parse complete SSE frames out of `buf`, invoking onEvent per data payload.
 *  Returns the unconsumed remainder (a partial frame, if any). */
function drainSseFrames(buf, onEvent) {
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
    if (!data) continue;
    try { onEvent(JSON.parse(data)); } catch { /* skip malformed frame */ }
  }
  return buf;
}

async function readSseBody(r, onEvent) {
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf = drainSseFrames(buf + decoder.decode(value, { stream: true }), onEvent);
  }
}

/** Authenticated SSE consumer (EventSource can't send headers). Reconnects
 *  after 2s on anything but an abort; onState reports live/dead for the dot. */
async function sseFetch(path, onEvent, signal, onState) {
  while (!signal.aborted) {
    try {
      const r = await fetch(path, { headers: { 'X-Ritsu-Admin-Token': getAdminToken() }, signal });
      if (r.status === 401) { clearAdminToken(); await ensureAdminToken('Admin token rejected — paste again.'); continue; }
      if (!r.ok || !r.body) throw new Error(`sse ${r.status}`);
      onState?.(true);
      await readSseBody(r, onEvent);
      throw new Error('sse stream ended');
    } catch (e) {
      if (signal.aborted) return;
      onState?.(false);
      console.warn('sse reconnect in 2s:', e?.message ?? e);
      await new Promise(res => setTimeout(res, 2000));
    }
  }
}

/** Replace a container's content with one inert text note. Built as a DOM
 *  node with textContent, so even a hostile error string is just text. */
function showNote(el, msg, className = 'empty-note') {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = msg;
  el.replaceChildren(div);
}

function setLive(on) {
  $('live-dot').classList.toggle('on', on);
  $('live-dot').title = on ? 'Live streams connected' : 'Live streams reconnecting…';
  $('live-label').textContent = on ? 'live' : 'reconnecting…';
}

// ---- approvals -------------------------------------------------------------
// Same markup + endpoint contract as the workspace's inline cards and the
// classic panel: approve one click, reject two-step with a reason box,
// security-critical args unmasked and shown by default.

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

async function loadPendingApprovals() {
  try {
    const { approvals } = await api('GET', '/admin/api/approvals?state=pending&limit=100');
    const grid = $('approvals-pending');
    grid.innerHTML = approvals.length
      ? approvals.map(a => approvalCardHtml(a)).join('')
      : '<div class="empty-note">Nothing waiting — every agent is unblocked.</div>';
    setPendingCount(approvals.length);
  } catch (e) {
    showNote($('approvals-pending'), e.message);
  }
}

function setPendingCount(n) {
  const pill = $('needs-you-count');
  pill.textContent = String(n);
  pill.classList.toggle('hidden', !n);
  const badge = $('rail-ops-badge');
  badge.textContent = String(n);
  badge.classList.toggle('hidden', !n);
  document.title = n ? `(${n}) ritsu — operations` : 'ritsu — operations';
}

async function loadDecidedApprovals() {
  try {
    const { approvals } = await api('GET', '/admin/api/approvals?state=decided&limit=12');
    $('approvals-decided').innerHTML = approvals.length
      ? approvals.map(a => approvalStampHtml(a)).join('')
      : '<div class="empty-note">No decisions yet.</div>';
  } catch (e) {
    showNote($('approvals-decided'), e.message);
  }
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
    await Promise.all([loadPendingApprovals(), loadDecidedApprovals()]);
  } catch (e) {
    toast(e.message, 'err');   // 409 = already decided (race)
    cardEl?.querySelectorAll('button').forEach(b => { b.disabled = false; });
    loadPendingApprovals();
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

// ---- blocked inter-agent calls ---------------------------------------------

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
  const shortMsg = d.message && d.message.length > 160 ? `${d.message.slice(0, 160)}…` : d.message;
  const msg = d.message
    ? `<div class="denial-msg" title="${esc(d.message)}">“${esc(shortMsg)}”</div>`
    : '';
  return `<div class="denial-row${cls}">`
    + '<div class="denial-head">'
    +   '<span class="denial-x">✗</span>'
    +   `<span class="denial-pair"><code>${esc(d.caller)}</code> → <code>${esc(d.target)}</code></span>`
    +   `<span class="denial-reason">${esc(denialReasonLabel(d.reason))}</span>`
    +   detail
    +   `<span class="denial-ago">${approvalAgo(d.created_at)}</span>`
    + '</div>'
    + msg
    + '</div>';
}

async function loadDenials() {
  try {
    const { denials } = await api('GET', '/admin/api/comms-denials?limit=30');
    $('denials-list').innerHTML = denials.length
      ? denials.map(denialRowHtml).join('')
      : '<div class="empty-note">No blocked calls.</div>';
  } catch (e) {
    showNote($('denials-list'), e.message);
  }
}

// ---- jobs / channels / health ----------------------------------------------

function jobDotClass(j) {
  if (!j.enabled || j.disabled_reason) return 'off';
  if (j.last_status === 'error' || j.consecutive_failures > 0) return 'err';
  return 'ok';
}

function jobWhen(j) {
  if (j.disabled_reason) return j.disabled_reason;
  if (!j.enabled) return 'disabled';
  if (j.next_run_at) return fmtUntil(j.next_run_at);
  if (j.trigger) return 'on trigger';
  return '—';
}

async function loadJobs() {
  try {
    const { jobs } = await api('GET', '/admin/api/jobs');
    $('jobs-list').innerHTML = jobs.length
      ? jobs.map(j =>
          `<div class="status-row">
            <span class="status-dot ${jobDotClass(j)}"></span>
            <span class="grow" title="${esc(j.name)}">${esc(j.name)}</span>
            <span class="status-mono">${esc(jobWhen(j))}</span>
          </div>`).join('')
      : '<div class="empty-note">No scheduled jobs.</div>';
  } catch (e) {
    showNote($('jobs-list'), e.message);
  }
}

async function loadChannels() {
  try {
    const { channels } = await api('GET', '/admin/api/channels');
    $('channels-list').innerHTML = channels.length
      ? channels.map(c =>
          `<div class="status-row">
            <span class="status-dot ${c.enabled ? 'ok' : 'off'}"></span>
            <span class="grow">${esc(c.kind)} → <code>${esc(c.operator_agent_id)}</code></span>
            <span class="status-sub">${c.enabled ? 'live' : 'off'}</span>
          </div>`).join('')
      : '<div class="empty-note">No channels connected.</div>';
  } catch (e) {
    showNote($('channels-list'), e.message);
  }
}

async function loadHealth() {
  try {
    const { checks } = await api('GET', '/admin/api/health');
    const dotFor = (c) => {
      if (c.status === 'ok') return 'ok';
      return c.status === 'skip' ? 'off' : 'err';
    };
    $('health-list').innerHTML = checks.map(c =>
      `<div class="status-row">
        <span class="status-dot ${dotFor(c)}"></span>
        <span class="grow">${esc(c.label)}</span>
        <span class="status-sub" title="${esc(c.detail || '')}">${esc(c.detail || c.status)}</span>
      </div>`).join('');
    const worst = checks.some(c => c.status === 'fail') ? 'err' : 'ok';
    $('rail-health-dot').className = `rail-health ${worst}`;
    $('rail-health-dot').title = worst === 'ok' ? 'All health checks passing' : 'A health check is failing';
  } catch (e) {
    showNote($('health-list'), e.message);
    $('rail-health-dot').className = 'rail-health warn';
  }
}

// ---- live log tail ---------------------------------------------------------

const TAIL_MAX = 400;
let tailWarnOnly = false;

function logLineHtml(ev) {
  const time = (ev.t || '').slice(11, 19);
  const extra = { ...ev };
  delete extra.t; delete extra.level; delete extra.msg;
  const extraStr = Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
  return `<div class="log-line ${esc(ev.level)}" data-level="${esc(ev.level)}"><span class="lt">${esc(time)}</span> ${esc(ev.level)} ${esc(ev.msg)}${esc(extraStr)}</div>`;
}

function appendLogLine(ev) {
  const tail = $('log-tail');
  if (tailWarnOnly && ev.level !== 'warn' && ev.level !== 'error') return;
  const atBottom = tail.scrollHeight - tail.scrollTop - tail.clientHeight < 40;
  tail.insertAdjacentHTML('beforeend', logLineHtml(ev));
  while (tail.childElementCount > TAIL_MAX) tail.firstElementChild.remove();
  if (atBottom) tail.scrollTop = tail.scrollHeight;
}

async function loadRecentLogs() {
  try {
    const { events } = await api('GET', '/admin/api/events/recent?limit=200');
    const list = tailWarnOnly ? events.filter(e => e.level === 'warn' || e.level === 'error') : events;
    const tail = $('log-tail');
    tail.innerHTML = list.map(logLineHtml).join('');
    tail.scrollTop = tail.scrollHeight;
  } catch (e) {
    showNote($('log-tail'), e.message, 'log-line error');
  }
}

// ---- delegated events ------------------------------------------------------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const card = el.closest('.approval-card');
  const handlers = {
    'approve-approval': () => approveApprovalClick(card),
    'reject-approval': () => rejectApprovalClick(card),
    'toggle-approval-detail': () => toggleApprovalDetail(card),
  };
  handlers[el.dataset.action]?.();
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  if (el.dataset.change === 'tail-filter') {
    tailWarnOnly = el.checked;
    loadRecentLogs();
  }
});

// ---- bootstrap -------------------------------------------------------------

const bootAbort = new AbortController();

async function boot() {
  await ensureAdminToken('Sign in to see operations.');
  await Promise.all([
    loadPendingApprovals(), loadDecidedApprovals(), loadDenials(),
    loadJobs(), loadChannels(), loadHealth(), loadRecentLogs(),
  ]);

  // Approvals stream keeps the queue + badge live; events stream feeds the
  // tail. Either one being up counts as "live" for the dot — they reconnect
  // independently.
  let approvalsUp = false, eventsUp = false;
  const updateDot = () => setLive(approvalsUp || eventsUp);
  sseFetch('/admin/api/approvals/stream', () => {
    loadPendingApprovals();
    loadDecidedApprovals();
    loadDenials();
  }, bootAbort.signal, (up) => { approvalsUp = up; updateDot(); });
  sseFetch('/admin/api/events/stream', appendLogLine, bootAbort.signal, (up) => { eventsUp = up; updateDot(); });

  // The slow-moving cards poll gently; ages on cards refresh with them.
  setInterval(() => { loadJobs(); loadChannels(); loadHealth(); }, 60_000);
  setInterval(() => { loadPendingApprovals(); loadDecidedApprovals(); }, 90_000);
}

await boot();

// Finance app UI. Runs on /admin/apps/finance through the window.ritsu bridge.
// No inline styles or handlers (CSP): bars and charts are SVG with attribute
// geometry, every button is data-action, every control is data-change.
const { api, esc, toast, registerTab, registerAction, registerChange } = window.ritsu;
const F = '/admin/api/plugins/finance';

// Fire-and-forget for handlers that start async work and move on: a rejection
// becomes a visible toast instead of an unhandled promise in the console.
function background(promise) { promise.catch(e => toast(e?.message || String(e), 'err')); }


// ---- shared state + helpers -------------------------------------------------
let cats = [], catById = new Map(), accounts = [], acctById = new Map();
async function loadRefs() {
  const [c, a] = await Promise.all([api('GET', `${F}/categories?all=1`), api('GET', `${F}/accounts`)]);
  cats = c.categories; catById = new Map(cats.map(x => [x.id, x]));
  accounts = a.accounts; acctById = new Map(accounts.map(x => [x.id, x]));
  return a;
}
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const money = (n, ccy = 'USD', whole = false) => {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const s = abs.toLocaleString('en-US', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? '−' : '';
  const unit = ccy === 'USD' ? '$' : `${ccy} `;
  return `${sign}${unit}${s}`;
};
const signed = (n, ccy) => `${n > 0 ? '+' : ''}${money(n, ccy)}`;
const fmtK = (v) => {
  const abs = Math.abs(v);
  if (abs < 1000) return v.toFixed(0);
  return `${(v / 1000).toFixed(abs >= 100000 ? 0 : 1)}k`;
};
const ago = (hours) => {
  if (hours < 1) return 'just now';
  if (hours < 36) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
const asOfLine = (iso) => {
  if (!iso) return '<p class="fin-asof stale">No data synced yet — connect a bank or import a file in Connections.</p>';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  const hours = (Date.now() - d.getTime()) / 3_600_000;
  return `<p class="fin-asof${hours > 48 ? ' stale' : ''}">Data as of ${esc(d.toLocaleString())} (${ago(hours)})</p>`;
};
const dueIn = (days) => (days <= 0 ? 'today' : `in ${days}d`);
const catName = (id) => (id ? (catById.get(id)?.name ?? id) : 'Uncategorized');
const monthLabel = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthRange = (m) => { const [y, mo] = m.split('-').map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` }; };
const addDays = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const TYPE_LABEL = { depository: 'Cash', credit: 'Credit cards', loan: 'Loans', investment: 'Investments', property: 'Property', other: 'Other' };
const TYPE_ORDER = ['depository', 'credit', 'loan', 'investment', 'property', 'other'];
const CADENCES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const typeOptions = (selected) => TYPE_ORDER.map(t => opt(t, TYPE_LABEL[t], t === selected)).join('');
const chip = (action, key, value, label, active) => `<button class="fin-chip${active ? ' active' : ''}" data-action="${action}" data-${key}="${esc(value)}">${esc(label)}</button>`;

function catOptions(selected, { blank = true, kinds = null } = {}) {
  const groups = new Map();
  for (const c of cats) {
    if (c.archived && c.id !== selected) continue;
    if (kinds && !kinds.includes(c.kind)) continue;
    const arr = groups.get(c.group_name) || []; arr.push(c); groups.set(c.group_name, arr);
  }
  let html = blank ? `<option value="">— uncategorized —</option>` : '';
  for (const [g, list] of groups) {
    const opts = list.map(c => opt(c.id, c.name, c.id === selected)).join('');
    html += `<optgroup label="${esc(g)}">${opts}</optgroup>`;
  }
  return html;
}
const catSelect = (selected, attrs = '', opts = {}) => `<select class="cat" ${attrs}>${catOptions(selected, opts)}</select>`;
const acctLabel = (a) => (a.mask ? `${a.name} ••${a.mask}` : a.name);
const acctOptions = (selected, blank = true) => {
  const head = blank ? '<option value="">all accounts</option>' : '';
  return head + accounts.filter(a => !a.closed).map(a => opt(a.id, acctLabel(a), a.id === selected)).join('');
};

// SVG bars: geometry lives in attributes, never style=.
const bar = (pct, cls = '') => `<svg class="bar ${cls}" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="8" rx="2"/><rect class="fg" width="${Math.max(0, Math.min(100, pct || 0)).toFixed(1)}" height="8" rx="2"/></svg>`;
function barTable(rows, { label, value, count, max: forcedMax } = {}) {
  if (!rows.length) return '<p class="muted">(none)</p>';
  const max = forcedMax ?? Math.max(...rows.map(r => Math.abs(value(r))));
  const countCell = (r) => (count ? ` <span class="muted">(${count(r)})</span>` : '');
  const row = (r) => `<tr><td>${label(r)}</td><td class="barcell">${bar(max ? Math.abs(value(r)) / max * 100 : 0)}</td><td class="num">${money(value(r))}${countCell(r)}</td></tr>`;
  return `<table class="fin"><tbody>${rows.map(row).join('')}</tbody></table>`;
}
const anchorAt = (i, last) => {
  if (i === 0) return 'start';
  if (i === last) return 'end';
  return 'middle';
};
function lineChart(points, { tall = false, key = 'net' } = {}) {
  if (points.length < 2) return '<p class="muted">Not enough history yet — the chart fills in as balances are recorded daily.</p>';
  const W = 600, H = tall ? 220 : 160, P = { l: 56, r: 10, t: 10, b: 22 };
  const vals = points.map(p => p[key]);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const x = (i) => P.l + (i / (points.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points.length - 1).toFixed(1)},${(H - P.b).toFixed(1)} L${P.l},${(H - P.b).toFixed(1)} Z`;
  const last = points.length - 1;
  const labels = [0, Math.floor(last / 2), last].map(i => `<text class="lbl" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${anchorAt(i, last)}">${esc(points[i].date)}</text>`).join('');
  const tick = (t) => `<line class="axis" x1="${P.l}" x2="${W - P.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="lbl" x="${P.l - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${fmtK(t)}</text>`;
  const ticks = [min + pad, (min + max) / 2, max - pad].map(tick).join('');
  const zero = min < 0 && max > 0 ? `<line class="axis zero" x1="${P.l}" x2="${W - P.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : '';
  return `<svg class="chart${tall ? ' tall' : ''}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="trend">
    ${ticks}
    ${zero}
    <path class="area" d="${area}"/><path class="line" d="${path}"/>${labels}</svg>`;
}
function cashFlowChart(months) {
  if (!months.length) return '<p class="muted">(no data)</p>';
  const W = 600, H = 180, P = { l: 48, r: 8, t: 10, b: 22 };
  const max = Math.max(1, ...months.map(m => Math.max(m.income, m.expenses)));
  const slot = (W - P.l - P.r) / months.length, bw = Math.max(3, slot * 0.3);
  const y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
  const bars = months.map((m, i) => {
    const x0 = P.l + i * slot + slot / 2;
    return `<rect class="inc" x="${(x0 - bw - 1).toFixed(1)}" y="${y(m.income).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - P.b - y(m.income)).toFixed(1)}"/>
      <rect class="exp" x="${(x0 + 1).toFixed(1)}" y="${y(m.expenses).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - P.b - y(m.expenses)).toFixed(1)}"/>
      <text class="lbl" x="${x0.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monthLabel(m.month))}</text>`;
  }).join('');
  const tick = (f) => `<line class="axis" x1="${P.l}" x2="${W - P.r}" y1="${y(max * f).toFixed(1)}" y2="${y(max * f).toFixed(1)}"/><text class="lbl" x="${P.l - 6}" y="${(y(max * f) + 3).toFixed(1)}" text-anchor="end">${fmtK(max * f)}</text>`;
  const ticks = [0.5, 1].map(tick).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="cash flow">
    ${ticks}
    <line class="axis" x1="${P.l}" x2="${W - P.r}" y1="${(H - P.b).toFixed(1)}" y2="${(H - P.b).toFixed(1)}"/>${bars}</svg>
    <div class="fin-legend"><span><i class="inc"></i>income</span><span><i class="exp"></i>expenses</span></div>`;
}
const panel = (title, body, extra = '') => `<div class="panel ${extra}"><h2>${title}</h2>${body}</div>`;
// An error message is text, never markup: it is written as a text node.
const showErr = (el, e) => {
  const p = document.createElement('p');
  p.className = 'err';
  p.textContent = `error: ${e.message || String(e)}`;
  el.replaceChildren(p);
};
function on(pane, sel, evt, fn) { const el = pane.querySelector(sel); if (el) el.addEventListener(evt, fn); }
const val = (pane, id) => pane.querySelector(`#${id}`)?.value?.trim() ?? '';
const num = (pane, id) => { const v = val(pane, id); return v === '' ? null : Number(v); };

// ============================================================================
// Dashboard
// ============================================================================
let dashPane = null;
async function renderDashboard(pane) {
  dashPane = pane;
  pane.innerHTML = '<p class="muted">loading…</p>';
  try {
    await loadRefs();
    const o = await api('GET', `${F}/overview`);
    const goals = o.goals.length ? o.goals.map(goalRow).join('') : '<p class="muted">No goals yet. Add one under Accounts.</p>';
    pane.innerHTML = `
      ${asOfLine(o.as_of)}
      <div class="fin-chips"></div>
      <div class="fin-grid">
        ${netWorthPanel(o.net_worth, o.net_worth_change_30d, o.net_worth_series)}
        ${cashFlowPanel(o)}
        ${panel('Top spending this month', barTable(o.top_categories, { label: r => esc(r.name), value: r => r.total, count: r => r.count }))}
        ${budgetPanel(o.budgets)}
        ${upcomingPanel(o.upcoming)}
        ${panel('Goals', goals)}
        ${panel('Recent transactions', txnMiniTable(o.recent), 'fin-wide')}
      </div>`;
    // Counts come from the server; built as nodes so the text is never markup.
    const chips = pane.querySelector('.fin-chips');
    const chip = (n, filter, label, cls) => {
      const b = document.createElement('button');
      b.className = cls;
      b.dataset.action = 'fin-go';
      b.dataset.tab = 'finance-transactions';
      b.dataset.filter = filter;
      b.textContent = `${n} ${label}`;
      chips.append(b);
    };
    if (o.uncategorized_count) chip(o.uncategorized_count, 'uncategorized', 'uncategorized', 'fin-chip warn');
    if (o.unreviewed_count) chip(o.unreviewed_count, 'unreviewed', 'to review', 'fin-chip');
    if (!chips.childElementCount) chips.remove();
  } catch (e) { showErr(pane, e); }
}
function netWorthPanel(nw, delta, series) {
  let deltaHtml = '';
  if (delta != null) {
    const dir = delta >= 0 ? 'up' : 'down';
    deltaHtml = ` · <span class="fin-delta ${dir}">${signed(delta, nw.currency)} 30d</span>`;
  }
  const body = `
          <div class="fin-big">${money(nw.net, nw.currency)}</div>
          <div class="fin-sub">assets ${money(nw.assets, nw.currency)} · liabilities ${money(nw.liabilities, nw.currency)}${deltaHtml}</div>
          ${lineChart(series)}`;
  return panel('Net worth', body);
}
function cashFlowPanel(o) {
  const flowNow = o.cash_flow.at(-1) || { income: 0, expenses: 0, net: 0 };
  const saved = flowNow.savings_rate != null ? `<div class="fin-kpi"><div class="l">Saved</div><div class="v">${Math.round(flowNow.savings_rate * 100)}%</div></div>` : '';
  const body = `
          <div class="fin-kpis">
            <div class="fin-kpi"><div class="l">Income</div><div class="v ok">${money(flowNow.income, 'USD', true)}</div></div>
            <div class="fin-kpi"><div class="l">Expenses</div><div class="v">${money(flowNow.expenses, 'USD', true)}</div></div>
            <div class="fin-kpi"><div class="l">Net</div><div class="v ${flowNow.net >= 0 ? 'ok' : 'err'}">${signed(flowNow.net, 'USD')}</div></div>
            ${saved}
          </div>
          ${cashFlowChart(o.cash_flow)}`;
  return panel(`${esc(monthLabel(o.month))} cash flow`, body);
}
const overItem = (l) => `<li><span>${esc(l.name)}</span><span class="r err">over by ${money(-l.remaining)}</span></li>`;
function budgetPanel(b) {
  const T = b.totals;
  if (!T.budgeted_expenses) return panel('Budget', '<p class="muted">No budgets yet. <button class="fin-chip" data-action="fin-go" data-tab="finance-budgets">Set some</button></p>');
  const spent = T.actual_expenses - T.unbudgeted_expenses;
  const kpis = `<div class="fin-kpis"><div class="fin-kpi"><div class="l">Spent (budgeted cats)</div><div class="v">${money(spent, 'USD', true)}</div></div><div class="fin-kpi"><div class="l">Budgeted</div><div class="v">${money(T.budgeted_expenses, 'USD', true)}</div></div><div class="fin-kpi"><div class="l">Outside budgets</div><div class="v">${money(T.unbudgeted_expenses, 'USD', true)}</div></div></div>`;
  const over = b.over.length ? `<ul class="fin-list">${b.over.map(overItem).join('')}</ul>` : '<p class="fin-note">Nothing over budget.</p>';
  return panel('Budget', `${kpis}
             ${bar(spent / T.budgeted_expenses * 100, spent > T.budgeted_expenses ? 'over' : '')}
             ${over}`);
}
const upcomingItem = (u) => `<li><span>${esc(u.display_name)} <span class="muted">${dueIn(u.days_until)}</span></span><span class="r">${money(Math.abs(u.amount))}</span></li>`;
function upcomingPanel(list) {
  const body = list.length ? `<ul class="fin-list">${list.map(upcomingItem).join('')}</ul>` : '<p class="muted">No recurring charges due.</p>';
  return panel('Coming up (14 days)', body);
}
const goalRow = (p) => `<div class="fin-goal"><div class="h"><span>${esc(p.goal.name)}</span><span class="r">${money(p.current, 'USD', true)} / ${money(p.goal.target_amount, 'USD', true)}${p.on_track === false ? ' <span class="warn">behind</span>' : ''}</span></div>${bar(p.progress * 100, p.progress >= 1 ? 'ok' : '')}</div>`;
const miniRow = (t) => `<tr><td class="muted">${esc(t.date)}</td><td>${esc(t.payee)}</td><td class="muted">${esc(catName(t.category_id))}</td><td class="num ${t.amount > 0 ? 'pos' : ''}">${money(t.amount, t.currency)}</td></tr>`;
const txnMiniTable = (rows) => (rows.length
  ? `<div class="table-wrap"><table class="fin"><tbody>${rows.map(miniRow).join('')}</tbody></table></div>`
  : '<p class="muted">No transactions yet.</p>');

// ============================================================================
// Accounts
// ============================================================================
let nwRange = '1y';
function nwFrom() {
  if (nwRange === '3m') return addDays(today(), -90);
  if (nwRange === '1y') return addDays(today(), -365);
  return '2000-01-01';
}
function goalDetail(p) {
  const linked = p.goal.account_ids.map(id => esc(acctById.get(id)?.name || id)).join(', ') || 'no accounts linked';
  let due = '';
  if (p.goal.target_date) {
    due = ` · by ${esc(p.goal.target_date)}`;
    if (p.monthly_needed != null) due += `, ${money(p.monthly_needed, 'USD', true)}/mo needed`;
  }
  return `${goalRow(p)}<div class="fin-note">${esc(p.goal.kind)} · ${linked}${due} <button data-action="fin-goal-del" data-id="${p.goal.id}" class="danger">remove</button></div>`;
}
function typeGroupPanel(g) {
  const total = g.rows.filter(r => !r.hidden && !r.closed).reduce((s, r) => s + r.balance, 0);
  const table = `<div class="table-wrap"><table class="fin"><tbody>${g.rows.map(acctRow).join('')}</tbody></table></div>`;
  return panel(`${TYPE_LABEL[g.type]} <span class="muted">${money(total)}</span>`, table);
}
async function renderAccounts(pane) {
  pane.innerHTML = '<p class="muted">loading…</p>';
  try {
    const a = await loadRefs();
    const nw = a.net_worth;
    const groups = TYPE_ORDER.map(t => ({ type: t, rows: accounts.filter(x => x.type === t) })).filter(g => g.rows.length);
    const hist = await api('GET', `${F}/networth/history?from=${nwFrom()}&to=${today()}`);
    const goals = await api('GET', `${F}/goals`);
    const rangeChips = ['3m', '1y', 'all'].map(r => chip('fin-nw-range', 'range', r, r, r === nwRange)).join('');
    const nwPanel = panel('Net worth', `<div class="fin-big">${money(nw.net, nw.currency)}</div><div class="fin-sub">assets ${money(nw.assets)} · liabilities ${money(nw.liabilities)}</div>
          <div class="fin-chips">${rangeChips}</div>
          ${lineChart(hist.series, { tall: true })}`, 'fin-wide');
    const addPanel = panel('Add a manual account', `<p class="fin-note">For anything a bank feed can't reach: a house, a car, cash, a loan to a friend. Update its balance whenever it changes; every update is a point on the net worth chart.</p>
          <form class="fin-inline-form" id="fin-acct-form">
            <label>name<input id="fa-name" required class="wide" placeholder="House"></label>
            <label>type<select id="fa-type">${typeOptions('')}</select></label>
            <label>balance<input id="fa-bal" type="number" step="0.01" required placeholder="owed amounts as positive for loans/cards"></label>
            <label>institution<input id="fa-inst" placeholder="optional"></label>
            <button type="submit" class="primary">Add</button>
          </form>`);
    const goalList = goals.goals.map(goalDetail).join('') || '<p class="muted">No goals yet.</p>';
    const goalAcctOpts = accounts.map(x => opt(x.id, x.name, false)).join('');
    const goalsPanel = panel('Goals', `${goalList}
          <form class="fin-inline-form" id="fin-goal-form">
            <label>name<input id="fg-name" required placeholder="Emergency fund"></label>
            <label>kind<select id="fg-kind"><option value="save">save up to</option><option value="payoff">pay off</option></select></label>
            <label>target<input id="fg-target" type="number" step="1" min="1" required></label>
            <label>by<input id="fg-date" type="date"></label>
            <label>accounts<select id="fg-accts" multiple size="3">${goalAcctOpts}</select></label>
            <button type="submit" class="primary">Add goal</button>
          </form>`);
    pane.innerHTML = `
      ${asOfLine(a.as_of)}
      <div class="fin-grid">
        ${nwPanel}
        ${groups.map(typeGroupPanel).join('')}
        ${addPanel}
        ${goalsPanel}
      </div>`;
    on(pane, '#fin-acct-form', 'submit', async (ev) => {
      ev.preventDefault();
      const type = val(pane, 'fa-type');
      let balance = num(pane, 'fa-bal') || 0;
      if ((type === 'credit' || type === 'loan') && balance > 0) balance = -balance;
      try {
        await api('POST', `${F}/accounts`, { name: val(pane, 'fa-name'), type, balance, institution: val(pane, 'fa-inst') });
        toast('account added'); background(renderAccounts(pane));
      } catch (e) { toast(e.message, 'err'); }
    });
    on(pane, '#fin-goal-form', 'submit', async (ev) => {
      ev.preventDefault();
      const sel = pane.querySelector('#fg-accts');
      try {
        await api('POST', `${F}/goals`, { name: val(pane, 'fg-name'), kind: val(pane, 'fg-kind'), target_amount: num(pane, 'fg-target'), target_date: val(pane, 'fg-date') || null, account_ids: [...sel.selectedOptions].map(o => o.value) });
        toast('goal added'); background(renderAccounts(pane));
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { showErr(pane, e); }
}
function acctRow(a) {
  const manual = !a.connection_id;
  const owed = (a.type === 'credit' || a.type === 'loan');
  const mask = a.mask ? ` <span class="muted">••${esc(a.mask)}</span>` : '';
  const subtype = a.subtype ? ` · ${esc(a.subtype)}` : '';
  const actions = manual ? `<button data-action="fin-acct-balance" data-id="${esc(a.id)}">update balance</button>` : '';
  return `<tr class="${a.hidden || a.closed ? 'excluded' : ''}" data-acct="${esc(a.id)}">
    <td><span class="fin-clickable" data-action="fin-acct-edit" data-id="${esc(a.id)}">${esc(a.name)}</span>${mask}<br><span class="muted">${esc(a.institution || (manual ? 'manual' : ''))}${subtype}${a.hidden ? ' · hidden' : ''}${a.closed ? ' · closed' : ''}</span></td>
    <td class="num">${money(owed ? -a.balance : a.balance, a.currency)}${owed ? '<br><span class="muted">owed</span>' : ''}<br><span class="muted">${esc(a.balance_as_of || '')}</span></td>
    <td class="row-actions">${actions}</td>
  </tr>
  <tr class="hidden" id="fin-acct-editor-${cssId(a.id)}"><td colspan="3"></td></tr>`;
}
const cssId = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
function balanceEditor(a) {
  const owed = a.type === 'credit' || a.type === 'loan';
  return `<div class="fin-edit"><div class="row"><label>new balance${owed ? ' (amount owed)' : ''}</label><input id="fae-bal" type="number" step="0.01" value="${owed ? -a.balance : a.balance}"><label>as of</label><input id="fae-date" type="date" value="${today()}"><button class="primary" data-action="fin-acct-save-balance" data-id="${esc(a.id)}">Save</button><button data-action="fin-acct-close" data-id="${esc(a.id)}">Cancel</button></div></div>`;
}
function acctEditor(a) {
  return `<div class="fin-edit"><div class="row"><label>name</label><input id="fae-name" value="${esc(a.name)}"><label>type</label><select id="fae-type">${typeOptions(a.type)}</select><label>institution</label><input id="fae-inst" value="${esc(a.institution)}"></div>
       <div class="row"><label><input type="checkbox" id="fae-hidden"${a.hidden ? ' checked' : ''}> hide from net worth</label><label><input type="checkbox" id="fae-closed"${a.closed ? ' checked' : ''}> closed</label>
       <span class="sp"></span><button class="primary" data-action="fin-acct-save" data-id="${esc(a.id)}">Save</button><button data-action="fin-acct-close" data-id="${esc(a.id)}">Cancel</button><button class="danger" data-action="fin-acct-del" data-id="${esc(a.id)}">Delete account + its transactions</button></div></div>`;
}
function openAcctEditor(id, mode) {
  const a = acctById.get(id); if (!a) return;
  const row = document.getElementById(`fin-acct-editor-${cssId(id)}`); if (!row) return;
  row.classList.remove('hidden');
  row.firstElementChild.innerHTML = mode === 'balance' ? balanceEditor(a) : acctEditor(a);
}
registerAction('fin-acct-edit', (el) => openAcctEditor(el.dataset.id, 'edit'));
registerAction('fin-acct-balance', (el) => openAcctEditor(el.dataset.id, 'balance'));
registerAction('fin-acct-close', (el) => document.getElementById(`fin-acct-editor-${cssId(el.dataset.id)}`)?.classList.add('hidden'));
registerAction('fin-acct-save', async (el) => {
  const row = document.getElementById(`fin-acct-editor-${cssId(el.dataset.id)}`);
  const q = (s) => row.querySelector(s);
  try {
    await api('PATCH', `${F}/accounts/${encodeURIComponent(el.dataset.id)}`, { name: q('#fae-name').value.trim(), type: q('#fae-type').value, institution: q('#fae-inst').value.trim(), hidden: q('#fae-hidden').checked, closed: q('#fae-closed').checked });
    toast('saved'); background(renderAccounts(el.closest('.pane')));
  } catch (e) { toast(e.message, 'err'); }
});
registerAction('fin-acct-save-balance', async (el) => {
  const row = document.getElementById(`fin-acct-editor-${cssId(el.dataset.id)}`);
  const a = acctById.get(el.dataset.id);
  let balance = Number(row.querySelector('#fae-bal').value);
  if (a.type === 'credit' || a.type === 'loan') balance = -Math.abs(balance);
  try { await api('PUT', `${F}/accounts/${encodeURIComponent(el.dataset.id)}/balance`, { balance, as_of: row.querySelector('#fae-date').value || today() }); toast('balance updated'); background(renderAccounts(el.closest('.pane'))); }
  catch (e) { toast(e.message, 'err'); }
});
registerAction('fin-acct-del', async (el) => {
  if (!confirm('Delete this account and every transaction in it? This cannot be undone.')) return;
  try { await api('DELETE', `${F}/accounts/${encodeURIComponent(el.dataset.id)}`); toast('deleted'); background(renderAccounts(el.closest('.pane'))); } catch (e) { toast(e.message, 'err'); }
});
registerAction('fin-goal-del', async (el) => { try { await api('DELETE', `${F}/goals/${el.dataset.id}`); background(renderAccounts(el.closest('.pane'))); } catch (e) { toast(e.message, 'err'); } });
registerAction('fin-nw-range', (el) => { nwRange = el.dataset.range; background(renderAccounts(el.closest('.pane'))); });

// ============================================================================
// Transactions
// ============================================================================
const PAGE = 100;
const tx = { filters: { q: '', account_id: '', category_id: '', from: '', to: '', uncategorized: false, unreviewed: false, include_excluded: false, include_pending: false }, offset: 0, rows: [], splits: {}, total: 0, selected: new Set(), open: null, pane: null };
function txQuery() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(tx.filters)) if (v !== '' && v !== false) p.set(k, String(v));
  p.set('limit', String(PAGE)); p.set('offset', String(tx.offset));
  return p.toString();
}
async function renderTransactions(pane) {
  tx.pane = pane;
  pane.innerHTML = '<p class="muted">loading…</p>';
  try {
    await loadRefs();
    const f = tx.filters;
    pane.innerHTML = `
      <div class="panel">
        <div class="fin-toolbar">
          <input type="search" id="ftx-q" placeholder="search payee, description, notes" value="${esc(f.q)}">
          <select id="ftx-acct" data-change="ftx-filter">${acctOptions(f.account_id)}</select>
          <select id="ftx-cat" data-change="ftx-filter"><option value="">all categories</option>${catOptions(f.category_id, { blank: false })}</select>
          <input type="date" id="ftx-from" data-change="ftx-filter" value="${esc(f.from)}" aria-label="from"> <input type="date" id="ftx-to" data-change="ftx-filter" value="${esc(f.to)}" aria-label="to">
          <span class="sp"></span>
          <button data-action="ftx-add">+ transaction</button>
          <button data-action="ftx-export">export CSV</button>
        </div>
        <div class="fin-chips">
          <button class="fin-chip${f.uncategorized ? ' active' : ''}" data-action="ftx-toggle" data-key="uncategorized">uncategorized</button>
          <button class="fin-chip${f.unreviewed ? ' active' : ''}" data-action="ftx-toggle" data-key="unreviewed">unreviewed</button>
          <button class="fin-chip${f.include_excluded ? ' active' : ''}" data-action="ftx-toggle" data-key="include_excluded">show excluded</button>
          <button class="fin-chip${f.include_pending ? ' active' : ''}" data-action="ftx-toggle" data-key="include_pending">show pending</button>
          ${['this month', 'last month', '3 months', 'year'].map(r => chip('ftx-range', 'range', r, r, false)).join('')}
        </div>
        <div id="ftx-add-form" class="hidden"></div>
        <div id="ftx-bulk" class="fin-toolbar hidden"></div>
        <div id="ftx-table"></div>
        <div id="ftx-pager" class="fin-pager"></div>
      </div>`;
    on(pane, '#ftx-q', 'keydown', (e) => { if (e.key === 'Enter') { tx.filters.q = e.target.value.trim(); tx.offset = 0; background(loadTxns()); } });
    on(pane, '#ftx-q', 'search', (e) => { tx.filters.q = e.target.value.trim(); tx.offset = 0; background(loadTxns()); });
    await loadTxns();
  } catch (e) { showErr(pane, e); }
}
async function loadTxns() {
  const pane = tx.pane; if (!pane) return;
  const table = pane.querySelector('#ftx-table'); if (!table) return;
  table.innerHTML = '<p class="muted">loading…</p>';
  try {
    const r = await api('GET', `${F}/transactions?${txQuery()}`);
    tx.rows = r.rows; tx.total = r.total; tx.splits = r.splits || {};
    tx.selected.clear();
    renderTxTable();
  } catch (e) { showErr(table, e); }
}
function renderTxTable() {
  const pane = tx.pane;
  if (!pane) return;
  const table = pane.querySelector('#ftx-table');
  if (!tx.rows.length) { table.innerHTML = '<p class="muted">No transactions match.</p>'; pane.querySelector('#ftx-pager').innerHTML = ''; return; }
  table.innerHTML = `<div class="table-wrap"><table class="fin" id="ftx-rows"><thead><tr><th><input type="checkbox" data-change="ftx-sel-all" aria-label="select all"></th><th>date</th><th>payee</th><th>category</th><th>account</th><th class="num">amount</th><th></th></tr></thead><tbody>${tx.rows.map(txRow).join('')}</tbody></table></div>`;
  const pages = Math.ceil(tx.total / PAGE), cur = Math.floor(tx.offset / PAGE) + 1;
  pane.querySelector('#ftx-pager').innerHTML = `<span>${tx.total} transactions · page ${cur} of ${pages}</span><button data-action="ftx-page" data-dir="-1"${cur <= 1 ? ' disabled' : ''}>‹ prev</button><button data-action="ftx-page" data-dir="1"${cur >= pages ? ' disabled' : ''}>next ›</button>`;
  renderBulk();
}
const tagChip = (x) => `<span>#${esc(x)}</span>`;
function payeeCell(t) {
  let extra = '';
  if (t.payee !== t.description) extra += `<br><span class="muted">${esc(t.description)}</span>`;
  if (t.notes) extra += `<br><span class="muted">${esc(t.notes)}</span>`;
  if (t.tags.length) extra += `<br><span class="fin-tags">${t.tags.map(tagChip).join('')}</span>`;
  return `<span class="fin-clickable" data-action="ftx-open" data-id="${esc(t.id)}">${esc(t.payee)}</span>${extra}`;
}
const splitSummary = (s) => `${esc(catName(s.category_id))} ${money(s.amount)}`;
function categoryCell(t) {
  const splits = tx.splits[t.id];
  const ctl = splits?.length
    ? `<span class="muted">split: ${splits.map(splitSummary).join(', ')}</span>`
    : catSelect(t.category_id || '', `data-change="ftx-cat" data-id="${esc(t.id)}" aria-label="category"`);
  const badge = t.category_source === 'rule' ? ' <span class="badge src-rule" title="set by a rule">rule</span>' : '';
  return ctl + badge;
}
function txRow(t) {
  const flags = [t.pending ? 'pending' : '', t.excluded ? 'excluded' : '', t.transfer_group ? 'transfer' : '', t.reviewed ? '' : 'new'].filter(Boolean);
  return `<tr class="${t.excluded ? 'excluded' : ''}${tx.selected.has(t.id) ? ' sel' : ''}" data-txid="${esc(t.id)}">
    <td><input type="checkbox" data-change="ftx-sel" data-id="${esc(t.id)}"${tx.selected.has(t.id) ? ' checked' : ''} aria-label="select"></td>
    <td class="muted">${esc(t.date)}</td>
    <td>${payeeCell(t)}</td>
    <td>${categoryCell(t)}</td>
    <td class="muted">${esc(acctById.get(t.account_id)?.name || t.account_id)}</td>
    <td class="num ${t.amount > 0 ? 'pos' : 'neg'}">${money(t.amount, t.currency)}</td>
    <td class="muted">${flags.map(x => esc(x)).join(' ')}</td>
  </tr>
  <tr class="hidden" id="ftx-editor-${cssId(t.id)}"><td colspan="7"></td></tr>`;
}
function renderBulk() {
  const el = tx.pane.querySelector('#ftx-bulk');
  if (!tx.selected.size) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<span>${tx.selected.size} selected</span>${catSelect('', 'id="ftx-bulk-cat" aria-label="bulk category"')}<button data-action="ftx-bulk-cat">set category</button><button data-action="ftx-bulk-reviewed">mark reviewed</button><button data-action="ftx-bulk-exclude">exclude</button><button data-action="ftx-bulk-include">include</button><button data-action="ftx-bulk-clear">clear</button>`;
}
function openTxEditor(id) {
  const t = tx.rows.find(x => x.id === id); if (!t) return;
  const row = document.getElementById(`ftx-editor-${cssId(id)}`); if (!row) return;
  if (tx.open === id) { row.classList.add('hidden'); tx.open = null; return; }
  if (tx.open) document.getElementById(`ftx-editor-${cssId(tx.open)}`)?.classList.add('hidden');
  tx.open = id;
  const splits = tx.splits[id] || [];
  row.classList.remove('hidden');
  const amountRow = t.source === 'manual' ? `<div class="row"><label>date</label><input id="fte-date" type="date" value="${esc(t.date)}"><label>amount</label><input id="fte-amount" type="number" step="0.01" value="${t.amount}"></div>` : '';
  const delBtn = (t.source === 'manual' || t.source === 'import') ? `<button class="danger" data-action="ftx-del" data-id="${esc(id)}">delete</button>` : '';
  const providerCat = t.provider_category ? ` · provider says ${esc(t.provider_category)}` : '';
  row.firstElementChild.innerHTML = `<div class="fin-edit">
    <div class="row"><label>payee</label><input id="fte-payee" value="${esc(t.payee)}" class="wide"><label>notes</label><input id="fte-notes" value="${esc(t.notes)}" class="wide"><label>tags</label><input id="fte-tags" value="${esc(t.tags.join(', '))}" placeholder="comma separated"></div>
    ${amountRow}
    <div class="row"><label><input type="checkbox" id="fte-excluded"${t.excluded ? ' checked' : ''}> exclude from reports (transfer, reimbursed…)</label><label><input type="checkbox" id="fte-reviewed"${t.reviewed ? ' checked' : ''}> reviewed</label></div>
    <div class="row fin-splits-head"><strong>Splits</strong> <span class="muted">must add up to ${money(t.amount)}</span> <button data-action="ftx-split-add" data-id="${esc(id)}">+ split</button></div>
    <div class="fin-splits" id="fte-splits">${splits.map(splitRow).join('')}</div>
    <div class="row"><button class="primary" data-action="ftx-save" data-id="${esc(id)}">Save</button><button data-action="ftx-rule-from" data-id="${esc(id)}">make a rule from this</button>${delBtn}<span class="muted">source: ${esc(t.source)}${providerCat} · id ${esc(t.id)}</span></div>
  </div>`;
}
const EMPTY_SPLIT = { category_id: '', amount: '', notes: '' };
const splitRow = (split) => {
  const s = split || EMPTY_SPLIT;
  return `<div class="row">${catSelect(s.category_id || '', 'class="cat fte-split-cat" aria-label="split category"')}<input class="fte-split-amt amt" type="number" step="0.01" value="${s.amount}" placeholder="amount"><input class="fte-split-notes" value="${esc(s.notes || '')}" placeholder="note"><button data-action="ftx-split-rm">×</button></div>`;
};
registerAction('ftx-open', (el) => openTxEditor(el.dataset.id));
registerAction('ftx-split-add', () => { document.getElementById('fte-splits')?.insertAdjacentHTML('beforeend', splitRow()); });
registerAction('ftx-split-rm', (el) => el.closest('.row').remove());
registerAction('ftx-save', async (el) => {
  const id = el.dataset.id;
  const row = document.getElementById(`ftx-editor-${cssId(id)}`);
  const q = (s) => row.querySelector(s);
  const patch = { payee: q('#fte-payee').value.trim(), notes: q('#fte-notes').value.trim(), tags: q('#fte-tags').value.split(',').map(s => s.trim()).filter(Boolean), excluded: q('#fte-excluded').checked, reviewed: q('#fte-reviewed').checked };
  if (q('#fte-date')) { patch.date = q('#fte-date').value; patch.amount = Number(q('#fte-amount').value); }
  const splits = [...row.querySelectorAll('#fte-splits .row')].map(r => ({ category_id: r.querySelector('.fte-split-cat').value || null, amount: Number(r.querySelector('.fte-split-amt').value), notes: r.querySelector('.fte-split-notes').value.trim() })).filter(s => !Number.isNaN(s.amount) && s.amount !== 0);
  try {
    await api('PATCH', `${F}/transactions/${encodeURIComponent(id)}`, patch);
    await api('PUT', `${F}/transactions/${encodeURIComponent(id)}/splits`, { splits });
    toast('saved'); tx.open = null; background(loadTxns());
  } catch (e) { toast(e.message, 'err'); }
});
registerAction('ftx-del', async (el) => {
  if (!confirm('Delete this transaction?')) return;
  try { await api('DELETE', `${F}/transactions/${encodeURIComponent(el.dataset.id)}`); tx.open = null; background(loadTxns()); } catch (e) { toast(e.message, 'err'); }
});
registerAction('ftx-rule-from', (el) => {
  const t = tx.rows.find(x => x.id === el.dataset.id); if (!t) return;
  sessionStorage.setItem('fin.rulePrefill', JSON.stringify({ pattern: t.payee, category_id: t.category_id || '' }));
  location.hash = '#finance-rules';
});
registerChange('ftx-cat', async (el) => {
  try { await api('PATCH', `${F}/transactions/${encodeURIComponent(el.dataset.id)}`, { category_id: el.value || null, reviewed: true }); toast('categorized'); const t = tx.rows.find(x => x.id === el.dataset.id); if (t) { t.category_id = el.value || null; t.category_source = 'user'; } }
  catch (e) { toast(e.message, 'err'); }
});
registerChange('ftx-filter', () => {
  const p = tx.pane;
  tx.filters.account_id = val(p, 'ftx-acct'); tx.filters.category_id = val(p, 'ftx-cat'); tx.filters.from = val(p, 'ftx-from'); tx.filters.to = val(p, 'ftx-to');
  tx.offset = 0; background(loadTxns());
});
registerAction('ftx-toggle', (el) => { tx.filters[el.dataset.key] = !tx.filters[el.dataset.key]; tx.offset = 0; background(renderTransactions(tx.pane)); });
registerAction('ftx-range', (el) => {
  const r = presetRange(el.dataset.range);
  tx.filters.from = r.from; tx.filters.to = r.to; tx.offset = 0; background(renderTransactions(tx.pane));
});
registerAction('ftx-page', (el) => { tx.offset = Math.max(0, tx.offset + Number(el.dataset.dir) * PAGE); background(loadTxns()); });
registerChange('ftx-sel', (el) => {
  if (el.checked) {
    tx.selected.add(el.dataset.id);
  } else {
    tx.selected.delete(el.dataset.id);
  }
  el.closest('tr').classList.toggle('sel', el.checked);
  renderBulk();
});
registerChange('ftx-sel-all', (el) => { tx.selected = new Set(el.checked ? tx.rows.map(r => r.id) : []); renderTxTable(); });
async function bulk(body) { try { const r = await api('POST', `${F}/transactions/bulk`, { ids: [...tx.selected], ...body }); toast(`${r.updated} updated`); background(loadTxns()); } catch (e) { toast(e.message, 'err'); } }
registerAction('ftx-bulk-cat', () => bulk({ category_id: document.getElementById('ftx-bulk-cat').value || null, reviewed: true }));
registerAction('ftx-bulk-reviewed', () => bulk({ reviewed: true }));
registerAction('ftx-bulk-exclude', () => bulk({ excluded: true }));
registerAction('ftx-bulk-include', () => bulk({ excluded: false }));
registerAction('ftx-bulk-clear', () => { tx.selected.clear(); renderTxTable(); });
registerAction('ftx-add', () => {
  const box = tx.pane.querySelector('#ftx-add-form');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = `<form class="fin-inline-form fin-edit" id="ftx-add-real">
    <label>account<select id="fta-acct">${acctOptions('', false)}</select></label>
    <label>date<input id="fta-date" type="date" value="${today()}" required></label>
    <label>payee<input id="fta-payee" required class="wide"></label>
    <label>amount<input id="fta-amount" type="number" step="0.01" required placeholder="negative = spend"></label>
    <label>category<select id="fta-cat">${catOptions('')}</select></label>
    <label>notes<input id="fta-notes"></label>
    <button type="submit" class="primary">Add</button></form>`;
  box.querySelector('#ftx-add-real').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', `${F}/transactions`, { account_id: val(box, 'fta-acct'), date: val(box, 'fta-date'), payee: val(box, 'fta-payee'), amount: Number(val(box, 'fta-amount')), category_id: val(box, 'fta-cat') || null, notes: val(box, 'fta-notes') });
      toast('added'); box.classList.add('hidden'); background(loadTxns());
    } catch (e) { toast(e.message, 'err'); }
  });
});
registerAction('ftx-export', async () => {
  try {
    const p = new URLSearchParams();
    if (tx.filters.from) {
      p.set('from', tx.filters.from);
    }
    if (tx.filters.to) {
      p.set('to', tx.filters.to);
    }
    const res = await fetch(`${F}/transactions/export.csv?${p}`, { headers: { 'X-Ritsu-Admin-Token': localStorage.getItem('ritsu.adminToken') || '' } });
    if (!res.ok) throw new Error(`export failed (${res.status})`);
    const blob = await res.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `transactions-${today()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast(e.message, 'err'); }
});
registerAction('fin-go', (el) => {
  if (el.dataset.filter) {
    for (const k of ['uncategorized', 'unreviewed']) {
      tx.filters[k] = false;
    }
    tx.filters[el.dataset.filter] = true;
    tx.offset = 0;
  }
  location.hash = `#${el.dataset.tab}`;
});

// ============================================================================
// Budgets
// ============================================================================
let budgetMonth = thisMonth();
let budgetScope = '*';
function budgetBarCls(l, pct, kind) {
  if (l.over) return 'over';
  if (pct >= 100 && kind === 'income') return 'ok';
  return '';
}
function remainingText(l) {
  if (!l) return '';
  if (l.over) return `over ${money(-l.remaining, 'USD', true)}`;
  return `${money(l.remaining, 'USD', true)} left`;
}
function budgetLine(c, l, spend) {
  let actual;
  if (l) actual = l.actual;
  else if (c.kind === 'income') actual = 0;
  else actual = spend;
  if (!l && !actual) return '';
  const budget = l?.budget ?? '';
  const pct = l?.budget ? actual / l.budget * 100 : 0;
  const monthBadge = l?.source === 'month' ? ' <span class="badge" title="set for this month only">this month</span>' : '';
  const barHtml = l ? bar(pct, budgetBarCls(l, pct, c.kind)) : '';
  return `<tr><td>${esc(c.name)}${monthBadge}</td>
          <td><input class="amt" type="number" step="1" min="0" data-change="fbd-set" data-cat="${esc(c.id)}" value="${budget}" placeholder="—" aria-label="budget"></td>
          <td class="num">${money(actual, 'USD', true)}</td>
          <td class="barcell">${barHtml}</td>
          <td class="num ${l?.over ? 'err' : 'muted'}">${remainingText(l)}</td></tr>`;
}
function budgetRows(b) {
  const budgetFor = (id) => b.lines.find(l => l.category_id === id);
  const spendFor = (id) => b.spend.find(s => s.category_id === id)?.total ?? 0;
  const groups = new Map();
  for (const c of cats.filter(c => !c.archived && c.kind !== 'transfer')) { const arr = groups.get(c.group_name) || []; arr.push(c); groups.set(c.group_name, arr); }
  return [...groups.entries()].map(([g, list]) => {
    const lines = list.map(c => budgetLine(c, budgetFor(c.id), spendFor(c.id))).join('');
    return lines ? `<tr class="group"><td colspan="5">${esc(g)}</td></tr>${lines}` : '';
  }).join('');
}
async function renderBudgets(pane) {
  pane.innerHTML = '<p class="muted">loading…</p>';
  try {
    await loadRefs();
    const b = await api('GET', `${F}/budgets?month=${budgetMonth}`);
    const T = b.totals;
    const rows = budgetRows(b);
    const monthName = new Date(`${budgetMonth}-15T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    pane.innerHTML = `
      <div class="panel">
        <div class="fin-toolbar">
          <div class="fin-month"><button data-action="fbd-month" data-dir="-1">‹</button><span>${esc(monthName)}</span><button data-action="fbd-month" data-dir="1">›</button></div>
          <span class="sp"></span>
          <label class="muted"><input type="radio" name="fbd-scope" data-change="fbd-scope" value="*"${budgetScope === '*' ? ' checked' : ''}> edits set every month</label>
          <label class="muted"><input type="radio" name="fbd-scope" data-change="fbd-scope" value="month"${budgetScope === 'month' ? ' checked' : ''}> edits set this month only</label>
        </div>
        <div class="fin-kpis">
          <div class="fin-kpi"><div class="l">Budgeted spend</div><div class="v">${money(T.actual_expenses - T.unbudgeted_expenses, 'USD', true)} <span class="muted">/ ${money(T.budgeted_expenses, 'USD', true)}</span></div></div>
          <div class="fin-kpi"><div class="l">Left in budgets</div><div class="v ${T.budgeted_expenses - (T.actual_expenses - T.unbudgeted_expenses) < 0 ? 'err' : 'ok'}">${money(T.budgeted_expenses - (T.actual_expenses - T.unbudgeted_expenses), 'USD', true)}</div></div>
          <div class="fin-kpi"><div class="l">Outside budgets</div><div class="v">${money(T.unbudgeted_expenses, 'USD', true)}</div></div>
          <div class="fin-kpi"><div class="l">All expenses</div><div class="v">${money(T.actual_expenses, 'USD', true)}</div></div>
          <div class="fin-kpi"><div class="l">Income</div><div class="v ok">${money(T.actual_income, 'USD', true)} <span class="muted">/ ${money(T.budgeted_income, 'USD', true)}</span></div></div>
        </div>
        <p class="fin-note">Type a number next to a category to budget it. Blank it to remove the budget. Categories with no budget and no activity this month are hidden.</p>
        <div class="table-wrap"><table class="fin"><thead><tr><th>category</th><th>budget</th><th class="num">actual</th><th></th><th class="num"></th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No activity this month.</td></tr>'}</tbody></table></div>
      </div>`;
  } catch (e) { showErr(pane, e); }
}
registerAction('fbd-month', (el) => { budgetMonth = shiftMonth(budgetMonth, Number(el.dataset.dir)); background(renderBudgets(el.closest('.pane'))); });
registerChange('fbd-scope', (el) => { budgetScope = el.value; });
registerChange('fbd-set', async (el) => {
  const month = budgetScope === '*' ? '*' : budgetMonth;
  try {
    if (el.value.trim() === '') await api('DELETE', `${F}/budgets/${encodeURIComponent(el.dataset.cat)}/${encodeURIComponent(month)}`).catch(() => null);
    else await api('PUT', `${F}/budgets`, { category_id: el.dataset.cat, month, amount: Number(el.value) });
    background(renderBudgets(el.closest('.pane')));
  } catch (e) { toast(e.message, 'err'); }
});

// ============================================================================
// Recurring
// ============================================================================
function recurringStatusButtons(x) {
  if (x.status === 'detected') return `<button data-action="frc-status" data-id="${x.id}" data-status="confirmed" class="primary">confirm</button><button data-action="frc-status" data-id="${x.id}" data-status="dismissed">not recurring</button>`;
  if (x.status === 'dismissed') return `<button data-action="frc-status" data-id="${x.id}" data-status="confirmed">restore</button>`;
  return '<span class="badge ok-tint">confirmed</span>';
}
function recurringRow(x) {
  const cadenceOpts = CADENCES.map(c => opt(c, c, c === x.cadence)).join('');
  const seen = x.occurrences ? `${x.occurrences}× seen` : 'manual';
  const last = x.last_date ? `, last ${esc(x.last_date)}` : '';
  const catSel = catSelect(x.category_id || '', `data-change="frc-cat" data-id="${x.id}" aria-label="category"`);
  return `<tr><td>${esc(x.display_name)}<br><span class="muted">${esc(acctById.get(x.account_id)?.name || '')}</span></td>
      <td>${catSel}</td>
      <td class="num"><input class="amt" type="number" step="0.01" data-change="frc-amount" data-id="${x.id}" value="${Math.abs(x.amount).toFixed(2)}" aria-label="amount"></td>
      <td><select data-change="frc-cadence" data-id="${x.id}" aria-label="cadence">${cadenceOpts}</select></td>
      <td><input type="date" data-change="frc-next" data-id="${x.id}" value="${esc(x.next_date)}" aria-label="next date"></td>
      <td class="muted">${seen}${last}</td>
      <td class="row-actions">${recurringStatusButtons(x)} <button class="danger" data-action="frc-del" data-id="${x.id}">×</button></td></tr>`;
}
const dueItem = (u) => `<li><span>${esc(u.display_name)} <span class="muted">${esc(u.next_date)} · ${dueIn(u.days_until)}</span></span><span class="r">${money(Math.abs(u.amount))}</span></li>`;
async function renderRecurring(pane) {
  pane.innerHTML = '<p class="muted">loading…</p>';
  try {
    await loadRefs();
    const r = await api('GET', `${F}/recurring`);
    const active = r.recurring.filter(x => x.status !== 'dismissed');
    const dismissed = r.recurring.filter(x => x.status === 'dismissed');
    const perMonth = { weekly: 4.33, biweekly: 2.17, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
    const monthly = active.reduce((s, x) => s + Math.abs(x.amount) * (perMonth[x.cadence] || 1), 0);
    const dueList = r.upcoming.length ? `<ul class="fin-list">${r.upcoming.map(dueItem).join('')}</ul>` : '<p class="muted">Nothing due.</p>';
    const duePanel = panel('Due in the next 30 days', dueList);
    const commitPanel = panel('Monthly commitment', `<div class="fin-big">${money(monthly, 'USD', true)}<span class="muted"> /mo</span></div><div class="fin-sub">${active.length} recurring item${active.length === 1 ? '' : 's'}, normalized to a month</div><p class="fin-note">Detected items are guesses from your history: a payee charging a steady amount on a steady cadence. Confirm the real ones; dismiss the rest and they stay dismissed.</p><button data-action="frc-detect">Re-scan history</button>`);
    const activeRows = active.map(recurringRow).join('') || '<tr><td colspan="7" class="muted">Nothing yet — sync or import a few months of history, then re-scan.</td></tr>';
    const dismissedHtml = dismissed.length ? `<details><summary class="muted">${dismissed.length} dismissed</summary><div class="table-wrap"><table class="fin"><tbody>${dismissed.map(recurringRow).join('')}</tbody></table></div></details>` : '';
    const chargesPanel = panel('Recurring charges', `<div class="table-wrap"><table class="fin"><thead><tr><th>payee</th><th>category</th><th class="num">amount</th><th>cadence</th><th>next</th><th></th><th></th></tr></thead><tbody>${activeRows}</tbody></table></div>
          ${dismissedHtml}`, 'fin-wide');
    const cadOpts = ['monthly', 'weekly', 'biweekly', 'quarterly', 'yearly'].map(c => opt(c, c, false)).join('');
    const addPanel = panel('Add one by hand', `<form class="fin-inline-form" id="frc-form">
          <label>payee<input id="frc-name" required class="wide" placeholder="Rent"></label>
          <label>amount<input id="frc-amt" type="number" step="0.01" required placeholder="1500"></label>
          <label>cadence<select id="frc-cad">${cadOpts}</select></label>
          <label>next due<input id="frc-date" type="date" required value="${today()}"></label>
          <label>category<select id="frc-catsel">${catOptions('')}</select></label>
          <label>account<select id="frc-acct">${acctOptions('')}</select></label>
          <button type="submit" class="primary">Add</button></form>`, 'fin-wide');
    pane.innerHTML = `
      <div class="fin-grid">
        ${duePanel}
        ${commitPanel}
        ${chargesPanel}
        ${addPanel}
      </div>`;
    on(pane, '#frc-form', 'submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('POST', `${F}/recurring`, { display_name: val(pane, 'frc-name'), amount: -Math.abs(Number(val(pane, 'frc-amt'))), cadence: val(pane, 'frc-cad'), next_date: val(pane, 'frc-date'), category_id: val(pane, 'frc-catsel') || null, account_id: val(pane, 'frc-acct') || null });
        toast('added'); background(renderRecurring(pane));
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { showErr(pane, e); }
}
const patchRecurring = async (el, body) => { try { await api('PATCH', `${F}/recurring/${el.dataset.id}`, body); } catch (e) { toast(e.message, 'err'); } };
registerChange('frc-cat', (el) => patchRecurring(el, { category_id: el.value || null }));
registerChange('frc-amount', (el) => patchRecurring(el, { amount: -Math.abs(Number(el.value)) }));
registerChange('frc-cadence', (el) => patchRecurring(el, { cadence: el.value }));
registerChange('frc-next', (el) => patchRecurring(el, { next_date: el.value }));
registerAction('frc-status', async (el) => { await patchRecurring(el, { status: el.dataset.status }); background(renderRecurring(el.closest('.pane'))); });
registerAction('frc-del', async (el) => { try { await api('DELETE', `${F}/recurring/${el.dataset.id}`); background(renderRecurring(el.closest('.pane'))); } catch (e) { toast(e.message, 'err'); } });
registerAction('frc-detect', async (el) => { try { const r = await api('POST', `${F}/recurring/detect`); toast(`${r.detected} pattern${r.detected === 1 ? '' : 's'} found`); background(renderRecurring(el.closest('.pane'))); } catch (e) { toast(e.message, 'err'); } });

// ============================================================================
// Reports
// ============================================================================
const rep = { view: 'spending', range: 'this month', from: '', to: '', by: 'category', months: 12 };
// Shared by the transactions range chips ('year') and the reports range chips ('year to date').
function presetRange(name) {
  const m = thisMonth();
  switch (name) {
    case 'last month': return monthRange(shiftMonth(m, -1));
    case '3 months': return { from: monthRange(shiftMonth(m, -2)).from, to: today() };
    case '12 months': return { from: monthRange(shiftMonth(m, -11)).from, to: today() };
    case 'year':
    case 'year to date': return { from: `${m.slice(0, 4)}-01-01`, to: today() };
    default: return monthRange(m);
  }
}
function repRange() {
  if (rep.range === 'custom') return { from: rep.from || monthRange(thisMonth()).from, to: rep.to || today() };
  return presetRange(rep.range);
}
function spendingRows(r) {
  if (rep.by === 'group') return r.by_group;
  if (rep.by === 'payee') return r.by_payee.map(p => ({ name: p.payee, total: p.total, count: p.count }));
  return r.by_category;
}
async function reportSpending() {
  const { from, to } = repRange();
  const r = await api('GET', `${F}/reports/spending?from=${from}&to=${to}`);
  const rangeChips = ['this month', 'last month', '3 months', '12 months', 'year to date', 'custom'].map(x => chip('frp-range', 'range', x, x, rep.range === x)).join('');
  const customDates = rep.range === 'custom' ? `<div class="fin-toolbar"><input type="date" id="frp-from" data-change="frp-dates" value="${esc(rep.from)}"> <input type="date" id="frp-to" data-change="frp-dates" value="${esc(rep.to)}"></div>` : '';
  const byChips = ['category', 'group', 'payee'].map(x => chip('frp-by', 'by', x, `by ${x}`, rep.by === x)).join('');
  return `<div class="fin-chips">${rangeChips}</div>
        ${customDates}
        <div class="fin-chips">${byChips}</div>
        <div class="fin-big">${money(r.total, 'USD', true)}</div><div class="fin-sub">spent ${esc(from)} → ${esc(to)}</div>
        ${barTable(spendingRows(r), { label: x => esc(x.name), value: x => x.total, count: x => x.count })}`;
}
const savedPct = (m) => (m.savings_rate == null ? '—' : `${Math.round(m.savings_rate * 100)}%`);
const cashRow = (m) => `<tr><td>${esc(monthLabel(m.month))}</td><td class="num pos">${money(m.income, 'USD', true)}</td><td class="num">${money(m.expenses, 'USD', true)}</td><td class="num ${m.net < 0 ? 'err' : ''}">${signed(m.net)}</td><td class="num muted">${savedPct(m)}</td></tr>`;
async function reportCashFlow() {
  const r = await api('GET', `${F}/reports/cashflow?months=${rep.months}`);
  const tot = r.months.reduce((s, m) => ({ income: s.income + m.income, expenses: s.expenses + m.expenses }), { income: 0, expenses: 0 });
  const rows = [...r.months].reverse().map(cashRow).join('');
  return `${cashFlowChart(r.months)}
        <div class="fin-kpis"><div class="fin-kpi"><div class="l">Income (${rep.months}mo)</div><div class="v ok">${money(tot.income, 'USD', true)}</div></div><div class="fin-kpi"><div class="l">Expenses</div><div class="v">${money(tot.expenses, 'USD', true)}</div></div><div class="fin-kpi"><div class="l">Net</div><div class="v ${tot.income - tot.expenses >= 0 ? 'ok' : 'err'}">${signed(tot.income - tot.expenses)}</div></div><div class="fin-kpi"><div class="l">Avg saved</div><div class="v">${tot.income ? Math.round((tot.income - tot.expenses) / tot.income * 100) : 0}%</div></div></div>
        <div class="table-wrap"><table class="fin"><thead><tr><th>month</th><th class="num">income</th><th class="num">expenses</th><th class="num">net</th><th class="num">saved</th></tr></thead><tbody>${rows}</tbody></table></div>
        <h2>Income sources</h2>${barTable(r.income_sources, { label: x => esc(x.payee), value: x => x.total, count: x => x.count })}`;
}
function trendGroupPanel(g) {
  const avg = g.series.reduce((s, x) => s + x.total, 0) / g.series.length;
  return `<div class="panel"><h2>${esc(g.group)} <span class="muted">avg ${money(avg, 'USD', true)}/mo</span></h2>${barTable(g.series, { label: x => esc(monthLabel(x.month)), value: x => x.total, max: Math.max(...g.series.map(x => x.total)) })}</div>`;
}
async function reportTrends() {
  const r = await api('GET', `${F}/reports/trend?months=${rep.months}`);
  return `<h2>Total spending by month</h2>${cashFlowChart(r.total.map(t => ({ month: t.month, income: 0, expenses: t.total })))}
        <div class="fin-grid">${r.by_group.map(trendGroupPanel).join('')}</div>`;
}
function nwKpis(first, last) {
  if (!first || !last) return '';
  return `<div class="fin-kpis"><div class="fin-kpi"><div class="l">Now</div><div class="v">${money(last.net, 'USD', true)}</div></div><div class="fin-kpi"><div class="l">Change (1y)</div><div class="v ${last.net - first.net >= 0 ? 'ok' : 'err'}">${signed(last.net - first.net)}</div></div><div class="fin-kpi"><div class="l">Assets</div><div class="v">${money(last.assets, 'USD', true)}</div></div><div class="fin-kpi"><div class="l">Liabilities</div><div class="v">${money(last.liabilities, 'USD', true)}</div></div></div>`;
}
async function reportNetWorth() {
  const r = await api('GET', `${F}/networth/history?from=${addDays(today(), -365)}&to=${today()}`);
  return `${lineChart(r.series, { tall: true })}${nwKpis(r.series[0], r.series.at(-1))}
        <h2>Assets vs liabilities</h2>${lineChart(r.series, { key: 'assets' })}${lineChart(r.series, { key: 'liabilities' })}`;
}
const REPORT_VIEWS = { spending: reportSpending, 'cash flow': reportCashFlow, trends: reportTrends, 'net worth': reportNetWorth };
async function renderReports(pane) {
  pane.innerHTML = '<p class="muted">loading…</p>';
  try {
    await loadRefs();
    const body = await (REPORT_VIEWS[rep.view] || reportNetWorth)();
    const viewChips = Object.keys(REPORT_VIEWS).map(v => chip('frp-view', 'view', v, v, rep.view === v)).join('');
    let monthChips = '';
    if (rep.view === 'cash flow' || rep.view === 'trends') {
      const months = [6, 12, 24].map(n => chip('frp-months', 'n', n, `${n}mo`, rep.months === n)).join('');
      monthChips = `<span class="sp"></span>${months}`;
    }
    pane.innerHTML = `<div class="panel"><div class="fin-chips">${viewChips}${monthChips}</div>${body}</div>`;
  } catch (e) { showErr(pane, e); }
}
registerAction('frp-view', (el) => { rep.view = el.dataset.view; background(renderReports(el.closest('.pane'))); });
registerAction('frp-range', (el) => { rep.range = el.dataset.range; background(renderReports(el.closest('.pane'))); });
registerAction('frp-by', (el) => { rep.by = el.dataset.by; background(renderReports(el.closest('.pane'))); });
registerAction('frp-months', (el) => { rep.months = Number(el.dataset.n); background(renderReports(el.closest('.pane'))); });
registerChange('frp-dates', (el) => { const p = el.closest('.pane'); rep.from = val(p, 'frp-from'); rep.to = val(p, 'frp-to'); if (rep.from && rep.to) background(renderReports(p)); });

// ============================================================================
// Categories & Rules
// ============================================================================
function describeRule(r) {
  const field = r.field === 'any' ? 'payee or description' : r.field;
  const amount = r.amount_min != null || r.amount_max != null ? ` · amount ${r.amount_min ?? 0}–${r.amount_max ?? '∞'}` : '';
  const acct = r.account_id ? ` · ${esc(acctById.get(r.account_id)?.name || r.account_id)}` : '';
  return `${field} ${r.op.replace('_', ' ')} “${esc(r.pattern)}”${amount}${acct}`;
}
function exclusionLabel(v) {
  if (v == null) return '';
  return v ? 'exclude' : 'include';
}
const ruleEffects = (r) => [r.set_category_id ? `→ ${esc(catName(r.set_category_id))}` : '', r.set_payee ? `rename “${esc(r.set_payee)}”` : '', exclusionLabel(r.set_excluded), r.set_tags?.length ? `#${r.set_tags.map(x => esc(x)).join(' #')}` : ''].filter(Boolean).join(' · ');
const ruleRow = (r) => `<tr class="${r.enabled ? '' : 'excluded'}"><td class="muted">${r.priority}</td><td>${describeRule(r)}</td><td>${ruleEffects(r)}</td><td class="row-actions"><button data-action="frl-toggle" data-id="${r.id}" data-enabled="${r.enabled ? 1 : 0}">${r.enabled ? 'disable' : 'enable'}</button><button class="danger" data-action="frl-del" data-id="${r.id}">×</button></td></tr>`;
function catRow(c) {
  const del = c.id !== 'uncategorized' ? `<button class="danger" data-action="fct-del" data-id="${esc(c.id)}">×</button>` : '';
  return `<tr class="${c.archived ? 'excluded' : ''}"><td><input data-change="fct-name" data-id="${esc(c.id)}" value="${esc(c.name)}" aria-label="name"></td><td class="muted">${esc(c.kind)}${c.builtin ? '' : ' · custom'}</td><td class="row-actions"><button data-action="fct-archive" data-id="${esc(c.id)}" data-archived="${c.archived ? 1 : 0}">${c.archived ? 'unarchive' : 'archive'}</button>${del}</td></tr>`;
}
const catGroupRows = ([g, list]) => `<tr class="group"><td colspan="3">${esc(g)}</td></tr>${list.map(catRow).join('')}`;
function mapRow([k, v]) {
  const sel = catSelect(v, `data-change="fcm-set" data-key="${esc(k)}" aria-label="maps to"`, { blank: false });
  return `<tr><td class="muted">${esc(k)}</td><td>${sel}</td></tr>`;
}
const groupOption = (g) => `<option value="${esc(g)}">`;
async function renderRules(pane) {
  pane.innerHTML = '<p class="muted">loading…</p>';
  try {
    await loadRefs();
    const [rules, cmap] = await Promise.all([api('GET', `${F}/rules`), api('GET', `${F}/categories?all=1`)]);
    const prefill = JSON.parse(sessionStorage.getItem('fin.rulePrefill') || 'null'); sessionStorage.removeItem('fin.rulePrefill');
    const groups = new Map();
    for (const c of cats) { const arr = groups.get(c.group_name) || []; arr.push(c); groups.set(c.group_name, arr); }
    const ruleRows = rules.rules.map(ruleRow).join('') || '<tr><td class="muted">No rules yet.</td></tr>';
    const rulesPanel = panel('Rules', `<p class="fin-note">Rules run on every new transaction, in priority order (lower first). They never override a category you set by hand.</p>
          <div class="table-wrap"><table class="fin"><tbody>${ruleRows}</tbody></table></div>
          <div class="fin-toolbar"><button data-action="frl-apply">Re-run all rules on uncategorized history</button></div>
          <form class="fin-inline-form fin-edit" id="frl-form">
            <label>when<select id="frl-field"><option value="any">payee or description</option><option value="payee">payee</option><option value="description">description</option></select></label>
            <label>&nbsp;<select id="frl-op"><option value="contains">contains</option><option value="starts_with">starts with</option><option value="equals">equals</option></select></label>
            <label>text<input id="frl-pattern" required class="wide" value="${esc(prefill?.pattern || '')}"></label>
            <label>amount min<input id="frl-min" type="number" step="0.01" min="0"></label>
            <label>max<input id="frl-max" type="number" step="0.01" min="0"></label>
            <label>account<select id="frl-acct">${acctOptions('')}</select></label>
            <label>set category<select id="frl-cat">${catOptions(prefill?.category_id || '')}</select></label>
            <label>rename payee<input id="frl-payee" placeholder="optional"></label>
            <label>tags<input id="frl-tags" placeholder="comma separated"></label>
            <label>exclude<select id="frl-excl"><option value="">leave as is</option><option value="1">exclude from reports</option><option value="0">include</option></select></label>
            <label>priority<input id="frl-pri" type="number" value="100" min="0"></label>
            <label><input type="checkbox" id="frl-existing" checked> apply to existing</label>
            <button type="submit" class="primary">Add rule</button>
          </form>`, 'fin-wide');
    const catRows = [...groups.entries()].map(catGroupRows).join('');
    const groupOpts = [...groups.keys()].map(groupOption).join('');
    const catsPanel = panel('Categories', `<p class="fin-note">Archive what you don't use; it stays on old transactions. Deleting moves its transactions to Uncategorized.</p>
          <div class="table-wrap"><table class="fin"><tbody>${catRows}</tbody></table></div>
          <form class="fin-inline-form" id="fct-form">
            <label>name<input id="fct-new-name" required placeholder="Kids"></label>
            <label>group<input id="fct-new-group" required list="fct-groups" placeholder="Personal"><datalist id="fct-groups">${groupOpts}</datalist></label>
            <label>kind<select id="fct-new-kind"><option value="expense">expense</option><option value="income">income</option><option value="transfer">transfer</option></select></label>
            <button type="submit" class="primary">Add category</button>
          </form>`);
    const mapRows = Object.entries(cmap.map).sort(([a], [b]) => a.localeCompare(b)).map(mapRow).join('');
    const mapPanel = panel('Provider category map', `<p class="fin-note">How a bank feed's own labels land in your categories. Change a mapping and future syncs follow it.</p>
          <details><summary class="muted">${Object.keys(cmap.map).length} mappings</summary><div class="table-wrap"><table class="fin"><tbody>${mapRows}</tbody></table></div></details>`);
    pane.innerHTML = `
      <div class="fin-grid">
        ${rulesPanel}
        ${catsPanel}
        ${mapPanel}
      </div>`;
    on(pane, '#frl-form', 'submit', async (ev) => {
      ev.preventDefault();
      const excl = val(pane, 'frl-excl');
      try {
        const r = await api('POST', `${F}/rules`, {
          field: val(pane, 'frl-field'), op: val(pane, 'frl-op'), pattern: val(pane, 'frl-pattern'), amount_min: num(pane, 'frl-min'), amount_max: num(pane, 'frl-max'),
          account_id: val(pane, 'frl-acct') || null, set_category_id: val(pane, 'frl-cat') || null, set_payee: val(pane, 'frl-payee') || null,
          set_tags: val(pane, 'frl-tags').split(',').map(s => s.trim()).filter(Boolean), set_excluded: excl === '' ? null : excl === '1', priority: num(pane, 'frl-pri') ?? 100,
          apply_to_existing: pane.querySelector('#frl-existing').checked,
        });
        const applied = r.applied ? `, ${r.applied} transactions updated` : '';
        toast(`rule added${applied}`); background(renderRules(pane));
      } catch (e) { toast(e.message, 'err'); }
    });
    on(pane, '#fct-form', 'submit', async (ev) => {
      ev.preventDefault();
      const name = val(pane, 'fct-new-name');
      try {
        await api('POST', `${F}/categories`, { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40), name, group_name: val(pane, 'fct-new-group'), kind: val(pane, 'fct-new-kind') });
        toast('category added'); background(renderRules(pane));
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { showErr(pane, e); }
}
registerAction('frl-toggle', async (el) => { try { await api('PATCH', `${F}/rules/${el.dataset.id}`, { enabled: el.dataset.enabled !== '1' }); background(renderRules(el.closest('.pane'))); } catch (e) { toast(e.message, 'err'); } });
registerAction('frl-del', async (el) => { try { await api('DELETE', `${F}/rules/${el.dataset.id}`); background(renderRules(el.closest('.pane'))); } catch (e) { toast(e.message, 'err'); } });
registerAction('frl-apply', async () => { try { const r = await api('POST', `${F}/rules/apply`); toast(`${r.applied} transactions updated`); } catch (e) { toast(e.message, 'err'); } });
registerChange('fct-name', async (el) => { try { await api('PATCH', `${F}/categories/${encodeURIComponent(el.dataset.id)}`, { name: el.value.trim() }); toast('renamed'); } catch (e) { toast(e.message, 'err'); } });
registerAction('fct-archive', async (el) => { try { await api('PATCH', `${F}/categories/${encodeURIComponent(el.dataset.id)}`, { archived: el.dataset.archived !== '1' }); background(renderRules(el.closest('.pane'))); } catch (e) { toast(e.message, 'err'); } });
registerAction('fct-del', async (el) => {
  if (!confirm('Delete this category? Its transactions move to Uncategorized.')) return;
  try {
    await api('DELETE', `${F}/categories/${encodeURIComponent(el.dataset.id)}`);
    background(renderRules(el.closest('.pane')));
  } catch (e) { toast(e.message, 'err'); }
});
registerChange('fcm-set', async (el) => { try { await api('PUT', `${F}/category-map`, { provider_category: el.dataset.key, category_id: el.value }); toast('mapping saved'); } catch (e) { toast(e.message, 'err'); } });

// ============================================================================
// Connections + import
// ============================================================================
function connError(x) {
  if (!x.error) return '';
  const cls = x.status === 'error' ? 'muted' : 'warn';
  return `<br><span class="${cls}">${esc(x.error)}</span>`;
}
const connRow = (x) => `<tr><td>${esc(x.label || x.id)}<br><span class="muted">${esc(x.provider)} · ${accounts.filter(a => a.connection_id === x.id).length} accounts</span></td>
      <td class="${x.status === 'error' ? 'err' : 'ok'}">${esc(x.status)}${connError(x)}</td>
      <td class="muted">${x.last_synced_at ? esc(new Date(x.last_synced_at * 1000).toLocaleString()) : 'never'}</td>
      <td class="row-actions"><button data-action="fcn-sync" data-id="${esc(x.id)}">sync</button><button class="danger" data-action="fcn-del" data-id="${esc(x.id)}">remove</button></td></tr>`;
function plaidPanel(plaid) {
  if (!plaid.configured) return panel('Plaid', `<p class="fin-note">Plaid needs an app at <code>dashboard.plaid.com</code>; new teams get a free Trial plan for a handful of live Items. Sandbox works without approval and has instant fake banks for trying the pipeline.</p>${plaidConfigForm()}`);
  const sandbox = plaid.env === 'sandbox' ? '<button data-action="fpl-sandbox">Link a sandbox bank</button>' : '';
  return panel('Plaid', `<p class="fin-note">Configured for <strong>${esc(plaid.env)}</strong>. Linking opens Plaid's hosted page in a new tab; come back and press “I finished linking”.</p>
             <div class="fin-toolbar">${sandbox}<button data-action="fpl-start">Link a bank (Hosted Link)</button><button data-action="fpl-complete">I finished linking</button></div>
             <details><summary class="muted">advanced: exchange a public_token by hand</summary><form class="fin-inline-form" id="fpl-exchange"><label>public_token<input id="fpl-pt" required class="wide"></label><button type="submit">Exchange</button></form></details>
             <details><summary class="muted">change credentials</summary>${plaidConfigForm()}</details>`);
}
async function renderConnections(pane) {
  pane.innerHTML = '<p class="muted">loading…</p>';
  try {
    await loadRefs();
    const c = await api('GET', `${F}/connections`);
    const connRows = c.connections.map(connRow).join('') || '<tr><td colspan="4" class="muted">No banks connected yet.</td></tr>';
    const banksPanel = panel('Connected banks', `<div class="table-wrap"><table class="fin"><thead><tr><th>connection</th><th>status</th><th>last sync</th><th></th></tr></thead><tbody>${connRows}</tbody></table></div>
          <div class="fin-toolbar"><button class="primary" data-action="fcn-sync-all">Sync everything now</button><span class="muted">A scheduled job also syncs once a day.</span></div>`, 'fin-wide');
    const simplefinPanel = panel('SimpleFIN', `<p class="fin-note">Read-only bank access built for self-hosted tools (about $15/year, refreshes daily). Sign up at <code>bridge.simplefin.org</code>, connect your banks there, create an app and paste its <strong>setup token</strong> here. The token is used once and then discarded; the access key it yields is stored encrypted.</p>
          <form class="fin-inline-form" id="fsf-form"><label>setup token<input id="fsf-token" required class="wide" autocomplete="off"></label><label>label<input id="fsf-label" placeholder="optional"></label><button type="submit" class="primary">Connect</button></form>`);
    pane.innerHTML = `
      ${asOfLine(c.as_of)}
      <div class="fin-grid">
        ${banksPanel}
        ${simplefinPanel}
        ${plaidPanel(c.plaid)}
      </div>`;
    on(pane, '#fsf-form', 'submit', async (ev) => {
      ev.preventDefault();
      const btn = pane.querySelector('#fsf-form button'); btn.disabled = true; btn.textContent = 'connecting…';
      try {
        const r = await api('POST', `${F}/connections/simplefin`, { setup_token: val(pane, 'fsf-token'), label: val(pane, 'fsf-label') || undefined });
        toast(`connected: ${r.result.accounts} accounts, ${r.result.added} transactions`); background(renderConnections(pane));
      } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Connect'; }
    });
    on(pane, '#fpl-config', 'submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('POST', `${F}/connections/plaid/config`, { client_id: val(pane, 'fpl-cid'), secret: val(pane, 'fpl-secret'), env: val(pane, 'fpl-env') });
        toast('Plaid credentials saved'); background(renderConnections(pane));
      } catch (e) { toast(e.message, 'err'); }
    });
    on(pane, '#fpl-exchange', 'submit', async (ev) => {
      ev.preventDefault();
      try {
        await api('POST', `${F}/connections/plaid/exchange`, { public_token: val(pane, 'fpl-pt') });
        toast('linked'); background(renderConnections(pane));
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { showErr(pane, e); }
}
const plaidConfigForm = () => `<form class="fin-inline-form" id="fpl-config"><label>client id<input id="fpl-cid" required></label><label>secret<input id="fpl-secret" type="password" required autocomplete="off"></label><label>environment<select id="fpl-env"><option value="sandbox">sandbox</option><option value="production">production</option></select></label><button type="submit" class="primary">Save</button></form>`;

registerAction('fcn-sync-all', async (el) => {
  el.disabled = true;
  try {
    const r = await api('POST', `${F}/sync`);
    const errs = Object.values(r.results).filter(v => typeof v === 'string');
    toast(errs.length ? `sync finished with ${errs.length} error(s)` : 'synced');
    background(renderConnections(el.closest('.pane')));
  } catch (e) { toast(e.message, 'err'); el.disabled = false; }
});
registerAction('fcn-sync', async (el) => {
  try {
    const r = await api('POST', `${F}/connections/${encodeURIComponent(el.dataset.id)}/sync`);
    toast(`synced: ${r.result.added} new`);
    background(renderConnections(el.closest('.pane')));
  } catch (e) { toast(e.message, 'err'); background(renderConnections(el.closest('.pane'))); }
});
registerAction('fcn-del', async (el) => {
  if (!confirm('Remove this connection and delete its accounts and transactions from the ledger?')) return;
  try {
    await api('DELETE', `${F}/connections/${encodeURIComponent(el.dataset.id)}`);
    toast('removed');
    background(renderConnections(el.closest('.pane')));
  } catch (e) { toast(e.message, 'err'); }
});
registerAction('fpl-sandbox', async (el) => {
  try {
    await api('POST', `${F}/connections/plaid/sandbox`, {});
    toast('sandbox bank linked + synced');
    background(renderConnections(el.closest('.pane')));
  } catch (e) { toast(e.message, 'err'); }
});
registerAction('fpl-start', async () => {
  try {
    const r = await api('POST', `${F}/connections/plaid/link/start`, {});
    if (r.hosted_link_url) {
      window.open(r.hosted_link_url, '_blank', 'noopener');
    } else {
      toast('Plaid did not return a hosted link URL', 'err');
    }
  } catch (e) { toast(e.message, 'err'); }
});
registerAction('fpl-complete', async (el) => {
  try {
    const r = await api('POST', `${F}/connections/plaid/link/complete`, {});
    if (r.linked) {
      toast('bank linked + synced');
      background(renderConnections(el.closest('.pane')));
    } else {
      toast('not finished yet — complete the Plaid tab, then retry', 'err');
    }
  } catch (e) { toast(e.message, 'err'); }
});

// ---- tabs -------------------------------------------------------------------
registerTab('finance-dashboard', renderDashboard);
registerTab('finance-accounts', renderAccounts);
registerTab('finance-transactions', renderTransactions);
registerTab('finance-budgets', renderBudgets);
registerTab('finance-recurring', renderRecurring);
registerTab('finance-reports', renderReports);
registerTab('finance-rules', renderRules);
registerTab('finance-connections', renderConnections);

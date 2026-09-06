const { api, esc, toast, registerTab, registerAction } = window.ritsu;
const F = '/admin/api/plugins/finance';

const money = (n, ccy = 'USD') => (n == null ? '—' : `${ccy} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// ---- Accounts tab ---------------------------------------------------------
function accountsSkeleton() {
  return `
    <div class="panel"><h2>Net worth</h2><div id="fin-networth">loading…</div></div>
    <div class="panel"><h2>Accounts</h2><div id="fin-accounts">loading…</div></div>
    <div class="panel"><h2>Connect a bank</h2><div id="fin-connect">loading…</div></div>`;
}

function renderAccountsPane(pane) {
  pane.innerHTML = accountsSkeleton();
  loadStatus();
  loadAccounts();
}

async function loadAccounts() {
  const el = document.getElementById('fin-accounts');
  const nw = document.getElementById('fin-networth');
  if (!el) return;
  try {
    const { accounts, netWorth } = await api('GET', `${F}/accounts`);
    if (nw) {
      const typeRows = netWorth.byType.map(t => `<tr><td>${esc(t.type)}</td><td class="num">${money(t.total, netWorth.currency)}</td><td class="muted">${t.accounts} acct</td></tr>`).join('');
      nw.innerHTML = accounts.length
        ? `<div class="fin-nw"><span class="fin-nw-net">${money(netWorth.net, netWorth.currency)}</span>
             <span class="fin-nw-sub">assets ${money(netWorth.assets, netWorth.currency)} · liabilities ${money(netWorth.liabilities, netWorth.currency)}</span></div>
           <table><tbody>${typeRows}</tbody></table>`
        : '<p class="muted">No accounts yet. Connect a bank below.</p>';
    }
    const acctRows = accounts.map(a => {
      const mask = a.mask ? ` <span class="muted">••${esc(a.mask)}</span>` : '';
      return `<tr><td>${esc(a.name)}${mask}</td><td class="muted">${esc(a.type)}/${esc(a.subtype)}</td><td class="num">${money(a.current_balance, a.iso_currency)}</td></tr>`;
    }).join('');
    el.innerHTML = accounts.length
      ? `<table><thead><tr><th>Account</th><th>Type</th><th class="num">Balance</th></tr></thead><tbody>${acctRows}</tbody></table>`
      : '<p class="muted">No accounts yet.</p>';
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

async function loadStatus() {
  const el = document.getElementById('fin-connect');
  if (!el) return;
  try {
    const s = await api('GET', `${F}/status`);
    if (!s.configured) {
      el.innerHTML = `
        <p class="muted">Enter your Plaid app credentials (start with a free Sandbox app at dashboard.plaid.com). Stored encrypted; never shown to agents.</p>
        <form class="grid" id="fin-config-form">
          <label>client id</label><input id="fin-cid" required />
          <label>secret</label><input id="fin-secret" type="password" required />
          <label>environment</label><select id="fin-env"><option value="sandbox">sandbox</option><option value="production">production</option></select>
          <span></span><div class="form-actions"><button type="submit" class="primary">Save credentials</button></div>
        </form>`;
      el.querySelector('#fin-config-form').addEventListener('submit', saveConfig);
      return;
    }
    const items = s.items.map(i => {
      const err = i.error ? ` — ${esc(i.error)}` : '';
      return `<tr><td>${esc(i.institution_name || i.item_id)}</td><td class="${i.status === 'error' ? 'err' : 'ok'}">${esc(i.status)}${err}</td>
         <td><button data-action="fin-unlink" data-id="${esc(i.item_id)}" class="danger">Unlink</button></td></tr>`;
    }).join('');
    const itemsTable = s.items.length
      ? `<table><thead><tr><th>Institution</th><th>Status</th><th></th></tr></thead><tbody>${items}</tbody></table>`
      : '<p class="muted">No banks linked yet.</p>';
    el.innerHTML = `
      <p class="muted">Plaid: <strong>${esc(s.env)}</strong>. Read-only — Ritsu can never move money.</p>
      ${itemsTable}
      <div class="form-actions" style="margin-top:10px">
        ${s.env === 'sandbox' ? '<button data-action="fin-link-sandbox">Link sandbox bank</button>' : ''}
        <button data-action="fin-link-start">Link a bank (Hosted Link)</button>
        <button data-action="fin-sync" class="primary">Sync now</button>
      </div>
      <div id="fin-link-pending"></div>`;
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

async function saveConfig(e) {
  e.preventDefault();
  try {
    await api('POST', `${F}/config`, {
      client_id: document.getElementById('fin-cid').value.trim(),
      secret: document.getElementById('fin-secret').value.trim(),
      env: document.getElementById('fin-env').value,
    });
    toast('credentials saved', 'ok');
    loadStatus();
  } catch (err) { toast(err.message, 'err'); }
}

async function linkSandbox() {
  try { await api('POST', `${F}/link/sandbox`, {}); toast('sandbox bank linked + synced', 'ok'); loadStatus(); loadAccounts(); }
  catch (e) { toast(e.message, 'err'); }
}

async function linkStart() {
  try {
    const r = await api('POST', `${F}/link/start`, {});
    const pend = document.getElementById('fin-link-pending');
    if (r.hosted_link_url) {
      window.open(r.hosted_link_url, '_blank', 'noopener');
      pend.innerHTML = `<p class="muted">A Plaid tab opened — finish linking there, then:</p><button data-action="fin-link-complete" class="primary">I finished linking</button>`;
    } else {
      pend.innerHTML = '<p class="err">Plaid did not return a hosted link URL.</p>';
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function linkComplete() {
  try {
    const r = await api('POST', `${F}/link/complete`, {});
    if (r.linked) { toast('bank linked + synced', 'ok'); loadStatus(); loadAccounts(); }
    else { toast('not finished yet — complete the Plaid tab, then retry', 'err'); }
  } catch (e) { toast(e.message, 'err'); }
}

async function syncNow() {
  try { await api('POST', `${F}/sync`, {}); toast('synced', 'ok'); loadStatus(); loadAccounts(); }
  catch (e) { toast(e.message, 'err'); }
}

async function unlink(id) {
  if (!confirm('Unlink this institution and delete its cached data?')) return;
  try { await api('DELETE', `${F}/items/${encodeURIComponent(id)}`); toast('unlinked', 'ok'); loadStatus(); loadAccounts(); }
  catch (e) { toast(e.message, 'err'); }
}

// ---- Reporting tab --------------------------------------------------------
function reportingSkeleton() {
  return `
    <div class="panel"><h2>Spending by category <span class="muted" id="fin-rep-window"></span></h2><div id="fin-bycat">loading…</div></div>
    <div class="panel"><h2>By month</h2><div id="fin-bymonth"></div></div>
    <div class="panel"><h2>Top merchants</h2><div id="fin-merchants"></div></div>
    <div class="panel"><h2>Subscriptions</h2><div id="fin-subs"></div></div>
    <div class="panel"><h2>Budgets <span class="muted">(per-category monthly target)</span></h2>
      <div id="fin-budgets"></div>
      <form class="grid" id="fin-target-form" style="margin-top:10px">
        <label>category</label><input id="fin-tgt-cat" required placeholder="e.g. FOOD_AND_DRINK" />
        <label>monthly limit</label><input id="fin-tgt-limit" type="number" min="0" step="1" required />
        <span></span><div class="form-actions"><button type="submit" class="primary">Set target</button></div>
      </form>
    </div>`;
}

function renderReportingPane(pane) {
  pane.innerHTML = reportingSkeleton();
  pane.querySelector('#fin-target-form').addEventListener('submit', addTarget);
  loadReport();
}

function bars(rows, key, label) {
  if (!rows.length) return '<p class="muted">(none)</p>';
  const max = Math.max(...rows.map(r => r[key]));
  const rowsHtml = rows.map(r => `<tr><td>${esc(label(r))}</td>
    <td class="fin-bar-cell"><span class="fin-bar" style="width:${max ? Math.round((r[key] / max) * 100) : 0}%"></span></td>
    <td class="num">${money(r[key])}</td></tr>`).join('');
  return `<table>${rowsHtml}</table>`;
}

async function loadReport() {
  try {
    const r = await api('GET', `${F}/report?days=90`);
    document.getElementById('fin-rep-window').textContent = `(last ${r.days} days)`;
    document.getElementById('fin-bycat').innerHTML = bars(r.byCategory, 'total', x => x.category);
    document.getElementById('fin-bymonth').innerHTML = bars(r.byMonth, 'total', x => x.month);
    document.getElementById('fin-merchants').innerHTML = bars(r.topMerchants, 'total', x => `${x.merchant} (${x.count})`);
    const subRows = r.subscriptions.map(s => `<tr><td>${esc(s.merchant)}</td><td class="muted">${esc(s.cadence)}</td><td class="num">${money(s.avgAmount)}</td></tr>`).join('');
    document.getElementById('fin-subs').innerHTML = r.subscriptions.length
      ? `<table><tbody>${subRows}</tbody></table>`
      : '<p class="muted">(none detected)</p>';
    const budgetRows = r.budgets.map(b => {
      const state = b.over ? `over ${money(-b.remaining)}` : `${money(b.remaining)} left`;
      return `<tr><td>${esc(b.category)}</td>
          <td class="num">${money(b.spent)} / ${money(b.limit)}</td>
          <td class="${b.over ? 'err' : 'ok'}">${state}</td>
          <td><button data-action="fin-del-target" data-cat="${esc(b.category)}">×</button></td></tr>`;
    }).join('');
    document.getElementById('fin-budgets').innerHTML = r.budgets.length
      ? `<table><tbody>${budgetRows}</tbody></table>`
      : '<p class="muted">No targets set. Add one below.</p>';
  } catch (e) {
    document.getElementById('fin-bycat').textContent = `error: ${e.message}`;
  }
}

async function addTarget(e) {
  e.preventDefault();
  try {
    await api('POST', `${F}/targets`, {
      category: document.getElementById('fin-tgt-cat').value.trim(),
      monthly_limit: Number(document.getElementById('fin-tgt-limit').value),
    });
    toast('target set', 'ok');
    loadReport();
  } catch (err) { toast(err.message, 'err'); }
}

async function delTarget(cat) {
  try { await api('DELETE', `${F}/targets/${encodeURIComponent(cat)}`); loadReport(); }
  catch (e) { toast(e.message, 'err'); }
}

registerTab('finance-accounts', renderAccountsPane);
registerTab('finance-reporting', renderReportingPane);
registerAction('fin-link-sandbox', linkSandbox);
registerAction('fin-link-start', linkStart);
registerAction('fin-link-complete', linkComplete);
registerAction('fin-sync', syncNow);
registerAction('fin-unlink', (el) => unlink(el.dataset.id));
registerAction('fin-del-target', (el) => delTarget(el.dataset.cat));

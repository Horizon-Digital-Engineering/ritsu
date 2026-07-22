const { api, esc, toast, registerTab, registerAction } = window.ritsu;
const H = '/admin/api/plugins/health';

const val = (o) => `${o.value}${o.unit ? ` ${esc(o.unit)}` : ''}`;
const today = () => new Date().toISOString().slice(0, 10);
const flagClass = (f) => (f === 'high' || f === 'low' ? 'err' : '');

// ---- Overview -------------------------------------------------------------
function overviewSkeleton() {
  return `
    <div class="panel"><h2>Latest vitals</h2><div id="hl-vitals">loading…</div></div>
    <div class="panel"><h2>Latest labs</h2><div id="hl-labs"></div></div>
    <div class="panel"><h2>Current medications</h2><div id="hl-meds"></div></div>`;
}
function renderOverviewPane(pane) { pane.innerHTML = overviewSkeleton(); loadOverview(); }

async function loadOverview() {
  try {
    const o = await api('GET', `${H}/overview`);
    const vit = document.getElementById('hl-vitals');
    vit.innerHTML = o.vitals.length
      ? `<table><tbody>${o.vitals.map(v => `<tr><td>${esc(v.label)}</td><td class="num">${val(v)}</td><td class="muted">${esc(v.date)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No weight/vitals yet — add some in Log.</p>';
    document.getElementById('hl-labs').innerHTML = o.labs.length
      ? `<table><tbody>${o.labs.map(l => `<tr><td>${esc(l.label)}</td><td class="num ${flagClass(l.flag)}">${val(l)}${l.flag && l.flag !== 'normal' ? ` (${esc(l.flag)})` : ''}</td><td class="muted">${esc(l.date)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No labs yet.</p>';
    document.getElementById('hl-meds').innerHTML = o.medications.length
      ? `<table><tbody>${o.medications.map(m => `<tr><td>${esc(m.name)}</td><td class="muted">${esc(m.dose)} ${esc(m.frequency)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No active medications.</p>';
  } catch (e) { document.getElementById('hl-vitals').textContent = `error: ${e.message}`; }
}

// ---- Log ------------------------------------------------------------------
function logSkeleton() {
  return `
    <div class="panel"><h2>Log a measurement</h2>
      <form class="grid" id="hl-obs-form">
        <label>label</label><input id="hl-o-label" required placeholder="Weight, LDL, BP Systolic…" />
        <label>value</label><input id="hl-o-value" type="number" step="any" required />
        <label>unit</label><input id="hl-o-unit" placeholder="lb, mg/dL…" />
        <label>kind</label><select id="hl-o-kind"><option value="weight">weight</option><option value="lab">lab</option><option value="vital">vital</option><option value="other" selected>other</option></select>
        <label>ref range</label><span class="row"><input id="hl-o-lo" type="number" step="any" placeholder="low" style="width:90px" /> – <input id="hl-o-hi" type="number" step="any" placeholder="high" style="width:90px" /></span>
        <label>date</label><input id="hl-o-date" type="date" />
        <span></span><div class="form-actions"><button type="submit" class="primary">Log</button></div>
      </form></div>
    <div class="panel"><h2>Add a medication</h2>
      <form class="grid" id="hl-med-form">
        <label>name</label><input id="hl-m-name" required />
        <label>dose</label><input id="hl-m-dose" placeholder="20 mg" />
        <label>frequency</label><input id="hl-m-freq" placeholder="once daily" />
        <span></span><div class="form-actions"><button type="submit" class="primary">Add</button></div>
      </form></div>
    <div class="panel"><h2>Recent measurements</h2><div id="hl-recent">loading…</div></div>
    <div class="panel"><h2>Medications</h2><div id="hl-medlist"></div></div>`;
}
function renderLogPane(pane) {
  pane.innerHTML = logSkeleton();
  pane.querySelector('#hl-o-date').value = today();
  pane.querySelector('#hl-obs-form').addEventListener('submit', saveObs);
  pane.querySelector('#hl-med-form').addEventListener('submit', saveMed);
  loadRecent();
  loadMeds();
}

async function saveObs(e) {
  e.preventDefault();
  const num = (id) => { const v = document.getElementById(id).value; return v === '' ? undefined : Number(v); };
  try {
    await api('POST', `${H}/observations`, {
      label: document.getElementById('hl-o-label').value.trim(),
      value: Number(document.getElementById('hl-o-value').value),
      unit: document.getElementById('hl-o-unit').value.trim() || undefined,
      kind: document.getElementById('hl-o-kind').value,
      ref_low: num('hl-o-lo'), ref_high: num('hl-o-hi'),
      date: document.getElementById('hl-o-date').value || today(),
    });
    toast('logged', 'ok');
    document.getElementById('hl-obs-form').reset();
    document.getElementById('hl-o-date').value = today();
    loadRecent();
  } catch (err) { toast(err.message, 'err'); }
}

async function saveMed(e) {
  e.preventDefault();
  try {
    await api('POST', `${H}/medications`, {
      name: document.getElementById('hl-m-name').value.trim(),
      dose: document.getElementById('hl-m-dose').value.trim() || undefined,
      frequency: document.getElementById('hl-m-freq').value.trim() || undefined,
      start_date: today(),
    });
    toast('added', 'ok');
    document.getElementById('hl-med-form').reset();
    loadMeds();
  } catch (err) { toast(err.message, 'err'); }
}

async function loadRecent() {
  const el = document.getElementById('hl-recent'); if (!el) return;
  try {
    const { observations } = await api('GET', `${H}/observations?limit=40`);
    el.innerHTML = observations.length
      ? `<table><tbody>${observations.map(o => `<tr><td class="muted">${esc(o.date)}</td><td>${esc(o.label)}</td><td class="num ${flagClass(o.flag)}">${val(o)}</td><td><button data-action="hl-del-obs" data-id="${o.id}">×</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">Nothing logged yet.</p>';
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

async function loadMeds() {
  const el = document.getElementById('hl-medlist'); if (!el) return;
  try {
    const { medications } = await api('GET', `${H}/medications`);
    el.innerHTML = medications.length
      ? `<table><tbody>${medications.map(m => `<tr><td>${esc(m.name)}</td><td class="muted">${esc(m.dose)} ${esc(m.frequency)}</td>
          <td class="${m.active ? 'ok' : 'muted'}">${m.active ? 'active' : `stopped ${esc(m.end_date || '')}`}</td>
          <td>${m.active ? `<button data-action="hl-stop-med" data-id="${m.id}">stop</button> ` : ''}<button data-action="hl-del-med" data-id="${m.id}" class="danger">×</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No medications.</p>';
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

// ---- Trends ---------------------------------------------------------------
function trendsSkeleton() {
  return `
    <div class="panel"><h2>Trend</h2>
      <div class="row"><label>measurement&nbsp;</label><select id="hl-series-sel"></select></div>
      <div id="hl-series" style="margin-top:10px"></div>
    </div>
    <div class="panel"><h2>Correlate two measurements</h2>
      <div class="row"><select id="hl-corr-a"></select> &nbsp;vs&nbsp; <select id="hl-corr-b"></select>
        <button data-action="hl-correlate">Compare</button></div>
      <div id="hl-corr" style="margin-top:10px"></div>
    </div>`;
}
function renderTrendsPane(pane) { pane.innerHTML = trendsSkeleton(); loadLabels(); }

let labelCache = [];
async function loadLabels() {
  try {
    const { labels } = await api('GET', `${H}/labels`);
    labelCache = labels;
    const opts = labels.map(l => `<option value="${esc(l.label)}">${esc(l.label)} (${l.count})</option>`).join('');
    const sel = document.getElementById('hl-series-sel');
    const a = document.getElementById('hl-corr-a');
    const b = document.getElementById('hl-corr-b');
    if (!labels.length) { sel.innerHTML = '<option>— no data yet —</option>'; return; }
    sel.innerHTML = opts; a.innerHTML = opts; b.innerHTML = opts;
    if (labels.length > 1) b.selectedIndex = 1;
    sel.addEventListener('change', () => loadSeries(sel.value));
    loadSeries(sel.value);
  } catch (e) { toast(e.message, 'err'); }
}

async function loadSeries(label) {
  const el = document.getElementById('hl-series'); if (!el || !label) return;
  try {
    const { series, trend } = await api('GET', `${H}/series?label=${encodeURIComponent(label)}`);
    if (!series.length) { el.innerHTML = '<p class="muted">(no points)</p>'; return; }
    const max = Math.max(...series.map(s => s.value));
    const min = Math.min(...series.map(s => s.value));
    const span = max - min || 1;
    const dir = trend.change > 0 ? '▲' : trend.change < 0 ? '▼' : '→';
    el.innerHTML = `
      <p><strong>${esc(trend.label)}</strong>: ${trend.first.value} → ${trend.last.value} ${dir} ${trend.change != null ? trend.change.toFixed(1) : ''}${trend.pctChange != null ? ` (${trend.pctChange.toFixed(1)}%)` : ''}
        <span class="muted">· min ${trend.min} · max ${trend.max} · avg ${trend.avg.toFixed(1)}</span></p>
      <table>${series.map(s => `<tr><td class="muted">${esc(s.date)}</td>
        <td class="fin-bar-cell"><span class="fin-bar" style="width:${Math.round(((s.value - min) / span) * 100)}%"></span></td>
        <td class="num ${flagClass(s.flag)}">${val(s)}</td></tr>`).join('')}</table>`;
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

async function correlate() {
  const a = document.getElementById('hl-corr-a').value;
  const b = document.getElementById('hl-corr-b').value;
  const el = document.getElementById('hl-corr');
  try {
    const r = await api('GET', `${H}/correlate?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    const c = r.correlation;
    if (c.r == null) { el.innerHTML = `<p class="muted">Not enough overlapping data (${c.n} paired points).</p>`; return; }
    const strength = Math.abs(c.r) > 0.7 ? 'strong' : Math.abs(c.r) > 0.4 ? 'moderate' : 'weak';
    el.innerHTML = `<p><strong>r = ${c.r.toFixed(2)}</strong> — ${strength} ${c.r < 0 ? 'inverse' : 'positive'} (${c.n} paired points)</p><p class="muted">Correlation ≠ causation.</p>`;
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

// ---- actions --------------------------------------------------------------
async function delObs(id) { try { await api('DELETE', `${H}/observations/${id}`); loadRecent(); } catch (e) { toast(e.message, 'err'); } }
async function stopMed(id) { const d = prompt('Stop date (YYYY-MM-DD):', today()); if (!d) return; try { await api('POST', `${H}/medications/${id}/stop`, { end_date: d }); loadMeds(); } catch (e) { toast(e.message, 'err'); } }
async function delMed(id) { if (!confirm('Delete this medication record?')) return; try { await api('DELETE', `${H}/medications/${id}`); loadMeds(); } catch (e) { toast(e.message, 'err'); } }

registerTab('health-overview', renderOverviewPane);
registerTab('health-log', renderLogPane);
registerTab('health-trends', renderTrendsPane);
registerAction('hl-del-obs', (el) => delObs(Number(el.dataset.id)));
registerAction('hl-stop-med', (el) => stopMed(Number(el.dataset.id)));
registerAction('hl-del-med', (el) => delMed(Number(el.dataset.id)));
registerAction('hl-correlate', correlate);

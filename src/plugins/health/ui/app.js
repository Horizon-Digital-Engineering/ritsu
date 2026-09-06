const { api, esc, toast, registerTab, registerAction } = window.ritsu;
const H = '/admin/api/plugins/health';

const val = (o) => {
  const unit = o.unit ? ` ${esc(o.unit)}` : '';
  return `${o.value}${unit}`;
};
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
    const vitalRows = o.vitals.map(v => `<tr><td>${esc(v.label)}</td><td class="num">${val(v)}</td><td class="muted">${esc(v.date)}</td></tr>`).join('');
    vit.innerHTML = o.vitals.length
      ? `<table><tbody>${vitalRows}</tbody></table>`
      : '<p class="muted">No weight/vitals yet — add some in Log.</p>';
    const labRows = o.labs.map(l => {
      const flag = l.flag && l.flag !== 'normal' ? ` (${esc(l.flag)})` : '';
      return `<tr><td>${esc(l.label)}</td><td class="num ${flagClass(l.flag)}">${val(l)}${flag}</td><td class="muted">${esc(l.date)}</td></tr>`;
    }).join('');
    document.getElementById('hl-labs').innerHTML = o.labs.length
      ? `<table><tbody>${labRows}</tbody></table>`
      : '<p class="muted">No labs yet.</p>';
    const medRows = o.medications.map(m => `<tr><td>${esc(m.name)}</td><td class="muted">${esc(m.dose)} ${esc(m.frequency)}</td></tr>`).join('');
    document.getElementById('hl-meds').innerHTML = o.medications.length
      ? `<table><tbody>${medRows}</tbody></table>`
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
    const obsRows = observations.map(o => `<tr><td class="muted">${esc(o.date)}</td><td>${esc(o.label)}</td><td class="num ${flagClass(o.flag)}">${val(o)}</td><td><button data-action="hl-del-obs" data-id="${o.id}">×</button></td></tr>`).join('');
    el.innerHTML = observations.length
      ? `<table><tbody>${obsRows}</tbody></table>`
      : '<p class="muted">Nothing logged yet.</p>';
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

async function loadMeds() {
  const el = document.getElementById('hl-medlist'); if (!el) return;
  try {
    const { medications } = await api('GET', `${H}/medications`);
    const medRows = medications.map(m => {
      const state = m.active ? 'active' : `stopped ${esc(m.end_date || '')}`;
      const stopBtn = m.active ? `<button data-action="hl-stop-med" data-id="${m.id}">stop</button> ` : '';
      return `<tr><td>${esc(m.name)}</td><td class="muted">${esc(m.dose)} ${esc(m.frequency)}</td>
          <td class="${m.active ? 'ok' : 'muted'}">${state}</td>
          <td>${stopBtn}<button data-action="hl-del-med" data-id="${m.id}" class="danger">×</button></td></tr>`;
    }).join('');
    el.innerHTML = medications.length
      ? `<table><tbody>${medRows}</tbody></table>`
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
    let dir = '→';
    if (trend.change > 0) dir = '▲';
    else if (trend.change < 0) dir = '▼';
    const pct = trend.pctChange != null ? ` (${trend.pctChange.toFixed(1)}%)` : '';
    const seriesRows = series.map(s => `<tr><td class="muted">${esc(s.date)}</td>
        <td class="fin-bar-cell"><span class="fin-bar" style="width:${Math.round(((s.value - min) / span) * 100)}%"></span></td>
        <td class="num ${flagClass(s.flag)}">${val(s)}</td></tr>`).join('');
    el.innerHTML = `
      <p><strong>${esc(trend.label)}</strong>: ${trend.first.value} → ${trend.last.value} ${dir} ${trend.change != null ? trend.change.toFixed(1) : ''}${pct}
        <span class="muted">· min ${trend.min} · max ${trend.max} · avg ${trend.avg.toFixed(1)}</span></p>
      <table>${seriesRows}</table>`;
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
    let strength = 'weak';
    if (Math.abs(c.r) > 0.7) strength = 'strong';
    else if (Math.abs(c.r) > 0.4) strength = 'moderate';
    el.innerHTML = `<p><strong>r = ${c.r.toFixed(2)}</strong> — ${strength} ${c.r < 0 ? 'inverse' : 'positive'} (${c.n} paired points)</p><p class="muted">Correlation ≠ causation.</p>`;
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

// ---- actions --------------------------------------------------------------
async function delObs(id) { try { await api('DELETE', `${H}/observations/${id}`); loadRecent(); } catch (e) { toast(e.message, 'err'); } }
async function stopMed(id) { const d = prompt('Stop date (YYYY-MM-DD):', today()); if (!d) { return; } try { await api('POST', `${H}/medications/${id}/stop`, { end_date: d }); loadMeds(); } catch (e) { toast(e.message, 'err'); } }
async function delMed(id) { if (!confirm('Delete this medication record?')) { return; } try { await api('DELETE', `${H}/medications/${id}`); loadMeds(); } catch (e) { toast(e.message, 'err'); } }

// ---- Insurance ------------------------------------------------------------
const COST_TYPES = ['copay', 'coinsurance', 'covered', 'not_covered'];
function benefitCost(b) {
  const after = b.after_deductible ? ' after deductible' : '';
  if (b.cost_type === 'copay') return `$${b.amount} copay${after}`;
  if (b.cost_type === 'coinsurance') return `${b.amount}% coinsurance${after}`;
  if (b.cost_type === 'covered') return 'covered in full';
  return 'NOT covered';
}
function bar(met, total) {
  if (total == null || total <= 0) return '';
  const pct = Math.min(100, Math.round((met / total) * 100));
  return `<span class="fin-bar-cell" style="display:inline-block;width:160px"><span class="fin-bar" style="width:${pct}%"></span></span> ${pct}%`;
}

function insuranceSkeleton() {
  const costTypeOpts = COST_TYPES.map(t => `<option>${t}</option>`).join('');
  return `
    <div class="panel"><h2>Active plan</h2><div id="hl-ins-active">loading…</div></div>
    <div class="panel"><h2>Coverage</h2><div id="hl-ins-benefits"></div>
      <form class="grid" id="hl-benefit-form" style="margin-top:10px">
        <label>service</label><input id="hl-b-cat" required placeholder="Specialist, ER, Generic Rx…" />
        <label>cost type</label><select id="hl-b-type">${costTypeOpts}</select>
        <label>amount</label><input id="hl-b-amt" type="number" step="any" placeholder="$ copay or % coinsurance" />
        <label>network</label><select id="hl-b-net"><option value="in">in-network</option><option value="out">out-of-network</option></select>
        <label>after deductible</label><input id="hl-b-after" type="checkbox" />
        <span></span><div class="form-actions"><button type="submit" class="primary">Add coverage</button></div>
      </form></div>
    <div class="panel"><h2>Add / replace plan</h2>
      <form class="grid" id="hl-plan-form">
        <label>year</label><input id="hl-p-year" type="number" required value="${new Date().getFullYear()}" />
        <label>carrier</label><input id="hl-p-carrier" required placeholder="Blue Cross…" />
        <label>plan name</label><input id="hl-p-name" required placeholder="PPO 3000" />
        <label>plan type</label><input id="hl-p-type" placeholder="PPO / HMO / HDHP" />
        <label>deductible</label><input id="hl-p-ded" type="number" step="any" placeholder="individual $" />
        <label>out-of-pocket max</label><input id="hl-p-oop" type="number" step="any" placeholder="individual $" />
        <label>premium / mo</label><input id="hl-p-prem" type="number" step="any" />
        <span></span><div class="form-actions"><button type="submit" class="primary">Save plan</button></div>
      </form></div>
    <div class="panel"><h2>Benefits documents <span class="muted">(dump the raw doc; the assistant quotes it)</span></h2>
      <div id="hl-docs"></div>
      <form class="grid" id="hl-doc-form" style="margin-top:10px">
        <label>title</label><input id="hl-d-title" required placeholder="2026 SBC — PPO 3000" />
        <label>text</label><textarea id="hl-d-text" required placeholder="paste the benefits / SBC text here"></textarea>
        <span></span><div class="form-actions"><button type="submit" class="primary">Dump document</button></div>
      </form>
      <div class="row" style="margin-top:10px"><input id="hl-d-q" placeholder="search dumped docs (e.g. acupuncture)" style="flex:1" />
        <button data-action="hl-doc-search">Search</button></div>
      <div id="hl-doc-hits"></div>
    </div>`;
}

function renderInsurancePane(pane) {
  pane.innerHTML = insuranceSkeleton();
  pane.querySelector('#hl-benefit-form').addEventListener('submit', addBenefit);
  pane.querySelector('#hl-plan-form').addEventListener('submit', savePlan);
  pane.querySelector('#hl-doc-form').addEventListener('submit', dumpDoc);
  loadInsurance();
  loadDocs();
}

async function loadInsurance() {
  try {
    const { active, benefits } = await api('GET', `${H}/insurance`);
    const el = document.getElementById('hl-ins-active');
    if (!active) { el.innerHTML = '<p class="muted">No plan yet — add one below.</p>'; document.getElementById('hl-ins-benefits').innerHTML = ''; return; }
    const premiumRow = active.premium_monthly != null ? `<tr><td>premium</td><td class="num">$${active.premium_monthly}/mo</td><td></td></tr>` : '';
    el.innerHTML = `
      <p><strong>${esc(active.carrier)} ${esc(active.plan_name)}</strong> <span class="muted">${esc(active.plan_type)} · ${active.plan_year}</span></p>
      <table><tbody>
        <tr><td>deductible</td><td class="num">$${active.deductible_met} / ${active.deductible_individual ?? '—'}</td><td>${bar(active.deductible_met, active.deductible_individual)}</td></tr>
        <tr><td>out-of-pocket</td><td class="num">$${active.oop_met} / ${active.oop_max_individual ?? '—'}</td><td>${bar(active.oop_met, active.oop_max_individual)}</td></tr>
        ${premiumRow}
      </tbody></table>
      <div class="row" style="margin-top:8px"><span class="muted">update used:</span>
        <input id="hl-ded-met" type="number" step="any" placeholder="deductible met" style="width:130px" value="${active.deductible_met}" />
        <input id="hl-oop-met" type="number" step="any" placeholder="OOP met" style="width:110px" value="${active.oop_met}" />
        <button data-action="hl-ins-progress" data-id="${active.id}">Update</button>
        <button data-action="hl-ins-del-plan" data-id="${active.id}" class="danger">Delete plan</button></div>`;
    const benefitRows = benefits.map(b =>
      `<tr><td>${esc(b.category)}</td><td class="muted">${b.network === 'in' ? 'in' : 'out'}</td><td>${esc(benefitCost(b))}</td>
         <td><button data-action="hl-ins-del-benefit" data-id="${b.id}">×</button></td></tr>`).join('');
    document.getElementById('hl-ins-benefits').innerHTML = benefits.length
      ? `<table><thead><tr><th>Service</th><th>Network</th><th>Your cost</th><th></th></tr></thead><tbody>${benefitRows}</tbody></table>`
      : '<p class="muted">No coverage lines yet. Add the common ones (PCP, Specialist, ER, Rx) or dump the SBC below.</p>';
  } catch (e) { document.getElementById('hl-ins-active').textContent = `error: ${e.message}`; }
}

async function savePlan(e) {
  e.preventDefault();
  const num = (id) => { const v = document.getElementById(id).value; return v === '' ? undefined : Number(v); };
  try {
    await api('POST', `${H}/insurance/plans`, {
      plan_year: Number(document.getElementById('hl-p-year').value),
      carrier: document.getElementById('hl-p-carrier').value.trim(),
      plan_name: document.getElementById('hl-p-name').value.trim(),
      plan_type: document.getElementById('hl-p-type').value.trim() || undefined,
      deductible_individual: num('hl-p-ded'), oop_max_individual: num('hl-p-oop'), premium_monthly: num('hl-p-prem'),
    });
    toast('plan saved', 'ok'); document.getElementById('hl-plan-form').reset(); loadInsurance();
  } catch (err) { toast(err.message, 'err'); }
}

async function addBenefit(e) {
  e.preventDefault();
  try {
    const { active } = await api('GET', `${H}/insurance`);
    if (!active) { toast('add a plan first', 'err'); return; }
    const amt = document.getElementById('hl-b-amt').value;
    await api('POST', `${H}/insurance/benefits`, {
      plan_id: active.id, category: document.getElementById('hl-b-cat').value.trim(),
      cost_type: document.getElementById('hl-b-type').value, amount: amt === '' ? undefined : Number(amt),
      network: document.getElementById('hl-b-net').value, after_deductible: document.getElementById('hl-b-after').checked,
    });
    toast('coverage added', 'ok'); document.getElementById('hl-benefit-form').reset(); loadInsurance();
  } catch (err) { toast(err.message, 'err'); }
}

async function updateProgress(id) {
  try {
    await api('POST', `${H}/insurance/plans/${id}/progress`, {
      deductible_met: Number(document.getElementById('hl-ded-met').value || 0),
      oop_met: Number(document.getElementById('hl-oop-met').value || 0),
    });
    toast('updated', 'ok'); loadInsurance();
  } catch (e) { toast(e.message, 'err'); }
}

async function delPlan(id) { if (!confirm('Delete this plan and its coverage lines?')) { return; } try { await api('DELETE', `${H}/insurance/plans/${id}`); loadInsurance(); } catch (e) { toast(e.message, 'err'); } }
async function delBenefit(id) { try { await api('DELETE', `${H}/insurance/benefits/${id}`); loadInsurance(); } catch (e) { toast(e.message, 'err'); } }

async function loadDocs() {
  const el = document.getElementById('hl-docs'); if (!el) return;
  try {
    const { documents } = await api('GET', `${H}/documents`);
    const docRows = documents.map(d => `<tr><td>${esc(d.title)}</td><td class="muted">${esc(d.category)} · ${d.chars} chars</td><td><button data-action="hl-doc-del" data-id="${d.id}" class="danger">×</button></td></tr>`).join('');
    el.innerHTML = documents.length
      ? `<table><tbody>${docRows}</tbody></table>`
      : '<p class="muted">No documents dumped yet.</p>';
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

async function dumpDoc(e) {
  e.preventDefault();
  try {
    await api('POST', `${H}/documents`, { category: 'benefits', title: document.getElementById('hl-d-title').value.trim(), text: document.getElementById('hl-d-text').value });
    toast('document stored', 'ok'); document.getElementById('hl-doc-form').reset(); loadDocs();
  } catch (err) { toast(err.message, 'err'); }
}

async function docSearch() {
  const q = document.getElementById('hl-d-q').value.trim();
  const el = document.getElementById('hl-doc-hits');
  if (!q) { el.innerHTML = ''; return; }
  try {
    const { hits } = await api('GET', `${H}/documents/search?q=${encodeURIComponent(q)}`);
    el.innerHTML = hits.length ? hits.map(h => `<div class="doc-hit"><span class="muted">[${esc(h.title)}]</span> ${esc(h.snippet)}</div>`).join('') : '<p class="muted">(no matches)</p>';
  } catch (e) { el.textContent = `error: ${e.message}`; }
}
async function delDoc(id) { try { await api('DELETE', `${H}/documents/${id}`); loadDocs(); } catch (e) { toast(e.message, 'err'); } }

registerTab('health-overview', renderOverviewPane);
registerTab('health-log', renderLogPane);
registerTab('health-trends', renderTrendsPane);
registerTab('health-insurance', renderInsurancePane);
registerAction('hl-del-obs', (el) => delObs(Number(el.dataset.id)));
registerAction('hl-stop-med', (el) => stopMed(Number(el.dataset.id)));
registerAction('hl-del-med', (el) => delMed(Number(el.dataset.id)));
registerAction('hl-correlate', correlate);
registerAction('hl-ins-progress', (el) => updateProgress(Number(el.dataset.id)));
registerAction('hl-ins-del-plan', (el) => delPlan(Number(el.dataset.id)));
registerAction('hl-ins-del-benefit', (el) => delBenefit(Number(el.dataset.id)));
registerAction('hl-doc-search', docSearch);
registerAction('hl-doc-del', (el) => delDoc(Number(el.dataset.id)));

// ---- Import (ingestion) ---------------------------------------------------
function importSkeleton() {
  return `
    <div class="panel"><h2>Import a document</h2>
      <p class="muted">Paste text or upload a photo (lab report, SBC/benefits). It's read into structured data you review before it's saved.</p>
      <form class="grid" id="hl-ingest-form">
        <label>type</label><select id="hl-i-type"></select>
        <label>title</label><input id="hl-i-title" required placeholder="e.g. Quest labs 2026-07 or 2026 SBC" />
        <label>paste text</label><textarea id="hl-i-text" placeholder="paste the document text… or choose an image below"></textarea>
        <label>or image</label><input id="hl-i-file" type="file" accept="image/*" />
        <span></span><div class="form-actions"><button type="submit" class="primary">Extract</button></div>
      </form>
      <div id="hl-ingest-review"></div>
    </div>
    <div class="panel"><h2>Recent imports</h2><div id="hl-ingest-list">loading…</div></div>`;
}
function renderImportPane(pane) {
  pane.innerHTML = importSkeleton();
  pane.querySelector('#hl-ingest-form').addEventListener('submit', submitIngest);
  loadIngestTypes();
  loadIngestList();
}
async function loadIngestTypes() {
  try {
    const { types } = await api('GET', `${H}/ingest/types`);
    document.getElementById('hl-i-type').innerHTML = types.map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
  } catch (e) { toast(e.message, 'err'); }
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(file); });
}
async function submitIngest(e) {
  e.preventDefault();
  const body = { doc_type: document.getElementById('hl-i-type').value, title: document.getElementById('hl-i-title').value.trim() };
  const text = document.getElementById('hl-i-text').value.trim();
  const file = document.getElementById('hl-i-file').files[0];
  if (file) { body.image = await fileToBase64(file); body.media_type = file.type; }
  else if (text) { body.text = text; }
  else { toast('paste text or choose an image', 'err'); return; }
  const review = document.getElementById('hl-ingest-review');
  review.innerHTML = '<p class="muted">extracting… (a vision read can take a few seconds)</p>';
  try { renderReview(await api('POST', `${H}/ingest`, body)); loadIngestList(); }
  catch (err) { review.innerHTML = ''; toast(err.message, 'err'); }
}
function renderReview(rec) {
  const review = document.getElementById('hl-ingest-review');
  if (rec.status === 'error') { review.innerHTML = `<p class="err">Extraction failed: ${esc(rec.error || '')}</p>`; return; }
  review.innerHTML = `
    <div class="test-pane" style="margin-top:12px"><h3>Review extraction #${rec.id}</h3>
      <p class="muted">Fix anything the model misread, then commit.</p>
      <textarea id="hl-i-extracted" style="min-height:200px;font-family:ui-monospace,monospace">${esc(rec.extracted || '')}</textarea>
      <div class="form-actions" style="margin-top:8px">
        <button data-action="hl-ingest-confirm" data-id="${rec.id}" class="primary">Commit</button>
        <button data-action="hl-ingest-reject" data-id="${rec.id}" class="danger">Discard</button>
      </div></div>`;
}
async function confirmIngest(id) {
  const ta = document.getElementById('hl-i-extracted');
  let data;
  try { data = ta ? JSON.parse(ta.value) : undefined; } catch { toast('the extracted JSON is invalid — fix it first', 'err'); return; }
  try { await api('POST', `${H}/ingest/${id}/confirm`, { data }); toast('committed', 'ok'); document.getElementById('hl-ingest-review').innerHTML = ''; loadIngestList(); }
  catch (e) { toast(e.message, 'err'); }
}
async function rejectIngest(id) {
  try { await api('POST', `${H}/ingest/${id}/reject`, {}); document.getElementById('hl-ingest-review').innerHTML = ''; loadIngestList(); }
  catch (e) { toast(e.message, 'err'); }
}
async function openIngest(id) { try { renderReview(await api('GET', `${H}/ingest/${id}`)); } catch (e) { toast(e.message, 'err'); } }
async function delIngest(id) { try { await api('DELETE', `${H}/ingest/${id}`); loadIngestList(); } catch (e) { toast(e.message, 'err'); } }
async function loadIngestList() {
  const el = document.getElementById('hl-ingest-list'); if (!el) return;
  try {
    const { ingestions } = await api('GET', `${H}/ingest`);
    const ingestRows = ingestions.map(i => {
      let statusClass = '';
      if (i.status === 'error') statusClass = 'err';
      else if (i.status === 'committed') statusClass = 'ok';
      const reviewBtn = i.status === 'pending' ? `<button data-action="hl-ingest-open" data-id="${i.id}">review</button> ` : '';
      return `<tr>
          <td class="muted">${i.created_at ? new Date(i.created_at * 1000).toISOString().slice(0, 10) : ''}</td>
          <td>${esc(i.title)}</td><td class="muted">${esc(i.doc_type)}</td>
          <td class="${statusClass}">${esc(i.status)}</td>
          <td>${reviewBtn}<button data-action="hl-ingest-del" data-id="${i.id}" class="danger">×</button></td>
        </tr>`;
    }).join('');
    el.innerHTML = ingestions.length
      ? `<table><tbody>${ingestRows}</tbody></table>`
      : '<p class="muted">No imports yet.</p>';
  } catch (e) { el.textContent = `error: ${e.message}`; }
}

registerTab('health-import', renderImportPane);
registerAction('hl-ingest-confirm', (el) => confirmIngest(Number(el.dataset.id)));
registerAction('hl-ingest-reject', (el) => rejectIngest(Number(el.dataset.id)));
registerAction('hl-ingest-open', (el) => openIngest(Number(el.dataset.id)));
registerAction('hl-ingest-del', (el) => delIngest(Number(el.dataset.id)));

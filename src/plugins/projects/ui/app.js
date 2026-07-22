const { api, esc, toast, registerTab, registerAction, registerChange } = window.ritsu;
const P = '/admin/api/plugins/projects';
const TASK_STATUSES = ['backlog', 'doing', 'done', 'blocked'];
const STATUS_VIEW_ORDER = ['doing', 'blocked', 'backlog', 'done'];

let projectCache = [];
let editingProjectId = null;
let taskCache = [];
let taskProjectCache = [];
let backlogView = 'project';

function projectsSkeleton() {
  return `
    <div class="panel">
      <h2>Projects</h2>
      <p>The projects you and your agents work on. Each points at a working directory on this host. Configured here at runtime.</p>
      <div id="pj-list">loading…</div>
    </div>
    <div class="panel">
      <h2 id="pj-form-title">Add a project</h2>
      <form class="grid" id="pj-form">
        <label for="pj-id">id</label>
        <input id="pj-id" required placeholder="my-project" pattern="[a-z0-9][a-z0-9-]*" title="lowercase kebab-case" />
        <label for="pj-name">name</label>
        <input id="pj-name" required placeholder="My Project" />
        <label for="pj-dir">working dir</label>
        <input id="pj-dir" placeholder="/path/on/this/host" />
        <label for="pj-desc">description</label>
        <input id="pj-desc" placeholder="what this project is" />
        <label for="pj-enabled">enabled</label>
        <input id="pj-enabled" type="checkbox" checked />
        <span></span>
        <div class="form-actions">
          <button type="button" data-action="pj-clear">Clear</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </form>
    </div>`;
}

function renderProjectsPane(pane) {
  pane.innerHTML = projectsSkeleton();
  pane.querySelector('#pj-form').addEventListener('submit', (e) => { e.preventDefault(); saveProject(); });
  loadProjects();
}

async function loadProjects() {
  try {
    const { projects } = await api('GET', `${P}/projects`);
    projectCache = projects;
    renderProjects(projects);
  } catch (e) { toast(e.message, 'err'); }
}

function renderProjects(projects) {
  const target = document.getElementById('pj-list');
  if (!target) return;
  if (!projects.length) { target.innerHTML = '<em class="txt-muted">No projects yet. Add one below.</em>'; return; }
  const rows = projects.map(p => `
    <tr class="${p.enabled ? '' : 'disabled'}">
      <td class="id-cell">${esc(p.name)}</td>
      <td><code>${esc(p.id)}</code></td>
      <td>${p.working_dir ? `<code>${esc(p.working_dir)}</code>` : '<em class="txt-muted">—</em>'}</td>
      <td>${p.description ? esc(p.description) : '<em class="txt-muted">—</em>'}</td>
      <td>${p.enabled ? 'enabled' : 'disabled'}</td>
      <td class="row-actions">
        <button data-action="pj-edit" data-id="${esc(p.id)}">edit</button>
        <button class="danger" data-action="pj-delete" data-id="${esc(p.id)}" data-name="${esc(p.name)}">delete</button>
      </td>
    </tr>`).join('');
  target.innerHTML = `<table><thead><tr><th>name</th><th>id</th><th>working dir</th><th>description</th><th>state</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function editProject(id) {
  const p = projectCache.find(x => x.id === id);
  if (!p) return;
  editingProjectId = p.id;
  document.getElementById('pj-id').value = p.id;
  document.getElementById('pj-id').disabled = true;
  document.getElementById('pj-name').value = p.name;
  document.getElementById('pj-dir').value = p.working_dir;
  document.getElementById('pj-desc').value = p.description;
  document.getElementById('pj-enabled').checked = p.enabled;
  document.getElementById('pj-form-title').textContent = `Edit ${p.name}`;
}

function clearProjectForm() {
  editingProjectId = null;
  document.getElementById('pj-id').value = '';
  document.getElementById('pj-id').disabled = false;
  document.getElementById('pj-name').value = '';
  document.getElementById('pj-dir').value = '';
  document.getElementById('pj-desc').value = '';
  document.getElementById('pj-enabled').checked = true;
  document.getElementById('pj-form-title').textContent = 'Add a project';
}

async function saveProject() {
  const id = document.getElementById('pj-id').value.trim();
  const name = document.getElementById('pj-name').value.trim();
  if (!id || !name) { toast('id and name are required', 'err'); return; }
  const body = {
    id, name,
    working_dir: document.getElementById('pj-dir').value.trim(),
    description: document.getElementById('pj-desc').value.trim(),
    enabled: document.getElementById('pj-enabled').checked,
  };
  try { await api('POST', `${P}/projects`, body); clearProjectForm(); loadProjects(); }
  catch (e) { toast(e.message, 'err'); }
}

async function deleteProject(id, name) {
  if (!confirm(`Delete project "${name}"? This removes it from ritsu; your files on disk are untouched.`)) return;
  try {
    await api('DELETE', `${P}/projects/${encodeURIComponent(id)}`);
    if (editingProjectId === id) clearProjectForm();
    loadProjects();
  } catch (e) { toast(e.message, 'err'); }
}

function backlogSkeleton() {
  return `
    <div class="panel">
      <h2>Backlog</h2>
      <p>Every task across all projects. Group by project for each project's backlog, or by status to see what's in flight.</p>
      <form class="backlog-add" id="pj-task-form">
        <select id="pj-task-project" title="project"></select>
        <input id="pj-task-title" placeholder="new task…" required />
        <select id="pj-task-status" title="status">
          ${TASK_STATUSES.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
        <button type="submit" class="primary">Add</button>
      </form>
      <div class="conv-kind-tabs" id="pj-backlog-views">
        <button type="button" class="conv-kind-tab active" data-action="pj-view" data-view="project">By project</button>
        <button type="button" class="conv-kind-tab" data-action="pj-view" data-view="status">By status</button>
      </div>
      <div id="pj-backlog-list">loading…</div>
    </div>`;
}

function renderBacklogPane(pane) {
  pane.innerHTML = backlogSkeleton();
  pane.querySelector('#pj-task-form').addEventListener('submit', (e) => { e.preventDefault(); addTask(); });
  loadBacklog();
}

async function loadBacklog() {
  try {
    const [t, p] = await Promise.all([api('GET', `${P}/tasks`), api('GET', `${P}/projects`)]);
    taskCache = t.tasks;
    taskProjectCache = p.projects;
    populateTaskProjectSelect();
    renderBacklog();
  } catch (e) { toast(e.message, 'err'); }
}

function taskProjectName(id) {
  const p = taskProjectCache.find(x => x.id === id);
  return p ? p.name : id;
}

function populateTaskProjectSelect() {
  const sel = document.getElementById('pj-task-project');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = taskProjectCache.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (cur && taskProjectCache.some(p => p.id === cur)) sel.value = cur;
}

function setBacklogView(v) {
  backlogView = v;
  document.querySelectorAll('#pj-backlog-views [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  renderBacklog();
}

function statusSelect(t) {
  return `<select data-change="pj-task-status" data-id="${t.id}" class="task-status-sel status-${t.status}">${
    TASK_STATUSES.map(s => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')
  }</select>`;
}

function taskRow(t, showProject) {
  const proj = showProject ? `<span class="task-proj">${esc(taskProjectName(t.project_id))}</span>` : '';
  const detail = t.detail ? `<span class="task-detail">${esc(t.detail)}</span>` : '';
  return `<div class="task-row status-${t.status}">
    <span class="task-main">${proj}<span class="task-title">${esc(t.title)}</span>${detail}</span>
    <span class="task-actions">${statusSelect(t)}<button class="danger task-del" data-action="pj-delete-task" data-id="${t.id}" title="delete">✕</button></span>
  </div>`;
}

function renderBacklog() {
  const target = document.getElementById('pj-backlog-list');
  if (!target) return;
  if (!taskCache.length) { target.innerHTML = '<em class="txt-muted">No tasks yet. Add one above.</em>'; return; }
  if (backlogView === 'project') {
    const groups = new Map();
    for (const t of taskCache) {
      if (!groups.has(t.project_id)) groups.set(t.project_id, []);
      groups.get(t.project_id).push(t);
    }
    target.innerHTML = [...groups.entries()].map(([pid, ts]) =>
      `<div class="backlog-group"><h3 class="backlog-group-head">${esc(taskProjectName(pid))} <span class="txt-muted">${ts.length}</span></h3>${ts.map(t => taskRow(t, false)).join('')}</div>`,
    ).join('');
  } else {
    target.innerHTML = STATUS_VIEW_ORDER.map(s => {
      const ts = taskCache.filter(t => t.status === s);
      if (!ts.length) return '';
      return `<div class="backlog-group"><h3 class="backlog-group-head"><span class="badge status-${s}">${s}</span> <span class="txt-muted">${ts.length}</span></h3>${ts.map(t => taskRow(t, true)).join('')}</div>`;
    }).join('');
  }
}

async function addTask() {
  const project_id = document.getElementById('pj-task-project').value;
  const title = document.getElementById('pj-task-title').value.trim();
  const status = document.getElementById('pj-task-status').value;
  if (!project_id) { toast('add a project first', 'err'); return; }
  if (!title) return;
  try {
    await api('POST', `${P}/tasks`, { project_id, title, status });
    document.getElementById('pj-task-title').value = '';
    loadBacklog();
  } catch (e) { toast(e.message, 'err'); }
}

async function setTaskStatus(id, status) {
  try { await api('PATCH', `${P}/tasks/${id}`, { status }); loadBacklog(); }
  catch (e) { toast(e.message, 'err'); }
}

async function deleteTask(id) {
  try { await api('DELETE', `${P}/tasks/${id}`); loadBacklog(); }
  catch (e) { toast(e.message, 'err'); }
}

registerTab('projects', renderProjectsPane);
registerTab('backlog', renderBacklogPane);
registerAction('pj-edit', (el) => editProject(el.dataset.id));
registerAction('pj-delete', (el) => deleteProject(el.dataset.id, el.dataset.name));
registerAction('pj-clear', () => clearProjectForm());
registerAction('pj-view', (el) => setBacklogView(el.dataset.view));
registerAction('pj-delete-task', (el) => deleteTask(Number(el.dataset.id)));
registerChange('pj-task-status', (el) => setTaskStatus(Number(el.dataset.id), el.value));

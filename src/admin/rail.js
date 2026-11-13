// Shared area rail: turns the static three-area rail into the app launcher.
// Every enabled plugin that ships a UI and an icon gets a button after
// Workspace, so a domain app (money, health, projects) is a peer of Chat,
// not a tab buried in Studio. Served at /admin/rail.js and included by every
// admin page; the markup it inserts is built with DOM APIs only, so a plugin
// name or icon string from the server never reaches innerHTML.
(() => {
  const TOKEN_KEY = 'ritsu.adminToken';
  const SVG_NS = 'http://www.w3.org/2000/svg';

// Fire-and-forget: a rejection is logged instead of vanishing as an unhandled promise.
function background(promise) { promise.catch(e => console.error(e)); }


  function icon(d) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({
      width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      // decorative: the link around it carries the name
      'aria-hidden': 'true',
    })) svg.setAttribute(k, v);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  function appButton(p, current) {
    const a = document.createElement('a');
    a.className = 'rail-btn' + (current ? ' active' : '');
    a.href = `/admin/apps/${encodeURIComponent(p.id)}`;
    a.title = p.name;
    a.setAttribute('aria-label', p.name);
    if (current) a.setAttribute('aria-current', 'page');
    a.appendChild(icon(p.icon));
    return a;
  }

  async function mount() {
    const rail = document.querySelector('nav.rail');
    const token = localStorage.getItem(TOKEN_KEY) || '';
    if (!rail || !token) return;
    let plugins = [];
    try {
      const r = await fetch('/admin/api/plugins', { headers: { 'X-Ritsu-Admin-Token': token } });
      if (!r.ok) return;
      ({ plugins = [] } = await r.json());
    } catch { return; }
    const apps = plugins.filter(p => p.enabled !== false && p.icon && Array.isArray(p.nav) && p.nav.length);
    if (!apps.length) return;

    const m = /^\/admin\/apps\/([^/]+)/.exec(location.pathname);
    const currentId = m ? decodeURIComponent(m[1]) : null;
    const workspace = rail.querySelector('a.rail-btn[href="/admin/workspace"]');
    let after = workspace || rail.querySelector('.rail-logo');
    for (const p of apps) {
      const btn = appButton(p, p.id === currentId);
      after.insertAdjacentElement('afterend', btn);
      after = btn;
    }
    const sep = document.createElement('span');
    sep.className = 'rail-sep';
    after.insertAdjacentElement('afterend', sep);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else background(mount());
})();

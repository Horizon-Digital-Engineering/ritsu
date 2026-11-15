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

  // On a phone the rail is a bottom tab bar that can scroll sideways.
  function revealActive(rail) {
    const active = rail.querySelector('.rail-btn.active');
    const room = rail.scrollWidth - rail.clientWidth;
    if (!active || room <= 0) return;
    const centered = active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
    rail.scrollLeft = Math.min(room, Math.max(0, centered));
  }

  async function mount(rail) {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    if (!token) return;
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
      after.after(btn);
      after = btn;
    }
    const sep = document.createElement('span');
    sep.className = 'rail-sep';
    after.after(sep);
    revealActive(rail);
  }

  // .keyboard-up hides the tab bar under a phone keyboard. iOS opens no keyboard
  // for a scripted focus, so only a tap or a visual viewport that shrank counts.
  const TYPING = 'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not('
    + '[type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], '
    + '[type="range"], [type="color"], [type="file"], [type="image"], [type="hidden"])';
  const coarse = matchMedia('(pointer: coarse)');
  let press = { target: null, at: 0 };
  let tapped = false;
  let keyboardWasUp = false;

  function typingInto(el) {
    return el instanceof Element && el.matches(TYPING) && !el.readOnly;
  }
  function pressedOn(field, at) {
    const t = press.target;
    return t instanceof Element && at - press.at < 1000
      && (field.contains(t) || t.closest('label')?.control === field);
  }
  function keyboardUp() {
    const vv = window.visualViewport;
    return !!vv && document.documentElement.clientHeight - vv.height * vv.scale > 150;
  }
  function syncKeyboard() {
    const up = coarse.matches && typingInto(document.activeElement) && (tapped || keyboardUp());
    document.documentElement.classList.toggle('keyboard-up', up);
  }
  document.addEventListener('pointerdown', (e) => { press = { target: e.target, at: e.timeStamp }; }, true);
  document.addEventListener('focusin', (e) => {
    tapped = typingInto(e.target) && pressedOn(e.target, e.timeStamp);
    syncKeyboard();
  });
  // A tap on a field a script already focused opens the keyboard as well.
  document.addEventListener('click', (e) => {
    const field = document.activeElement;
    if (!tapped && typingInto(field) && field.contains(e.target)) { tapped = true; syncKeyboard(); }
  }, true);
  document.addEventListener('focusout', () => { tapped = false; syncKeyboard(); });
  window.visualViewport?.addEventListener('resize', () => {
    const up = keyboardUp();
    // Put away without a blur (Android's back button): the bar comes back.
    if (keyboardWasUp && !up) tapped = false;
    keyboardWasUp = up;
    syncKeyboard();
  });

  function start() {
    const rail = document.querySelector('nav.rail');
    if (!rail) return;
    new ResizeObserver(() => revealActive(rail)).observe(rail);
    background(mount(rail));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

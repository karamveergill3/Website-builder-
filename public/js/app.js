/* Hash router + app shell. */
import { $, $$, mount, html, toast, clearViewTimers } from './dom.js';

import leadsView     from './views/leads.js';
import templatesView from './views/templates.js';
import composeView   from './views/compose.js';
import logView       from './views/log.js';
import settingsView  from './views/settings.js';
import searchView    from './views/search.js';
import findView      from './views/find.js';
import deliverView   from './views/deliverability.js';
import outboxView    from './views/outbox.js';
import complianceView from './views/compliance.js';

const ROUTES = {
  '/leads':     leadsView,
  '/find':      findView,
  '/places':    searchView,
  '/search':    searchView,
  '/compose':   composeView,
  '/templates': templatesView,
  '/outbox':    outboxView,
  '/log':       logView,
  '/settings':  settingsView,
  '/compliance': complianceView,
  '/deliverability': deliverView,
};

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/leads';
  const [path, query = ''] = raw.split('?');
  return { path, params: Object.fromEntries(new URLSearchParams(query)) };
}

/** Re-render the current route. Views call this after mutating data. */
export function refresh() {
  return route();
}

export function navigate(to) {
  if (location.hash === `#${to}`) return refresh();
  location.hash = to;
}

/**
 * Swap in a brand-new <main> before rendering. Views attach delegated handlers
 * to this element; replacing it means those handlers cannot accumulate across
 * navigations or fire on a screen they were never meant for.
 */
function freshView() {
  const old = $('#view');
  const next = document.createElement('main');
  next.id = 'view';
  old.replaceWith(next);
  return next;
}

async function route() {
  const { path, params } = parseHash();
  // Object.hasOwn, so a hash like "#constructor" cannot resolve to a
  // prototype member and leave the app on a spinner forever.
  const render = Object.hasOwn(ROUTES, path) ? ROUTES[path] : ROUTES['/leads'];

  clearViewTimers();

  for (const a of $$('#nav a')) {
    a.toggleAttribute('aria-current', a.getAttribute('href') === `#${path}`);
    if (a.getAttribute('href') === `#${path}`) a.setAttribute('aria-current', 'page');
  }

  const el = freshView();
  mount(el, html`<div class="loading"><span class="spin"></span></div>`);
  try {
    await render(el, params, { refresh, navigate });
  } catch (err) {
    console.error(err);
    mount($('#view'), html`
      <div class="panel"><div class="panel-bd">
        <div class="msg msg-bad"><div class="grow">${err.message}</div></div>
        <p style="margin-top:12px"><button onclick="location.reload()">Reload</button></p>
      </div></div>`);
    toast(err.message, { error: true });
  }
}

window.addEventListener('hashchange', route);
route();

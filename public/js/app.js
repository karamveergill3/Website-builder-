/* Hash router + app shell. */
import { $, $$, mount, html, toast } from './dom.js';

import leadsView     from './views/leads.js';
import templatesView from './views/templates.js';
import composeView   from './views/compose.js';
import logView       from './views/log.js';
import settingsView  from './views/settings.js';
import searchView    from './views/search.js';
import outboxView    from './views/outbox.js';
import complianceView from './views/compliance.js';

const ROUTES = {
  '/leads':     leadsView,
  '/search':    searchView,
  '/compose':   composeView,
  '/templates': templatesView,
  '/outbox':    outboxView,
  '/log':       logView,
  '/settings':  settingsView,
  '/compliance': complianceView,
};

const view = () => $('#view');

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

async function route() {
  const { path, params } = parseHash();
  const render = ROUTES[path] ?? ROUTES['/leads'];

  for (const a of $$('#nav a')) {
    a.toggleAttribute('aria-current', a.getAttribute('href') === `#${path}`);
    if (a.getAttribute('href') === `#${path}`) a.setAttribute('aria-current', 'page');
  }

  mount(view(), html`<div class="loading"><span class="spinner"></span></div>`);
  try {
    await render(view(), params, { refresh, navigate });
  } catch (err) {
    console.error(err);
    mount(view(), html`
      <div class="card"><div class="card-body">
        <div class="note note-danger">
          <div><strong>Could not load this screen.</strong><br>${err.message}</div>
        </div>
        <p style="margin-top:14px"><button onclick="location.reload()">Reload</button></p>
      </div></div>`);
    toast(err.message, { error: true });
  }
}

window.addEventListener('hashchange', route);
route();

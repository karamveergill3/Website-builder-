/* Hash router + app shell. */
import { $, $$, mount, html, toast, clearViewTimers } from './dom.js';

import leadsView     from './views/leads.js';
import templatesView from './views/templates.js';
import composeView   from './views/compose.js';
import logView       from './views/log.js';
import settingsView  from './views/settings.js';
import searchView    from './views/search.js';
import huntView      from './views/hunt.js';
import deliverView   from './views/deliverability.js';
import outboxView    from './views/outbox.js';
import complianceView from './views/compliance.js';
import repliesView   from './views/replies.js';
import teamView, { loginView, setupView, openAccount } from './views/auth.js';
import invoicesView from './views/invoices.js';
import websitesView from './views/websites.js';
import { api } from './api.js';

const ROUTES = {
  '/leads':     leadsView,
  '/hunt':      huntView,
  '/places':    searchView,
  '/search':    searchView,
  '/compose':   composeView,
  '/templates': templatesView,
  '/outbox':    outboxView,
  '/replies':   repliesView,
  '/log':       logView,
  '/settings':  settingsView,
  '/compliance': complianceView,
  '/deliverability': deliverView,
  '/invoices':  invoicesView,
  '/websites':  websitesView,
  '/team':      teamView,
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
    // A session that lapsed mid-use: drop straight to the login rather than
    // showing a confusing error on a screen the viewer is no longer allowed.
    if (err.status === 401) { hideChrome(); return loginView($('#view')); }
    console.error(err);
    mount($('#view'), html`
      <div class="panel"><div class="panel-bd">
        <div class="msg msg-bad"><div class="grow">${err.message}</div></div>
        <p style="margin-top:12px"><button onclick="location.reload()">Reload</button></p>
      </div></div>`);
    toast(err.message, { error: true });
  }
}

/**
 * Boot gate. Before the router runs, ask who (if anyone) is signed in:
 *
 *   - no accounts yet  → the first-run setup screen (create the admin)
 *   - not signed in     → the login screen
 *   - signed in         → show who, wire logout, reveal the admin-only Team
 *                         tab, and start routing as normal.
 *
 * login and setup reload the page on success, so this runs again and lets the
 * app through — one source of truth for "who is signed in".
 */
function hideChrome() {
  const m = document.querySelector('.masthead');
  if (m) m.hidden = true;
}

function showUser(user) {
  const inner = document.querySelector('.masthead-inner');
  if (!inner || document.getElementById('userbox')) return;

  if (user.role === 'admin' && !document.querySelector('#nav a[href="#/team"]')) {
    const a = document.createElement('a');
    a.href = '#/team';
    a.textContent = 'Team';
    $('#nav')?.append(a);
  }

  const box = document.createElement('div');
  box.id = 'userbox';
  box.className = 'userbox';
  box.innerHTML = `<button class="who" id="account" title="Edit your name, number and password">${user.name}</button>`
    + '<button class="mini ghost" id="logout">Sign out</button>';
  inner.append(box);

  box.querySelector('#account').addEventListener('click', async () => {
    // Fetch fresh, so the modal shows the current phone/name not a boot-time copy.
    const { user: me } = await api.auth.me?.() ?? { user };
    if (await openAccount(me ?? user)) location.reload();
  });

  box.querySelector('#logout').addEventListener('click', async () => {
    try { await api.auth.logout(); } catch { /* sign out regardless */ }
    location.reload();
  });
}

async function boot() {
  let status;
  try {
    status = await api.auth.status();
  } catch {
    mount($('#view'), html`<div class="panel"><div class="panel-bd">
      <div class="msg msg-bad"><div class="grow">Can't reach the hub. Is it running?</div></div>
      <p style="margin-top:12px"><button onclick="location.reload()">Try again</button></p>
    </div></div>`);
    return;
  }

  if (status.needs_setup) { hideChrome(); return setupView(freshView()); }
  if (!status.authenticated) { hideChrome(); return loginView(freshView()); }

  showUser(status.user);
  window.addEventListener('hashchange', route);
  await route();

  // First sign-in with no number yet: nudge them to link their WhatsApp
  // before they start, so the messages they send carry their own identity.
  if (!status.user.phone) {
    if (await openAccount(status.user, { firstRun: true })) location.reload();
  }
}

boot();

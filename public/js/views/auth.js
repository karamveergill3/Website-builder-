/* Sign-in, first-run setup, and the admin's team screen. */
import { api } from '../api.js';
import { html, mount, on, $, toast, modal, confirmDialog, relative } from '../dom.js';

/**
 * A full-screen gate card. login and setup are shown BEFORE the router runs,
 * so they take over the whole view and, on success, reload the page — the
 * boot gate then re-runs and lets the app through. Reloading rather than
 * hand-rewiring the header keeps a single source of truth for "who is signed
 * in".
 */
function gateShell(title, tagline, inner) {
  return html`
    <div class="gate">
      <div class="gate-card panel">
        <div class="gate-hd">
          <span class="mark" aria-hidden="true"></span>
          <h1>${title}</h1>
          <p class="meta">${tagline}</p>
        </div>
        <div class="panel-bd">${inner}</div>
      </div>
    </div>`;
}

export function loginView(root) {
  mount(root, gateShell('Keylo Studios', 'Sign in to the outreach hub', html`
    <form id="login">
      <div class="f">
        <label for="l-email">Email</label>
        <input id="l-email" name="email" type="email" autocomplete="username" required autofocus>
      </div>
      <div class="f">
        <label for="l-pass">Password</label>
        <input id="l-pass" name="password" type="password" autocomplete="current-password" required>
      </div>
      <div id="l-err" class="msg msg-bad" hidden><div class="grow"></div></div>
      <button type="submit" class="primary" style="width:100%;margin-top:6px">Sign in</button>
    </form>`));

  on(root, 'submit', '#login', async (ev) => {
    ev.preventDefault();
    const err = $('#l-err', root);
    err.hidden = true;
    const btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      await api.auth.login({
        email: $('#l-email', root).value.trim(),
        password: $('#l-pass', root).value,
      });
      location.reload();
    } catch (e) {
      err.querySelector('.grow').textContent = e.message ?? 'Could not sign in';
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

export function setupView(root) {
  mount(root, gateShell('Welcome to Keylo', 'Create the owner account — this is the admin', html`
    <form id="setup">
      <div class="f">
        <label for="s-name">Your name</label>
        <input id="s-name" name="name" type="text" required autofocus>
      </div>
      <div class="f">
        <label for="s-email">Email</label>
        <input id="s-email" name="email" type="email" autocomplete="username" required>
      </div>
      <div class="f">
        <label for="s-pass">Password <span class="opt">at least 8 characters</span></label>
        <input id="s-pass" name="password" type="password" autocomplete="new-password" minlength="8" required>
      </div>
      <div id="s-err" class="msg msg-bad" hidden><div class="grow"></div></div>
      <button type="submit" class="primary" style="width:100%;margin-top:6px">Create admin account</button>
      <p class="tip" style="margin-top:10px">This is the only account that can add and remove
        your reps. You can add them from the Team screen once you're in.</p>
    </form>`));

  on(root, 'submit', '#setup', async (ev) => {
    ev.preventDefault();
    const err = $('#s-err', root);
    err.hidden = true;
    const btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      await api.auth.setup({
        name: $('#s-name', root).value.trim(),
        email: $('#s-email', root).value.trim(),
        password: $('#s-pass', root).value,
      });
      location.reload();
    } catch (e) {
      err.querySelector('.grow').textContent = e.message ?? 'Could not create the account';
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------- team screen */

export default async function teamView(root, _params, { refresh }) {
  let data;
  try {
    data = await api.auth.users();
  } catch (e) {
    if (e.status === 403) {
      mount(root, html`<div class="panel"><div class="blank">
        <strong>Admins only</strong>Only the owner account can manage the team.</div></div>`);
      return;
    }
    throw e;
  }

  mount(root, html`
    <div class="bar">
      <h2>Team</h2>
      <div class="grow"></div>
      <button class="primary" data-act="add-rep">Add a rep</button>
    </div>
    <div class="panel"><div class="panel-bd">
      <p class="tip" style="margin-top:0">Everyone here works under Keylo Studios. Each rep signs in,
        connects their own Gmail and uses their own phone for WhatsApp — the lead pool and the
        "already contacted" memory are shared, so no business is ever approached twice across the team.</p>
    </div></div>
    <div class="panel"><div class="scroll-x"><table class="rows">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last signed in</th><th></th></tr></thead>
      <tbody>
        ${data.users.map((u) => html`
          <tr data-id="${u.id}" style="${u.active ? '' : 'opacity:.55'}">
            <td class="c-name"><span class="name">${u.name}</span></td>
            <td class="meta">${u.email}</td>
            <td>${u.role === 'admin' ? html`<span class="flag" data-ok>admin</span>` : 'rep'}</td>
            <td class="meta nw">${u.last_login_at ? relative(u.last_login_at) : 'never'}</td>
            <td class="c-act">
              <button class="mini" data-act="reset" data-id="${u.id}" data-name="${u.name}">Reset password</button>
              ${u.role === 'admin' ? '' : (u.active
                ? html`<button class="mini danger" data-act="suspend" data-id="${u.id}" data-name="${u.name}">Suspend</button>`
                : html`<button class="mini" data-act="restore" data-id="${u.id}">Reactivate</button>`)}
            </td>
          </tr>`)}
      </tbody>
    </table></div></div>`);

  on(root, 'click', '[data-act="add-rep"]', async () => {
    const done = await modal({
      title: 'Add a rep',
      body: html`
        <div class="f"><label for="r-name">Name</label>
          <input id="r-name" name="name" type="text" required></div>
        <div class="f"><label for="r-email">Email (they sign in with this)</label>
          <input id="r-email" name="email" type="email" required></div>
        <div class="f"><label for="r-pass">Temporary password <span class="opt">8+ characters</span></label>
          <input id="r-pass" name="password" type="text" minlength="8" required></div>
        <p class="tip">Send them the email and this password. They can change the password from their
          own account once they sign in.</p>`,
      footer: html`<button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Add rep</button>`,
      onSubmit: async (d) => {
        await api.auth.addUser({ name: d.name, email: d.email, password: d.password, role: 'rep' });
        toast(`Added ${d.name}`);
        return true;
      },
    });
    if (done) refresh();
  });

  on(root, 'click', '[data-act="suspend"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'Suspend rep',
      message: `Sign ${el.dataset.name} out and block them from signing back in? Their leads stay in the pool.`,
      confirmLabel: 'Suspend', danger: true,
    })) return;
    await api.auth.setUser(el.dataset.id, { active: false });
    toast('Suspended');
    refresh();
  });

  on(root, 'click', '[data-act="restore"]', async (_e, el) => {
    await api.auth.setUser(el.dataset.id, { active: true });
    toast('Reactivated');
    refresh();
  });

  on(root, 'click', '[data-act="reset"]', async (_e, el) => {
    const done = await modal({
      title: `Reset password — ${el.dataset.name}`,
      body: html`
        <div class="f"><label for="rp">New temporary password <span class="opt">8+ characters</span></label>
          <input id="rp" name="password" type="text" minlength="8" required></div>
        <p class="tip">This signs them out everywhere. Send them the new password.</p>`,
      footer: html`<button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Set password</button>`,
      onSubmit: async (d) => {
        await api.auth.setUser(el.dataset.id, { password: d.password });
        toast('Password reset');
        return true;
      },
    });
    if (done) refresh();
  });
}

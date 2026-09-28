/* Sent via WhatsApp: everyone already messaged on WhatsApp.
 *
 * They move here from Leads the moment a send is confirmed in the Reach
 * dialog, so Leads stays a list of people still to approach. This is where
 * the follow-up happens: open the chat to see if they've replied, mark them
 * replied, won or lost, and open Reach for anything after that (a follow-up,
 * a call, a call-back). Changing the status keeps them here; the screen is
 * about how they were reached, not how it went.
 */
import { api } from '../api.js';
import {
  html, mount, on, $, confirmDialog, toast, statusPill, relative, viewKeys,
} from '../dom.js';
import { openLeadForm } from './leads.js';

/** What can happen after a WhatsApp goes out. */
const AFTER = ['sent', 'replied', 'won', 'lost'];
const label = (s) => (s === 'sent' ? 'awaiting reply' : s);

/** The chat to open: the number the WhatsApp actually went to. */
const chatLink = (l) => {
  const d = String(l.whatsapp_to ?? '').replace(/\D/g, '');
  return d.length >= 10 ? `https://wa.me/${d}` : null;
};

export default async function whatsappView(root, params, { refresh }) {
  const status = params.status ?? 'all';
  const q = params.q ?? '';
  const who = params.who ?? '';
  const due = params.due === '1';

  const [{ leads: rows }, stats, rosterRes, meRes] = await Promise.all([
    api.leads.list({
      status, q, assigned_to: who || undefined, sort: 'whatsapp', limit: 1000, pile: 'whatsapp',
    }),
    api.leads.stats({ pile: 'whatsapp' }),
    api.auth.roster().catch(() => ({ roster: [] })),
    api.auth.me().catch(() => ({ user: null })),
  ]);
  const dueCount = rows.filter((l) => l.callback_due).length;
  const leads = due ? rows.filter((l) => l.callback_due) : rows;

  const roster = rosterRes.roster ?? [];
  const me = meRes.user ?? null;
  const nameOf = (id) => roster.find((u) => u.id === id)?.name ?? null;
  const isTeam = roster.filter((u) => u.active).length > 1;
  const narrowed = Boolean(q) || status !== 'all' || Boolean(who) || due;

  // "new" only turns up if someone set it back by hand; give it a pill then,
  // so the pills always add up to All.
  const pills = stats.by_status.new ? [...AFTER, 'new'] : AFTER;

  const go = (key, value) => {
    const next = new URLSearchParams({ status, q, who, due: due ? '1' : '' });
    if (!value || value === 'all') next.delete(key); else next.set(key, value);
    for (const [k, v] of [...next]) if (!v) next.delete(k);
    const s = next.toString();
    location.hash = `/whatsapp${s ? `?${s}` : ''}`;
  };

  mount(root, html`
    <div class="readout">
      <div><b class="num">${stats.total}</b><span>Sent on WhatsApp</span></div>
      <div><b class="num">${stats.awaiting_reply}</b><span>Awaiting reply</span></div>
      <div><b class="num">${stats.replied}</b><span>Replied</span></div>
      <div data-accent><b class="num">${stats.won}</b><span>Won</span></div>
      <div><b class="num">${stats.lost}</b><span>Lost</span></div>
    </div>

    <div class="bar">
      <div class="pills">
        <button class="pill" data-filter="all" aria-pressed="${status === 'all'}">All <b>${stats.total}</b></button>
        ${pills.map((s) => html`
          <button class="pill" data-filter="${s}" aria-pressed="${status === s}">${label(s)} <b>${stats.by_status[s] ?? 0}</b></button>`)}
        ${dueCount || due ? html`
          <span class="sep"></span>
          <button class="pill" data-act="due" aria-pressed="${due}"
            title="Call-backs you arranged that are now due">call-backs due <b>${dueCount}</b></button>` : ''}
      </div>
      <div class="grow"></div>
      ${isTeam ? html`
        <select id="owner" style="max-width:150px" title="Whose leads to show">
          <option value=""     ${who === ''     ? 'selected' : ''}>Everyone</option>
          <option value="me"   ${who === 'me'   ? 'selected' : ''}>Mine</option>
          <option value="none" ${who === 'none' ? 'selected' : ''}>Unassigned</option>
          ${roster.filter((u) => u.active && !(me && u.id === me.id)).map((u) => html`
            <option value="${u.id}" ${who === String(u.id) ? 'selected' : ''}>${u.name}</option>`)}
        </select>` : ''}
      <input type="search" id="q" placeholder="Search  /" value="${q}" style="max-width:200px" autocomplete="off">
    </div>

    <div class="panel">
      ${leads.length === 0 ? html`
        <div class="blank">
          <strong>${narrowed ? 'Nothing matches' : 'Nobody messaged on WhatsApp yet'}</strong>
          ${narrowed ? 'Try another filter.' : html`
            Send one from <b>Reach</b> on the <a href="#/leads">Leads</a> screen. Once you
            confirm it went, the lead moves over here.`}
        </div>` : html`
        <div class="scroll-x">
        <table class="rows">
          <thead><tr>
            <th>Business</th><th>Phone</th><th>Trade</th>${isTeam ? html`<th>Owner</th>` : ''}<th>Status</th><th class="nw">Sent</th><th></th>
          </tr></thead>
          <tbody>
            ${leads.map((l) => {
              const chat = chatLink(l);
              return html`
              <tr data-id="${l.id}">
                <td class="c-name">
                  <span class="name">${l.business_name}</span>
                  <span class="meta">
                    ${l.location ?? '—'}${l.company_number ? html` · <span class="mono">${l.company_number}</span>` : ''}
                  </span>
                </td>
                <td>
                  <span class="meta mono" style="display:block">${l.whatsapp_to ?? l.phone ?? '—'}</span>
                  ${chat ? html`<a href="${chat}" target="_blank" rel="noopener"
                       title="Open the chat to see if they've replied">Open chat ↗</a>` : ''}
                  ${l.next_call_at ? html`<span class="flag" style="display:inline-block;margin-top:2px"
                       title="Call-back arranged">call back ${relative(l.next_call_at)}</span>` : ''}
                </td>
                <td class="meta">${l.category ?? '—'}</td>
                ${isTeam ? html`<td class="nw">
                  <select class="mini" data-act="owner" data-id="${l.id}" aria-label="Owner" style="max-width:130px">
                    <option value="none" ${l.assigned_to == null ? 'selected' : ''}>Unassigned</option>
                    ${roster.filter((u) => u.active || u.id === l.assigned_to).map((u) => html`
                      <option value="${u.id}" ${u.id === l.assigned_to ? 'selected' : ''}>${
                        me && u.id === me.id ? 'Me' : (nameOf(u.id) ?? u.name)}</option>`)}
                  </select></td>` : ''}
                <td class="nw">
                  ${statusPill(l.status)}
                  <select class="mini" data-act="status" data-id="${l.id}" aria-label="Change status"
                          style="max-width:120px;margin-left:6px">
                    <option value="">Mark as…</option>
                    ${AFTER.filter((s) => s !== l.status).map((s) => html`
                      <option value="${s}">${label(s)}</option>`)}
                  </select>
                </td>
                <td class="meta nw">${l.whatsapp_sent_at ? relative(l.whatsapp_sent_at) : '—'}</td>
                <td class="c-act">
                  <button class="mini" data-act="reach" data-id="${l.id}"
                    title="Follow up, call, arrange a call-back or find contact details">Reach</button>
                  <button class="mini" data-act="edit" data-id="${l.id}">Edit</button>
                  <button class="mini ghost" data-act="unsend" data-id="${l.id}" data-name="${l.business_name}"
                    title="The WhatsApp never actually went: put this lead back on Leads">Not sent</button>
                  <button class="mini danger" data-act="del" data-id="${l.id}"
                          data-name="${l.business_name}" aria-label="Delete">✕</button>
                </td>
              </tr>`;
            })}
          </tbody>
        </table>
        </div>`}
    </div>
  `);

  on(root, 'click', '[data-filter]', (_e, el) => go('status', el.dataset.filter));
  on(root, 'click', '[data-act="due"]', () => go('due', due ? '' : '1'));
  $('#owner', root)?.addEventListener('change', (e) => go('who', e.target.value));

  const search = $('#q', root);
  if (search) {
    if (pendingCaret !== null) {
      search.focus();
      const at = Math.min(pendingCaret, search.value.length);
      search.setSelectionRange(at, at);
      pendingCaret = null;
    }
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        pendingCaret = search.selectionStart ?? search.value.length;
        go('q', search.value.trim());
      }, 300);
    });
  }

  on(root, 'change', '[data-act="status"]', async (_e, el) => {
    if (!el.value) return;
    try {
      await api.leads.update(el.dataset.id, { status: el.value });
      toast(`Marked ${label(el.value)}`);
      refresh();
    } catch (err) {
      toast(err.message ?? 'Could not change it', { error: true });
      el.value = '';
    }
  });

  on(root, 'change', '[data-act="owner"]', async (_e, el) => {
    const userId = el.value === 'none' ? null : Number(el.value);
    try {
      await api.leads.assign(el.dataset.id, userId);
      toast(userId === null ? 'Unassigned' : `Now ${me && userId === me.id ? 'yours' : `${nameOf(userId)}'s`}`);
      refresh();
    } catch (err) {
      toast(err.message ?? 'Could not reassign it', { error: true });
    }
  });

  on(root, 'click', '[data-act="reach"]', async (_e, el) => {
    const { openReachDialog } = await import('./reach.js');
    await openReachDialog(el.dataset.id);
    refresh();
  });

  on(root, 'click', '[data-act="edit"]', async (_e, el) => {
    const { lead } = await api.leads.get(el.dataset.id);
    if (await openLeadForm(lead)) refresh();
  });

  on(root, 'click', '[data-act="unsend"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'The WhatsApp never went?',
      message: `Put ${el.dataset.name} back on Leads, as not messaged. Only do this if the `
        + 'message really did not send, say the number isn’t on WhatsApp.',
      confirmLabel: 'Put it back',
    })) return;
    try {
      await api.post(`/api/leads/${el.dataset.id}/whatsapp-unsend`, {});
      toast('Back on Leads');
      refresh();
    } catch (err) {
      toast(err.message ?? 'Could not put it back', { error: true });
    }
  });

  on(root, 'click', '[data-act="del"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'Delete lead',
      message: `Delete ${el.dataset.name}? They stay on the do-not-approach-again list either way.`,
      confirmLabel: 'Delete', danger: true,
    })) return;
    await api.leads.remove(el.dataset.id);
    toast('Deleted');
    refresh();
  });

  viewKeys(root, (ev) => {
    if (ev.key === '/') { ev.preventDefault(); $('#q', root)?.focus(); }
  });
}

/** Caret position to restore after a search-triggered re-render. */
let pendingCaret = null;

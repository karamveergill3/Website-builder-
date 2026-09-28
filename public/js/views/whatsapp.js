/* Sent via WhatsApp: everyone already messaged on WhatsApp.
 *
 * They move here from Leads the moment a send is confirmed in the Reach
 * dialog, so Leads stays a list of people still to approach. This is where
 * the follow-up happens: paste in what they sent back (copied from WhatsApp,
 * it finds its own lead) and get the answer drafted, mark them replied, won
 * or lost, and open Reach for anything after that (a follow-up, a call, a
 * call-back). Changing the status keeps them here; the screen is about how
 * they were reached, not how it went.
 */
import { api } from '../api.js';
import {
  html, mount, on, $, confirmDialog, toast, relative, viewKeys, modal,
} from '../dom.js';
import { openLeadForm } from './leads.js';

/** What can happen after a WhatsApp goes out. */
const AFTER = ['sent', 'replied', 'won', 'lost'];
const label = (s) => (s === 'sent' ? 'awaiting reply' : s);

/** "+447700900123" as a UK reader writes it: "07700 900123". */
const ukNumber = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return /^44\d{10}$/.test(d) ? `0${d.slice(2, 6)} ${d.slice(6)}` : v;
};

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

    <div class="panel paste-in">
      <div class="panel-bd">
        <h3 class="paste-title">Got a reply on WhatsApp? Get your answer in three steps</h3>
        <ol class="steps">
          <li><b>Copy their messages.</b> In WhatsApp on your computer, drag over their
            messages to select them, then press <kbd>Ctrl</kbd>+<kbd>C</kbd>.</li>
          <li><b>Paste here.</b> Come back to this screen and press <kbd>Ctrl</kbd>+<kbd>V</kbd>
            (or paste into the box below). It works out which business it is from their number.</li>
          <li><b>Send your answer.</b> Your reply pops up already written. Press <b>Copy</b>,
            paste it into their WhatsApp chat and send it yourself.</li>
        </ol>
        <textarea id="wa-paste" rows="2" autocomplete="off" aria-label="Paste their WhatsApp messages"
          placeholder="Paste their WhatsApp messages here"></textarea>
        <p class="tip">Nothing is ever sent from here. If it can't tell whose reply it is, it asks you.</p>
      </div>
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
        <table class="rows wa-rows">
          <thead><tr>
            <th>Business</th><th>Their WhatsApp</th>${isTeam ? html`<th>Owner</th>` : ''}<th>Status</th><th class="nw">Messaged</th><th></th>
          </tr></thead>
          <tbody>
            ${leads.map((l) => {
              const chat = chatLink(l);
              const statuses = AFTER.includes(l.status) ? AFTER : [l.status, ...AFTER];
              return html`
              <tr data-id="${l.id}">
                <td class="c-name">
                  <span class="name">${l.business_name}</span>
                  <span class="meta">${[l.category, l.location].filter(Boolean).join(' · ') || '—'}</span>
                  ${l.last_reply ? html`
                    <span class="said" title="${l.last_reply}">They said: “${l.last_reply.length > 90
                      ? `${l.last_reply.slice(0, 90)}…` : l.last_reply}” <span class="meta">${relative(l.last_reply_at)}</span></span>` : ''}
                </td>
                <td class="nw">
                  <span class="meta mono" style="display:block">${ukNumber(l.whatsapp_to ?? l.phone) ?? '—'}</span>
                  ${chat ? html`<a href="${chat}" target="_blank" rel="noopener"
                       title="Open your chat with them in WhatsApp">Open chat ↗</a>` : ''}
                  ${l.next_call_at ? html`<span class="flag" style="display:inline-block;margin-top:2px"
                       title="Call-back arranged">call back ${relative(l.next_call_at)}</span>` : ''}
                </td>
                ${isTeam ? html`<td>
                  <select class="mini fit" data-act="owner" data-id="${l.id}" aria-label="Owner">
                    <option value="none" ${l.assigned_to == null ? 'selected' : ''}>Unassigned</option>
                    ${roster.filter((u) => u.active || u.id === l.assigned_to).map((u) => html`
                      <option value="${u.id}" ${u.id === l.assigned_to ? 'selected' : ''}>${
                        me && u.id === me.id ? 'Me' : (nameOf(u.id) ?? u.name)}</option>`)}
                  </select></td>` : ''}
                <td>
                  <select class="mini fit st-select" data-act="status" data-id="${l.id}" data-s="${l.status}"
                          data-was="${l.status}" aria-label="Status" title="Change their status">
                    ${statuses.map((s) => html`
                      <option value="${s}" ${s === l.status ? 'selected' : ''}>${label(s)}</option>`)}
                  </select>
                </td>
                <td class="meta nw">${l.whatsapp_sent_at ? relative(l.whatsapp_sent_at) : '—'}</td>
                <td class="c-act">
                  ${l.last_reply_id ? html`
                    <button class="mini primary" data-act="draft" data-reply="${l.last_reply_id}"
                      title="Their last message, with your answer written">Answer them</button>` : html`
                    <button class="mini primary" data-act="paste" data-id="${l.id}" data-name="${l.business_name}"
                      title="They replied: paste what they sent and your answer is written">Paste their reply</button>`}
                  <details class="more">
                    <summary class="btn mini" aria-label="More for ${l.business_name}" title="More">⋯</summary>
                    <div class="more-menu">
                      ${l.last_reply_id ? html`
                        <button type="button" class="mini" data-act="paste" data-id="${l.id}" data-name="${l.business_name}">Paste another reply</button>` : ''}
                      <button type="button" class="mini" data-act="reach" data-id="${l.id}">Follow up or call</button>
                      <button type="button" class="mini" data-act="edit" data-id="${l.id}">Edit details</button>
                      <button type="button" class="mini" data-act="unsend" data-id="${l.id}" data-name="${l.business_name}">It never sent</button>
                      <button type="button" class="mini danger" data-act="del" data-id="${l.id}" data-name="${l.business_name}">Delete</button>
                    </div>
                  </details>
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
    if (!el.value || el.value === el.dataset.was) return;
    try {
      await api.leads.update(el.dataset.id, { status: el.value });
      toast(`Marked ${label(el.value)}`);
      refresh();
    } catch (err) {
      toast(err.message ?? 'Could not change it', { error: true });
      el.value = el.dataset.was;
    }
  });

  // The ⋯ menu: one open at a time, and it closes once something in it is picked.
  on(root, 'click', '.more-menu button', (_e, el) => el.closest('details')?.removeAttribute('open'));
  // Placed against the window, not the table, so the bottom rows' menus are
  // not cut off by the table's scroll box; upwards when there's no room below.
  const place = (open) => {
    const menu = open.querySelector('.more-menu');
    const at = open.querySelector('summary').getBoundingClientRect();
    menu.style.right = `${Math.max(8, window.innerWidth - at.right)}px`;
    const below = at.bottom + 4;
    menu.style.top = below + menu.offsetHeight > window.innerHeight - 8
      ? `${Math.max(8, at.top - 4 - menu.offsetHeight)}px` : `${below}px`;
  };
  root.addEventListener('toggle', (ev) => {
    const open = ev.target;
    if (!open.matches?.('details.more') || !open.open) return;
    for (const d of root.querySelectorAll('details.more[open]')) if (d !== open) d.removeAttribute('open');
    place(open);
  }, true);
  const closeMenus = (ev) => {
    if (!root.isConnected) {
      document.removeEventListener('click', closeMenus);
      window.removeEventListener('scroll', followMenus, true);
      window.removeEventListener('resize', followMenus);
      return;
    }
    if (ev.target instanceof Element && ev.target.closest('details.more')) return;
    for (const d of root.querySelectorAll('details.more[open]')) d.removeAttribute('open');
  };
  // An open menu stays with its button while the page scrolls.
  const followMenus = () => {
    if (!root.isConnected) return;
    for (const d of root.querySelectorAll('details.more[open]')) place(d);
  };
  document.addEventListener('click', closeMenus);
  window.addEventListener('scroll', followMenus, true);
  window.addEventListener('resize', followMenus);

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

  /**
   * WhatsApp keeps its chats to itself, so a reply comes in by copy and paste:
   * long-press the message (or select it on WhatsApp Desktop), copy, paste
   * here. It is filed against this lead and read into a brief, exactly as a
   * reply by email is, and the lead is marked replied.
   */
  on(root, 'click', '[data-act="paste"]', async (_e, el) => {
    const saved = await modal({
      title: `${el.dataset.name} replied`,
      wide: true,
      body: html`
        <div class="f">
          <label for="wr-body">Paste what they sent</label>
          <textarea id="wr-body" name="body" rows="9" required
            placeholder="1. Barlows Window Cleaning&#10;2. Ring us&#10;3. Stoke and Newcastle&#10;4. No logo, got photos&#10;5. Blue"></textarea>
          <p class="tip">Copy it from WhatsApp (select their messages on WhatsApp Desktop and
            press Ctrl+C, or press and hold one on the phone, then Copy). Several messages can
            go in together, and anything pasted before is not filed twice. Your answer is
            written for you next, to copy back into WhatsApp.</p>
        </div>`,
      footer: html`
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Save and read it</button>`,
      onSubmit: async (form) => {
        if (!form.body?.trim()) throw new Error('Paste what they sent');
        return api.post('/api/replies/whatsapp-paste', {
          lead_id: Number(el.dataset.id), text: form.body, origin: location.origin,
        });
      },
    });
    if (!saved) return;
    await answer(saved);
  });

  on(root, 'click', '[data-act="draft"]', async (_e, el) => {
    try {
      const { fetchDraft, showReplyDraft } = await import('./reply-draft.js');
      if (await showReplyDraft(await fetchDraft(el.dataset.reply))) refresh();
    } catch (err) {
      toast(err.message ?? 'Could not draft it', { error: true });
    }
  });

  /** Straight on to the answer: read, drafted, ready to copy back. */
  async function answer(saved) {
    if (saved.already) toast(`Already filed for ${saved.lead.business_name}: here is the answer again`);
    else if (saved.lead) toast(`Filed for ${saved.lead.business_name}`);
    if (saved.draft) {
      const { showReplyDraft } = await import('./reply-draft.js');
      await showReplyDraft(saved.draft);
    }
    refresh();
  }

  /**
   * Messages copied out of WhatsApp, pasted anywhere on this screen. Their
   * number finds the lead; when it can't (a saved contact, a single message
   * with no header, a number on no lead) the rep picks, and the number is
   * remembered for next time.
   */
  // One paste read at a time, so a double Ctrl+V does not open two answers.
  let reading = false;
  const done = () => { reading = false; };
  async function readPaste(text, leadId = null) {
    if (!text?.trim() || reading) return;
    reading = true;
    let res;
    try {
      res = await api.post('/api/replies/whatsapp-paste', {
        text, lead_id: leadId ?? undefined, origin: location.origin,
      });
    } catch (err) {
      toast(err.message ?? 'Could not read that', { error: true });
      return;
    } finally {
      done();
    }
    if (res.need_lead) {
      const picked = await pickLead(res);
      if (picked) await readPaste(text, picked);
      return;
    }
    await answer(res);
  }

  const box = $('#wa-paste', root);
  box?.addEventListener('paste', () => setTimeout(() => readPaste(box.value), 0));
  box?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); readPaste(box.value); }
  });

  const onPaste = (ev) => {
    if (!root.isConnected) return document.removeEventListener('paste', onPaste);
    const t = ev.target;
    if (t instanceof HTMLElement && t.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('.veil')) return;   // a dialog is open
    const text = ev.clipboardData?.getData('text/plain');
    if (!text?.trim()) return;
    ev.preventDefault();
    readPaste(text);
  };
  document.addEventListener('paste', onPaste);

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

const WHY = {
  'no-header': 'That paste doesn’t say who sent it (a single copied message never does). Whose reply is it?',
  'unknown-number': 'No lead has that number on it yet. Whose reply is it? The number is remembered for next time.',
  name: 'They’re saved in the phone under a name, so there’s no number to go on. Whose reply is it?',
  several: 'That number is on more than one lead. Which one is it?',
};

/** "Whose reply is this?" Resolves to a lead id, or null if cancelled. */
async function pickLead(res) {
  const option = (c, i) => html`
    <label class="pick-row" style="display:flex;gap:8px;align-items:baseline;padding:4px 0">
      <input type="radio" name="lead_id" value="${c.id}" ${i === 0 ? 'checked' : ''}>
      <span><b>${c.business_name}</b>
        <span class="meta">${c.location ?? ''}${c.whatsapp_sent_at ? ` · messaged ${relative(c.whatsapp_sent_at)}` : ''}${
          c.status ? ` · ${label(c.status)}` : ''}${c.fit ? ` · name fits ${c.fit}%` : ''}</span></span>
    </label>`;
  return modal({
    title: 'Whose reply is this?',
    wide: true,
    body: html`
      <p style="margin:0 0 8px">${WHY[res.reason] ?? WHY['no-header']}</p>
      ${res.sender?.phone || res.sender?.name ? html`
        <p class="meta" style="margin:0 0 8px">From <b class="mono">${res.sender.phone ?? res.sender.name}</b></p>` : ''}
      ${res.preview ? html`<blockquote class="quote" style="white-space:pre-wrap;max-height:120px;overflow:auto;margin:0 0 10px">${res.preview}</blockquote>` : ''}
      <div class="f">
        <label for="pick-q">Find a lead</label>
        <input type="search" id="pick-q" placeholder="Business name, town or phone" autocomplete="off">
      </div>
      <div data-picks>${(res.candidates ?? []).map(option)}</div>`,
    footer: html`
      <button type="button" data-close>Cancel</button>
      <button type="submit" class="primary">File it for them</button>`,
    onMount: (dlg) => {
      const list = dlg.querySelector('[data-picks]');
      const q = dlg.querySelector('#pick-q');
      let t;
      q?.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const term = q.value.trim();
          const rows = term
            ? (await api.leads.list({ q: term, limit: 12 }).catch(() => ({ leads: [] }))).leads
            : res.candidates ?? [];
          mount(list, html`${rows.length ? rows.map(option) : html`<p class="meta">No lead matches.</p>`}`);
        }, 250);
      });
    },
    onSubmit: async (form) => {
      const id = Number(form.lead_id);
      if (!id) throw new Error('Pick whose reply it is');
      return id;
    },
  });
}

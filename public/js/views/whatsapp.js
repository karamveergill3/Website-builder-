/* eslint-disable require-atomic-updates */
/* Sent via WhatsApp: everyone already messaged on WhatsApp, one column each.
 *
 * They move here from Leads the moment a send is confirmed in the Reach
 * dialog, so Leads stays a list of people still to approach. Each of the team
 * gets a column with the businesses they own; anyone marked lost goes to the
 * Archive tab, out of the way but not gone.
 *
 * Replies come in by the clipboard, because WhatsApp can't be read for free:
 * copy their messages out of WhatsApp, paste them in the box at the top (or
 * press Ctrl+V anywhere here). The site works out whose reply it is, from
 * their number if the paste carries it, else from what they wrote, and shows
 * the answer to send back. Nothing is saved until the answer is copied, so a
 * wrong guess costs nothing: change the business and the answer follows.
 */
import { api } from '../api.js';
import {
  html, mount, on, $, confirmDialog, toast, relative, viewKeys, modal,
} from '../dom.js';
import { openLeadForm } from './leads.js';
import { copy, waLink, runDraftAction, fetchDraft, showReplyDraft } from './reply-draft.js';

/** What can happen after a WhatsApp goes out. */
const AFTER = ['sent', 'replied', 'won', 'lost'];
const label = (s) => (s === 'sent' ? 'awaiting reply' : s);
/** Within a column: the ones to answer first, then those waiting, then won. */
const ORDER = { replied: 0, new: 1, sent: 2, won: 3, lost: 4 };

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

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || null;

/** A paste that is a WhatsApp copy rather than something typed into search. */
const looksLikeWhatsApp = (t) => /\n/.test(t) || /^\[?\d{1,2}[:/.]\d{1,2}/.test(t.trim());

/** Which lead the next paste is for, when a card's "Paste their reply" said so. */
let preset = null;

export default async function whatsappView(root, params, { refresh }) {
  const tab = params.tab === 'archive' ? 'archive' : 'active';
  const q = params.q ?? '';
  const due = params.due === '1';

  const [{ leads: all }, stats, rosterRes, meRes] = await Promise.all([
    api.leads.list({ q, sort: 'whatsapp', limit: 1000, pile: 'whatsapp' }),
    api.leads.stats({ pile: 'whatsapp' }),
    api.auth.roster().catch(() => ({ roster: [] })),
    api.auth.me().catch(() => ({ user: null })),
  ]);
  const roster = rosterRes.roster ?? [];
  const me = meRes.user ?? null;
  const team = roster.filter((u) => u.active);
  const nameOf = (id) => firstName(roster.find((u) => u.id === id)?.name);

  const archived = all.filter((l) => l.status === 'lost');
  const active = all.filter((l) => l.status !== 'lost');
  const dueCount = active.filter((l) => l.callback_due).length;
  let shown = tab === 'archive' ? archived : active;
  if (due && tab === 'active') shown = shown.filter((l) => l.callback_due);

  // One column per person on the team, and one for anyone nobody owns.
  const columns = team.map((u) => ({
    id: u.id,
    title: me && u.id === me.id ? `${u.name} (you)` : u.name,
    leads: shown.filter((l) => l.assigned_to === u.id),
  }));
  const orphans = shown.filter((l) => !team.some((u) => u.id === l.assigned_to));
  if (orphans.length || !columns.length) columns.push({ id: null, title: 'Unassigned', leads: orphans });
  for (const c of columns) {
    c.leads.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9)
      || String(b.whatsapp_sent_at ?? '').localeCompare(String(a.whatsapp_sent_at ?? '')));
  }

  const go = (key, value) => {
    const next = new URLSearchParams({ tab, q, due: due ? '1' : '' });
    if (!value || value === 'active') next.delete(key); else next.set(key, value);
    for (const [k, v] of [...next]) if (!v) next.delete(k);
    const s = next.toString();
    location.hash = `/whatsapp${s ? `?${s}` : ''}`;
  };

  const card = (l) => {
    const chat = chatLink(l);
    const statuses = AFTER.includes(l.status) ? AFTER : [l.status, ...AFTER];
    const others = team.filter((u) => u.id !== l.assigned_to);
    return html`
      <article class="wa-card" data-id="${l.id}" data-s="${l.status}">
        <div class="wa-card-top">
          <span class="name">${l.business_name}</span>
          <select class="mini fit st-select" data-act="status" data-id="${l.id}" data-s="${l.status}"
                  data-was="${l.status}" aria-label="Status for ${l.business_name}" title="Change their status">
            ${statuses.map((s) => html`
              <option value="${s}" ${s === l.status ? 'selected' : ''}>${label(s)}</option>`)}
          </select>
        </div>
        <div class="meta">${[l.category, l.location].filter(Boolean).join(' · ') || '—'}</div>
        ${l.last_reply ? html`
          <div class="said" title="${l.last_reply}">They said: “${l.last_reply.length > 110
            ? `${l.last_reply.slice(0, 110)}…` : l.last_reply}” <span class="meta">${relative(l.last_reply_at)}</span></div>` : ''}
        <div class="wa-card-foot">
          <span class="meta mono">${ukNumber(l.whatsapp_to ?? l.phone) ?? '—'}</span>
          ${chat ? html`<a href="${chat}" target="_blank" rel="noopener" title="Open your chat with them in WhatsApp">Open chat ↗</a>` : ''}
          <span class="meta">· messaged ${l.whatsapp_sent_at ? relative(l.whatsapp_sent_at) : '—'}</span>
          ${l.next_call_at ? html`<span class="flag" title="Call-back arranged">call back ${relative(l.next_call_at)}</span>` : ''}
        </div>
        <div class="wa-card-act">
          ${tab === 'archive' ? html`
            <button class="mini primary" data-act="restore" data-id="${l.id}" data-name="${l.business_name}"
              title="Put them back in the active columns, awaiting a reply">Restore</button>`
          : l.last_reply_id ? html`
            <button class="mini primary" data-act="draft" data-reply="${l.last_reply_id}"
              title="Their last message, with your answer written">Answer them</button>` : html`
            <button class="mini primary" data-act="paste" data-id="${l.id}" data-name="${l.business_name}"
              title="They replied: paste what they sent and your answer is written">Paste their reply</button>`}
          <details class="more">
            <summary class="btn mini" aria-label="More for ${l.business_name}" title="More">⋯</summary>
            <div class="more-menu">
              ${tab !== 'archive' && l.last_reply_id ? html`
                <button type="button" class="mini" data-act="paste" data-id="${l.id}" data-name="${l.business_name}">Paste another reply</button>` : ''}
              ${tab !== 'archive' ? html`
                <button type="button" class="mini" data-act="reach" data-id="${l.id}">Follow up or call</button>` : ''}
              ${others.map((u) => html`
                <button type="button" class="mini" data-act="move" data-id="${l.id}" data-to="${u.id}">Move to ${firstName(u.name)}</button>`)}
              ${l.assigned_to != null && team.length ? html`
                <button type="button" class="mini" data-act="move" data-id="${l.id}" data-to="none">Unassign</button>` : ''}
              <button type="button" class="mini" data-act="edit" data-id="${l.id}">Edit details</button>
              ${l.last_reply_id ? html`
                <button type="button" class="mini" data-act="del-reply" data-reply="${l.last_reply_id}"
                  data-name="${l.business_name}">Delete their last reply</button>` : ''}
              <button type="button" class="mini" data-act="unsend" data-id="${l.id}" data-name="${l.business_name}">It never sent</button>
              <button type="button" class="mini danger" data-act="del" data-id="${l.id}" data-name="${l.business_name}">Delete</button>
            </div>
          </details>
        </div>
      </article>`;
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
        <h3 class="paste-title">Got a reply on WhatsApp? Paste it here and your answer is written for you</h3>
        <ol class="steps">
          <li><b>Copy their messages.</b> In WhatsApp on your computer, drag over their
            messages, then press <kbd>Ctrl</kbd>+<kbd>C</kbd>.</li>
          <li><b>Paste here.</b> Press <kbd>Ctrl</kbd>+<kbd>V</kbd> anywhere on this screen. It
            reads the reply and works out which business it's from.</li>
          <li><b>Check and copy.</b> Make sure the business is right, press <b>Copy answer</b>,
            and paste it into their WhatsApp chat.</li>
        </ol>
        <div data-preset></div>
        <textarea id="wa-paste" rows="2" autocomplete="off" aria-label="Paste their WhatsApp messages"
          placeholder="Paste their WhatsApp messages here"></textarea>
        <div data-result></div>
      </div>
    </div>

    <div class="bar">
      <div class="pills">
        <button class="pill" data-tab="active" aria-pressed="${tab === 'active'}">Active <b>${active.length}</b></button>
        <button class="pill" data-tab="archive" aria-pressed="${tab === 'archive'}"
          title="Everyone marked lost">Archive <b>${archived.length}</b></button>
        ${tab === 'active' && (dueCount || due) ? html`
          <span class="sep"></span>
          <button class="pill" data-act="due" aria-pressed="${due}"
            title="Call-backs you arranged that are now due">call-backs due <b>${dueCount}</b></button>` : ''}
      </div>
      <div class="grow"></div>
      <input type="search" id="q" placeholder="Search  /" value="${q}" style="max-width:220px" autocomplete="off">
    </div>

    ${shown.length === 0 ? html`
      <div class="panel"><div class="blank">
        ${tab === 'archive' ? html`
          <strong>${q ? 'Nothing matches' : 'The archive is empty'}</strong>
          ${q ? 'Try another search.' : 'Anyone you mark lost moves here.'}` : html`
          <strong>${q || due ? 'Nothing matches' : 'Nobody messaged on WhatsApp yet'}</strong>
          ${q || due ? 'Try another search.' : html`
            Send one from <b>Reach</b> on the <a href="#/leads">Leads</a> screen. Once you
            confirm it went, the lead moves over here.`}`}
      </div></div>` : html`
      <div class="wa-columns" style="--cols:${columns.length}">
        ${columns.map((c) => html`
          <section class="wa-col" aria-label="${c.title}">
            <header class="wa-col-hd">
              <b>${c.title}</b>
              <span class="meta">${c.leads.length}${tab === 'active' ? ` · ${
                c.leads.filter((l) => l.status === 'replied').length} replied · ${
                c.leads.filter((l) => l.status === 'sent').length} awaiting` : ''}</span>
            </header>
            ${c.leads.length ? c.leads.map(card) : html`<p class="meta wa-empty">Nobody here.</p>`}
          </section>`)}
      </div>`}
  `);

  on(root, 'click', '[data-tab]', (_e, el) => go('tab', el.dataset.tab));
  on(root, 'click', '[data-act="due"]', () => go('due', due ? '' : '1'));

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

  /* ---------------------------------------------------- the paste box */

  const box = $('#wa-paste', root);
  const result = root.querySelector('[data-result]');
  const presetSlot = root.querySelector('[data-preset]');
  let seq = 0;          // the latest read; an older answer arriving late is dropped
  let current = null;   // { text, read, saved, sender }

  const showPreset = () => mount(presetSlot, preset ? html`
    <div class="msg msg-info wa-preset"><div class="grow">Your next paste is for <b>${preset.name}</b>.</div>
      <button type="button" class="mini ghost" data-act="unpreset">Not them</button></div>` : '');
  showPreset();

  async function read(text, { leadId = null, sender = null } = {}) {
    if (!text?.trim()) return;
    seq += 1;
    const mine = seq;
    const chosen = leadId ?? preset?.id ?? null;
    mount(result, html`<p class="meta wa-reading"><span class="spin"></span> Reading it…</p>`);
    let res;
    try {
      res = await api.post('/api/replies/whatsapp-read', {
        text, lead_id: chosen ?? undefined, sender: sender ?? undefined, origin: location.origin,
      });
    } catch (err) {
      if (mine !== seq) return;
      mount(result, html`<div class="msg msg-bad"><div class="grow">${err.message ?? 'Could not read that'}</div>
        <button type="button" class="mini" data-act="clear">Clear</button></div>`);
      return;
    }
    if (mine !== seq) return;
    current = { text, read: res, saved: null, sender };
    renderResult();
  }

  function renderResult() {
    const r = current?.read;
    if (!r) { mount(result, ''); return; }
    const d = r.draft;
    const byOwner = new Map();
    for (const c of r.candidates ?? []) {
      const k = c.owner ?? 'Unassigned';
      if (!byOwner.has(k)) byOwner.set(k, []);
      byOwner.get(k).push(c);
    }
    const sure = r.sure;
    mount(result, html`
      <div class="wa-result">
        <div class="wa-for">
          <label for="wa-lead">Reply to</label>
          <select id="wa-lead" class="fit" style="max-width:340px">
            ${r.lead ? '' : html`<option value="">Choose the business…</option>`}
            ${[...byOwner].map(([owner, list]) => html`
              <optgroup label="${owner}">
                ${list.map((c) => html`<option value="${c.id}" ${r.lead?.id === c.id ? 'selected' : ''}>${
                  c.business_name}${c.location ? ` (${c.location})` : ''}${c.status === 'lost' ? ' · archived' : ''}</option>`)}
              </optgroup>`)}
            <option value="search">Another business…</option>
          </select>
          ${r.lead ? html`<span class="flag" ${sure ? 'data-ok' : ''}>${sure
            ? (r.how === 'number' ? 'Matched by their number' : 'You chose this')
            : 'Best guess: check it’s right'}</span>` : ''}
          ${r.why && !sure ? html`<span class="meta">${r.why}</span>` : ''}
        </div>
        ${r.senders?.length ? html`
          <div class="wa-for">
            <label for="wa-sender">Their messages are from</label>
            <select id="wa-sender" class="fit">
              ${r.senders.map((p) => html`<option value="${p.key}" ${p.chosen ? 'selected' : ''}>${p.name}</option>`)}
            </select>
            <span class="meta">The other name is you.</span>
          </div>` : ''}
        ${r.clash?.length ? html`
          <div class="msg msg-warn"><div class="grow">That came from ${r.from}, which is
            <b>${r.clash.map((c) => c.business_name).join(' and ')}</b>’s number, not this business’s.</div>
            <button type="button" class="mini" data-act="use-clash" data-id="${r.clash[0].id}">Use ${r.clash[0].business_name}</button></div>` : ''}
        ${r.their_text.trim() !== String(current.text).trim() ? html`
          <label style="margin-top:4px">Their messages <span class="opt">(yours are left out)</span></label>
          <blockquote class="quote">${r.their_text}</blockquote>` : ''}
        ${!r.lead ? html`<p class="meta">Choose the business above and the answer is written.</p>`
        : d?.intent === 'stop' ? html`
          <div class="msg msg-warn"><div class="grow">They asked you to stop messaging them. There is
            nothing to send; mark them so nobody contacts them again.</div>
            <button type="button" class="mini primary" data-act="file-stop">Mark them do not contact</button></div>`
        : html`
          ${d?.note ? html`<div class="msg msg-warn"><div class="grow">${d.note}</div></div>` : ''}
          <div class="f" style="margin:8px 0 6px">
            <label for="wa-answer">Your answer <span class="opt">edit it however you like</span></label>
            <textarea id="wa-answer" rows="${Math.min(14, Math.max(5, String(d?.text ?? '').split('\n').length + 1))}">${d?.text ?? ''}</textarea>
          </div>
          <div class="bar" style="margin:0">
            <button type="button" class="primary" data-act="copy-answer">Copy answer</button>
            ${d?.wa_number ? html`<a class="btn" data-act="open-wa" target="_blank" rel="noopener"
              href="${waLink(d.wa_number, d.text ?? '')}">Open in WhatsApp</a>` : ''}
            ${(d?.actions ?? []).map((a) => html`
              <button type="button" class="mini" data-action="${a.id}">${a.label}</button>`)}
            <div class="grow"></div>
            <button type="button" class="ghost" data-act="clear">${current.saved ? 'Done' : 'Clear'}</button>
          </div>`}
        <p class="tip">${current.saved
          ? html`Saved to <b>${current.saved.name}</b>: their reply is on their card below.`
          : r.already ? 'This was saved before; copying again changes nothing.'
          : 'Nothing is saved until you copy the answer. Then their reply is filed under the business above.'}</p>
      </div>`);

    const answer = $('#wa-answer', result);
    const wa = result.querySelector('[data-act="open-wa"]');
    answer?.addEventListener('input', () => { if (wa) wa.href = waLink(d.wa_number, answer.value); });
    $('#wa-lead', result)?.addEventListener('change', async (ev) => {
      const v = ev.target.value;
      if (v === 'search') {
        const picked = await findLead();
        if (picked) read(current.text, { leadId: picked, sender: current.sender });
        else ev.target.value = r.lead?.id ?? '';
        return;
      }
      if (v) read(current.text, { leadId: Number(v), sender: current.sender });
    });
    $('#wa-sender', result)?.addEventListener('change', (ev) =>
      read(current.text, { leadId: r.how === 'chosen' ? r.lead?.id : null, sender: ev.target.value }));
  }

  /** File the reply under the business shown. Resolves to the filed reply, or null. */
  async function file() {
    const r = current?.read;
    if (!r?.lead) return null;
    if (current.saved) return current.saved;
    const at = current;
    try {
      const out = await api.post('/api/replies/whatsapp-paste', {
        text: at.text, lead_id: r.lead.id, sender: at.sender ?? undefined, origin: location.origin,
      });
      const saved = { reply_id: out.reply_id, name: r.lead.business_name, stopped: out.stopped };
      at.saved = saved;
      if (preset?.id === r.lead.id) { preset = null; showPreset(); }
      return saved;
    } catch (err) {
      toast(err.message ?? 'Could not save it', { error: true, ms: 7000 });
      return null;
    }
  }

  on(result, 'click', '[data-act="copy-answer"]', async () => {
    // Copy first, while the click still counts as the rep's own action.
    const ok = await copy($('#wa-answer', result)?.value ?? '');
    const saved = await file();
    toast(ok
      ? (saved ? `Copied, and saved to ${saved.name}. Paste it into WhatsApp` : 'Copied (not saved)')
      : 'Could not copy: select the text instead', { error: !ok });
    if (saved) renderResult();
  });
  on(result, 'click', '[data-act="open-wa"]', () => { file().then((s) => { if (s) renderResult(); }); });
  on(result, 'click', '[data-act="file-stop"]', async () => {
    const saved = await file();
    if (saved) { toast(`${saved.name} won’t be contacted again`); renderResult(); }
  });
  on(result, 'click', '[data-act="use-clash"]', (_e, el) =>
    read(current.text, { leadId: Number(el.dataset.id), sender: current.sender }));
  on(result, 'click', '[data-action]', async (_e, el) => {
    el.disabled = true;
    const saved = await file();
    if (!saved) { el.disabled = false; return; }
    try {
      const draft = { ...current.read.draft, reply_id: saved.reply_id };
      const out = await runDraftAction(el.dataset.action, draft);
      if (out.next) await showReplyDraft(out.next);
      refresh();
    } catch (err) {
      toast(err.message ?? 'That did not work', { error: true });
      el.disabled = false;
    }
  });
  on(result, 'click', '[data-act="clear"]', () => {
    const wasSaved = Boolean(current?.saved);
    current = null;
    seq += 1;
    box.value = '';
    mount(result, '');
    if (wasSaved) refresh();
  });
  on(presetSlot, 'click', '[data-act="unpreset"]', () => { preset = null; showPreset(); });

  // Pasting into the box replaces what was there: a new reply, read afresh.
  box?.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text/plain');
    if (!text?.trim()) return;
    ev.preventDefault();
    box.value = text;
    read(text);
  });
  box?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); read(box.value); }
  });

  // Ctrl+V anywhere on the screen, bar a box meant for typing. The search box
  // only takes it when it is clearly a WhatsApp copy.
  const onPaste = (ev) => {
    if (!root.isConnected) return document.removeEventListener('paste', onPaste);
    if (document.querySelector('.veil')) return;   // a dialog is open
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    const t = ev.target;
    if (t instanceof HTMLElement && t.closest('textarea, [contenteditable]')) return;
    if (t instanceof HTMLElement && t.closest('input') && !(t.id === 'q' && looksLikeWhatsApp(text))) return;
    if (!text.trim()) return;
    ev.preventDefault();
    box.value = text;
    box.scrollIntoView({ block: 'nearest' });
    read(text);
  };
  document.addEventListener('paste', onPaste);

  /** "Another business…": search every lead. */
  async function findLead() {
    return modal({
      title: 'Which business is it?',
      body: html`
        <div class="f">
          <label for="find-q">Business name or town</label>
          <input type="search" id="find-q" autocomplete="off" placeholder="Start typing">
        </div>
        <div data-found><p class="meta">Type to search.</p></div>`,
      footer: html`
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Use this business</button>`,
      onMount: (dlg) => {
        const list = dlg.querySelector('[data-found]');
        const input = dlg.querySelector('#find-q');
        let t;
        const run = async () => {
          const term = input.value.trim();
          if (!term) { mount(list, html`<p class="meta">Type to search.</p>`); return; }
          const rows = (await api.leads.list({ q: term, limit: 12 }).catch(() => ({ leads: [] }))).leads;
          mount(list, rows.length ? html`${rows.map((c) => html`
            <label style="display:flex;gap:8px;align-items:baseline;padding:4px 0">
              <input type="radio" name="lead_id" value="${c.id}">
              <span><b>${c.business_name}</b> <span class="meta">${c.location ?? ''}${
                c.assigned_to ? ` · ${nameOf(c.assigned_to) ?? ''}` : ''}</span></span>
            </label>`)}` : html`<p class="meta">No business matches.</p>`);
        };
        input?.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
        // Enter searches; it never files for a business nobody picked.
        input?.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); clearTimeout(t); run(); }
        });
      },
      onSubmit: async (form) => {
        const id = Number(form.lead_id);
        if (!id) throw new Error('Pick the business');
        return id;
      },
    });
  }

  /* ------------------------------------------------------ the cards */

  on(root, 'change', '[data-act="status"]', async (_e, el) => {
    if (!el.value || el.value === el.dataset.was) return;
    try {
      await api.leads.update(el.dataset.id, { status: el.value });
      toast(el.value === 'lost' ? 'Marked lost: moved to the Archive' : `Marked ${label(el.value)}`);
      refresh();
    } catch (err) {
      toast(err.message ?? 'Could not change it', { error: true });
      el.value = el.dataset.was;
    }
  });

  on(root, 'click', '[data-act="restore"]', async (_e, el) => {
    try {
      await api.leads.update(el.dataset.id, { status: 'sent' });
      toast(`${el.dataset.name} is back, awaiting a reply`);
      refresh();
    } catch (err) {
      toast(err.message ?? 'Could not restore it', { error: true });
    }
  });

  on(root, 'click', '[data-act="move"]', async (_e, el) => {
    const userId = el.dataset.to === 'none' ? null : Number(el.dataset.to);
    try {
      await api.leads.assign(el.dataset.id, userId);
      toast(userId === null ? 'Unassigned' : `Moved to ${nameOf(userId)}`);
      refresh();
    } catch (err) {
      toast(err.message ?? 'Could not move it', { error: true });
    }
  });

  // A card's "Paste their reply": the next paste is for that business.
  on(root, 'click', '.wa-card [data-act="paste"]', (_e, el) => {
    preset = { id: Number(el.dataset.id), name: el.dataset.name };
    showPreset();
    box.focus();
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast(`Now paste ${el.dataset.name}’s reply (Ctrl+V)`);
  });

  on(root, 'click', '[data-act="draft"]', async (_e, el) => {
    try {
      if (await showReplyDraft(await fetchDraft(el.dataset.reply))) refresh();
    } catch (err) {
      toast(err.message ?? 'Could not draft it', { error: true });
    }
  });

  on(root, 'click', '[data-act="del-reply"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'Delete their last reply',
      message: `Delete the last reply saved for ${el.dataset.name}? Use this when it was filed under the wrong business.`,
      confirmLabel: 'Delete', danger: true,
    })) return;
    try {
      await api.del(`/api/replies/${el.dataset.reply}`);
      toast('Reply deleted');
      refresh();
    } catch (err) {
      toast(err.message ?? 'Could not delete it', { error: true });
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

  /* ------------------------------------------------------ the ⋯ menu */

  // One open at a time, closed once something in it is picked. Placed against
  // the window, so a menu near the bottom is not cut off; upwards when there
  // is no room below, and it stays with its button as the page scrolls.
  const place = (open) => {
    const menu = open.querySelector('.more-menu');
    const at = open.querySelector('summary').getBoundingClientRect();
    menu.style.right = `${Math.max(8, window.innerWidth - at.right)}px`;
    const below = at.bottom + 4;
    menu.style.top = below + menu.offsetHeight > window.innerHeight - 8
      ? `${Math.max(8, at.top - 4 - menu.offsetHeight)}px` : `${below}px`;
  };
  on(root, 'click', '.more-menu button', (_e, el) => el.closest('details')?.removeAttribute('open'));
  root.addEventListener('toggle', (ev) => {
    const open = ev.target;
    if (!open.matches?.('details.more') || !open.open) return;
    for (const d of root.querySelectorAll('details.more[open]')) if (d !== open) d.removeAttribute('open');
    place(open);
  }, true);
  const followMenus = () => {
    if (!root.isConnected) return;
    for (const d of root.querySelectorAll('details.more[open]')) place(d);
  };
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
  document.addEventListener('click', closeMenus);
  window.addEventListener('scroll', followMenus, true);
  window.addEventListener('resize', followMenus);

  viewKeys(root, (ev) => {
    if (ev.key === '/') { ev.preventDefault(); $('#q', root)?.focus(); }
  });
}

/** Caret position to restore after a search-triggered re-render. */
let pendingCaret = null;

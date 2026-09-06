/* The lead list: the screen this tool is actually used from. */
import { api } from '../api.js';
import {
  html, mount, on, $, $$, modal, confirmDialog, toast,
  statusPill, relative, viewKeys,
} from '../dom.js';

const STATUSES = ['new', 'sent', 'replied', 'won', 'lost'];

/** Why a lead cannot be written to. Full reason goes in the title attribute. */
const BLOCKED = {
  UNCLASSIFIED: 'unchecked',
  INDIVIDUAL_SUBSCRIBER: 'sole trader',
  FREE_MAIL: 'personal inbox',
  SUPPRESSED: 'suppressed',
  OPTED_OUT: 'opted out',
  NO_EMAIL: 'no email',
};

export function leadFields(lead = {}) {
  const t = (name, label, opts = {}) => html`
    <div class="f">
      <label for="f-${name}">${label}${opts.opt ? html` <span class="opt">optional</span>` : ''}</label>
      <input id="f-${name}" name="${name}" type="${opts.type ?? 'text'}"
             value="${lead[name] ?? ''}" placeholder="${opts.ph ?? ''}"
             class="${opts.mono ? 'mono' : ''}" autocomplete="off" ${opts.req ? 'required' : ''}>
    </div>`;

  return html`
    ${t('business_name', 'Business', { req: true })}
    <div class="cols">
      ${t('email', 'Email', { type: 'email' })}
      ${t('phone', 'Phone', { type: 'tel' })}
      ${t('category', 'Category', { ph: 'roofers' })}
      ${t('location', 'Town', { ph: 'Otley' })}
    </div>

    <div class="cols">
      <div class="f">
        <label for="f-entity_type">Legal form</label>
        <select id="f-entity_type" name="entity_type">
          <option value="unknown"    ${(lead.entity_type ?? 'unknown') === 'unknown'    ? 'selected' : ''}>Unchecked — cannot email</option>
          <option value="corporate"  ${lead.entity_type === 'corporate'  ? 'selected' : ''}>Limited company / LLP</option>
          <option value="individual" ${lead.entity_type === 'individual' ? 'selected' : ''}>Sole trader — cannot email</option>
        </select>
      </div>
      ${t('company_number', 'Company no.', { mono: true, ph: '01234567' })}
    </div>
    <p class="tip">
      Only limited companies and LLPs may be cold-emailed.
      <a href="#/compliance">Why</a> ·
      <a href="https://find-and-update.company-information.service.gov.uk/" target="_blank" rel="noopener">Companies House</a>
    </p>

    <div class="f" style="margin-top:11px">
      <label for="f-notes">Notes</label>
      <textarea id="f-notes" name="notes" rows="3">${lead.notes ?? ''}</textarea>
    </div>

    <div class="cols">
      <div class="f">
        <label for="f-status">Status</label>
        <select id="f-status" name="status">
          ${STATUSES.map((s) => html`<option value="${s}" ${lead.status === s ? 'selected' : ''}>${s}</option>`)}
        </select>
      </div>
      ${t('source', 'Source', { opt: true })}
    </div>

    <div class="check">
      <input id="f-opted_out" name="opted_out" type="checkbox" ${lead.opted_out ? 'checked' : ''}>
      <label for="f-opted_out">Opted out — block permanently, including if re-imported later</label>
    </div>
    <input type="hidden" name="google_place_id" value="${lead.google_place_id ?? ''}">
    <input type="hidden" name="entity_note" value="${lead.entity_note ?? ''}">`;
}

export const leadBody = (d) => ({
  business_name: d.business_name, category: d.category, location: d.location,
  phone: d.phone, email: d.email, source: d.source, status: d.status,
  google_place_id: d.google_place_id, notes: d.notes,
  entity_type: d.entity_type, company_number: d.company_number, entity_note: d.entity_note,
  opted_out: d.opted_out === 'on',
});

export async function openLeadForm(lead) {
  const editing = Boolean(lead?.id);
  return modal({
    title: editing ? lead.business_name : 'New lead',
    body: leadFields(lead ?? { status: 'new' }),
    footer: html`
      <button type="button" data-close>Cancel</button>
      <button type="submit" class="primary">${editing ? 'Save' : 'Add'}</button>`,
    onSubmit: async (d) => {
      const saved = editing
        ? await api.leads.update(lead.id, leadBody(d))
        : await api.leads.create(leadBody(d));
      toast(editing ? 'Saved' : `Added ${saved.lead.business_name}`);
      return saved.lead;
    },
  });
}

export default async function leadsView(root, params, { refresh }) {
  const status = params.status ?? 'all';
  const q = params.q ?? '';
  const sort = params.sort ?? 'created';

  const [{ leads }, stats, gmail] = await Promise.all([
    api.leads.list({ status, q, sort }),
    api.leads.stats(),
    api.get('/api/gmail/status').catch(() => null),
  ]);
  const canQueue = gmail?.connected === true;

  const go = (key, value) => {
    const next = new URLSearchParams({ status, q, sort });
    if (!value || value === 'all') next.delete(key); else next.set(key, value);
    const s = next.toString();
    location.hash = `/leads${s ? `?${s}` : ''}`;
  };

  mount(root, html`
    <div class="readout">
      <div><b class="num">${stats.total}</b><span>Leads</span></div>
      <div><b class="num">${stats.awaiting_reply}</b><span>Awaiting reply</span></div>
      <div><b class="num">${stats.replied}</b><span>Replied</span></div>
      <div data-accent><b class="num">${stats.won}</b><span>Won</span></div>
      <div data-accent="${stats.emailable ? '' : 'warn'}"><b class="num">${stats.emailable}</b><span>Ready to email</span></div>
      ${stats.unclassified ? html`
        <div data-accent="warn"><b class="num">${stats.unclassified}</b><span>Need checking</span></div>` : ''}
    </div>

    <div class="bar">
      <div class="pills">
        <button class="pill" data-filter="all" aria-pressed="${status === 'all'}">All <b>${stats.total}</b></button>
        ${STATUSES.map((s) => html`
          <button class="pill" data-filter="${s}" aria-pressed="${status === s}">${s} <b>${stats.by_status[s] ?? 0}</b></button>`)}
      </div>
      <div class="grow"></div>
      <input type="search" id="q" placeholder="Search  /" value="${q}" style="max-width:200px" autocomplete="off">
      <select id="sort" style="max-width:150px">
        <option value="created"   ${sort === 'created'   ? 'selected' : ''}>Newest</option>
        <option value="oldest"    ${sort === 'oldest'    ? 'selected' : ''}>Oldest</option>
        <option value="name"      ${sort === 'name'      ? 'selected' : ''}>A–Z</option>
        <option value="contacted" ${sort === 'contacted' ? 'selected' : ''}>Last contacted</option>
      </select>
      <button class="primary" data-act="add">New lead</button>
    </div>

    <div id="bulk" hidden class="bar" style="background:var(--green-lift);border:1px solid #bcd0c0;
         border-radius:var(--r-sm);padding:5px 10px;margin-bottom:10px">
      <b id="bulk-n" style="font-size:.8rem"></b>
      <div class="grow"></div>
      <select id="bulk-status" style="max-width:150px">
        <option value="">Set status…</option>
        ${STATUSES.map((s) => html`<option value="${s}">${s}</option>`)}
      </select>
      ${canQueue ? html`<button class="primary" data-act="bulk-queue">Queue emails</button>` : ''}
      <button class="mini ghost" data-act="bulk-clear">Clear</button>
    </div>

    <div class="panel">
      ${leads.length === 0 ? html`
        <div class="blank">
          <strong>${q || status !== 'all' ? 'Nothing matches' : 'No leads yet'}</strong>
          ${q || status !== 'all' ? 'Try another filter.' : html`
            <a href="#/search">Find businesses with no website</a>, or add one by hand.`}
        </div>` : html`
        <div class="scroll-x">
        <table class="rows">
          <thead><tr>
            <th class="c-pick"><input type="checkbox" id="pick-all" class="pick" aria-label="Select all"></th>
            <th>Business</th><th>Contact</th><th>Trade</th><th>Status</th><th class="nw">Contacted</th><th></th>
          </tr></thead>
          <tbody>
            ${leads.map((l) => html`
              <tr data-id="${l.id}">
                <td class="c-pick"><input type="checkbox" class="pick" value="${l.id}"
                       data-ok="${l.can_email}" aria-label="Select ${l.business_name}"></td>
                <td class="c-name">
                  <span class="name">${l.business_name}</span>
                  <span class="meta">
                    ${l.location ?? '—'}${l.company_number ? html` · <span class="mono">${l.company_number}</span>` : ''}
                  </span>
                </td>
                <td>
                  ${l.email ? html`<a href="mailto:${l.email}">${l.email}</a>` : html`<span class="meta">no email</span>`}
                  ${l.phone ? html`<span class="meta mono" style="display:block">${l.phone}</span>` : ''}
                </td>
                <td class="meta">${l.category ?? '—'}</td>
                <td>
                  ${statusPill(l.status)}
                  ${!l.can_email && l.block_code !== 'NO_EMAIL'
                    ? html` <span class="flag" title="${l.block_reason}">${BLOCKED[l.block_code] ?? 'blocked'}</span>` : ''}
                </td>
                <td class="meta nw">${l.last_contacted_at ? relative(l.last_contacted_at) : '—'}</td>
                <td class="c-act">
                  ${l.can_email ? html`<button class="mini" data-act="write" data-id="${l.id}">Write</button>`
                    : l.block_code === 'UNCLASSIFIED' ? html`
                      <button class="mini" data-act="classify" data-id="${l.id}">Check</button>` : ''}
                  <button class="mini" data-act="edit" data-id="${l.id}">Edit</button>
                  <button class="mini danger" data-act="del" data-id="${l.id}"
                          data-name="${l.business_name}" aria-label="Delete">✕</button>
                </td>
              </tr>`)}
          </tbody>
        </table>
        </div>`}
    </div>
  `);

  /* ---- controls ---- */

  on(root, 'click', '[data-filter]', (_e, el) => go('status', el.dataset.filter));
  $('#sort', root)?.addEventListener('change', (e) => go('sort', e.target.value));

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

  on(root, 'click', '[data-act="add"]', async () => { if (await openLeadForm()) refresh(); });

  on(root, 'click', '[data-act="edit"]', async (_e, el) => {
    const { lead } = await api.leads.get(el.dataset.id);
    if (await openLeadForm(lead)) refresh();
  });

  on(root, 'click', '[data-act="classify"]', async (_e, el) => {
    const { lead } = await api.leads.get(el.dataset.id);
    window.open('https://find-and-update.company-information.service.gov.uk/search?q=' +
      encodeURIComponent(lead.business_name), '_blank', 'noopener');
    if (await openLeadForm(lead)) refresh();
  });

  on(root, 'click', '[data-act="del"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'Delete lead', message: `Delete ${el.dataset.name}? Sent history is kept.`,
      confirmLabel: 'Delete', danger: true,
    })) return;
    await api.leads.remove(el.dataset.id);
    toast('Deleted');
    refresh();
  });

  on(root, 'click', '[data-act="write"]', (_e, el) => { location.hash = `/compose?lead=${el.dataset.id}`; });

  /* ---- selection ---- */

  const picked = () => $$('.pick:checked', root).filter((el) => el.id !== 'pick-all');
  const sync = () => {
    const bar = $('#bulk', root);
    if (!bar) return;
    const n = picked().length;
    bar.hidden = n === 0;
    const ready = picked().filter((c) => c.dataset.ok === 'true').length;
    $('#bulk-n', root).textContent = `${n} selected${canQueue ? ` · ${ready} ready to email` : ''}`;
    for (const row of $$('.rows tbody tr', root)) {
      const box = row.querySelector('.pick');
      row.setAttribute('aria-selected', box?.checked ? 'true' : 'false');
    }
  };
  sync();

  on(root, 'change', '.pick', (ev) => {
    if (ev.target.id === 'pick-all') {
      $$('.rows tbody .pick', root).forEach((c) => { c.checked = ev.target.checked; });
    }
    sync();
  });
  on(root, 'click', '[data-act="bulk-clear"]', () => {
    $$('.pick', root).forEach((c) => { c.checked = false; });
    sync();
  });

  $('#bulk-status', root)?.addEventListener('change', async (ev) => {
    if (!ev.target.value) return;
    const ids = picked().map((c) => Number(c.value));
    await api.leads.bulkStatus(ids, ev.target.value);
    toast(`${ids.length} marked ${ev.target.value}`);
    refresh();
  });

  on(root, 'click', '[data-act="bulk-queue"]', async () => {
    const ready = picked().filter((c) => c.dataset.ok === 'true').map((c) => Number(c.value));
    if (!ready.length) return toast('None of those are ready to email', { error: true });

    const { templates } = await api.templates.list();
    if (!templates.length) return toast('Write a template first', { error: true });

    const chosen = await modal({
      title: `Queue ${ready.length} email${ready.length === 1 ? '' : 's'}`,
      body: html`
        <div class="f">
          <label for="bq">Template</label>
          <select id="bq" name="template_id">
            ${templates.map((t) => html`<option value="${t.id}">${t.name}</option>`)}
          </select>
        </div>
        <p class="tip">They go to the Outbox for review. Nothing sends until you confirm there.</p>`,
      footer: html`
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Queue</button>`,
      onSubmit: (d) => Number(d.template_id),
    });
    if (!chosen) return;

    const res = await api.post('/api/gmail/queue', { template_id: chosen, lead_ids: ready });
    toast(`Queued ${res.queued}${res.skipped.length ? ` · ${res.skipped.length} skipped` : ''}`);
    location.hash = '/outbox';
  });

  /* ---- keys ---- */

  viewKeys(root, (ev) => {
    if (ev.key === '/') { ev.preventDefault(); $('#q', root)?.focus(); }
    else if (ev.key === 'n') { ev.preventDefault(); $('[data-act="add"]', root)?.click(); }
  });
}

/** Caret position to restore after a search-triggered re-render. */
let pendingCaret = null;

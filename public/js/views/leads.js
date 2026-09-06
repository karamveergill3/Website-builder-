/* Lead list: stat tiles, status filter pills, search, and row actions. */
import { api } from '../api.js';
import {
  html, mount, on, $, $$, modal, confirmDialog, toast,
  statusPill, fmtDate, relative,
} from '../dom.js';

const STATUSES = ['new', 'sent', 'replied', 'won', 'lost'];

const FIELDS = [
  { name: 'business_name', label: 'Business name', required: true, width: 'full' },
  { name: 'category',      label: 'Category',      placeholder: 'e.g. roofers' },
  { name: 'location',      label: 'Location',      placeholder: 'e.g. Leeds' },
  { name: 'phone',         label: 'Phone',         type: 'tel' },
  { name: 'email',         label: 'Email',         type: 'email' },
  { name: 'source',        label: 'Source',        placeholder: 'e.g. Google Places, referral' },
];

export function leadFormFields(lead = {}) {
  return html`
    <div class="field">
      <label for="f-business_name">Business name <span class="opt">(required)</span></label>
      <input id="f-business_name" name="business_name" type="text" required
             value="${lead.business_name ?? ''}" autocomplete="off">
    </div>
    <div class="grid2">
      ${FIELDS.filter((f) => f.width !== 'full').map((f) => html`
        <div class="field">
          <label for="f-${f.name}">${f.label}</label>
          <input id="f-${f.name}" name="${f.name}" type="${f.type ?? 'text'}"
                 value="${lead[f.name] ?? ''}" placeholder="${f.placeholder ?? ''}" autocomplete="off">
        </div>`)}
    </div>
    <div class="grid2">
      <div class="field">
        <label for="f-status">Status</label>
        <select id="f-status" name="status">
          ${STATUSES.map((s) => html`
            <option value="${s}" ${lead.status === s ? 'selected' : ''}>${s}</option>`)}
        </select>
      </div>
      <div class="field">
        <label for="f-google_place_id">Google place ID <span class="opt">(optional)</span></label>
        <input id="f-google_place_id" name="google_place_id" type="text" class="mono"
               value="${lead.google_place_id ?? ''}" autocomplete="off">
      </div>
    </div>
    <div class="field">
      <label for="f-notes">Notes</label>
      <textarea id="f-notes" name="notes" rows="4">${lead.notes ?? ''}</textarea>
    </div>
    <div class="check">
      <input id="f-opted_out" name="opted_out" type="checkbox" ${lead.opted_out ? 'checked' : ''}>
      <label for="f-opted_out">
        Opted out — never email this business again
        <span class="hint" style="font-weight:400">
          Hard-excluded from every send, including bulk sends. Required by PECR once someone asks to stop.
        </span>
      </label>
    </div>`;
}

/** FormData gives '' for empty inputs and 'on'/absent for checkboxes. */
export function leadFormToBody(data) {
  return {
    business_name: data.business_name,
    category: data.category,
    location: data.location,
    phone: data.phone,
    email: data.email,
    source: data.source,
    status: data.status,
    google_place_id: data.google_place_id,
    notes: data.notes,
    opted_out: data.opted_out === 'on',
  };
}

export async function openLeadForm(lead) {
  const editing = Boolean(lead?.id);
  return modal({
    title: editing ? `Edit ${lead.business_name}` : 'Add a lead',
    body: leadFormFields(lead ?? { status: 'new' }),
    footer: html`
      <button type="button" data-close>Cancel</button>
      <button type="submit" class="primary">${editing ? 'Save changes' : 'Add lead'}</button>`,
    onSubmit: async (data) => {
      const body = leadFormToBody(data);
      const saved = editing
        ? await api.leads.update(lead.id, body)
        : await api.leads.create(body);
      toast(editing ? 'Lead updated' : `Added ${saved.lead.business_name}`);
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

  const setParam = (key, value) => {
    const next = new URLSearchParams({ status, q, sort });
    if (value === null || value === '' || value === 'all') next.delete(key);
    else next.set(key, value);
    const s = next.toString();
    location.hash = `/leads${s ? `?${s}` : ''}`;
  };

  mount(root, html`
    <div class="stats">
      <div class="stat" data-tone="total"><span class="n num">${stats.total}</span><span class="k">Total leads</span></div>
      <div class="stat" data-tone="sent"><span class="n num">${stats.awaiting_reply}</span><span class="k">Awaiting reply</span></div>
      <div class="stat" data-tone="replied"><span class="n num">${stats.replied}</span><span class="k">Replied</span></div>
      <div class="stat" data-tone="won"><span class="n num">${stats.won}</span><span class="k">Won</span></div>
      <div class="stat" data-tone="muted"><span class="n num">${stats.emailable}</span><span class="k">Emailable</span></div>
    </div>

    <div class="view-head">
      <div>
        <h2>Leads</h2>
        <p class="lede">Every business you are tracking, from first contact through to a signed job.</p>
      </div>
      <div class="spacer"></div>
      <button class="primary" data-act="add">+ Add lead</button>
    </div>

    <div class="pillbar">
      <button class="pill" data-filter="all" aria-pressed="${status === 'all'}">
        All <span class="count num">${stats.total}</span></button>
      ${STATUSES.map((s) => html`
        <button class="pill" data-filter="${s}" aria-pressed="${status === s}">
          ${s} <span class="count num">${stats.by_status[s] ?? 0}</span></button>`)}
      <div style="flex:1"></div>
      <input type="search" id="q" placeholder="Search name, town, notes…" value="${q}"
             style="max-width:250px" autocomplete="off">
      <select id="sort" style="max-width:170px">
        <option value="created"   ${sort === 'created'   ? 'selected' : ''}>Newest first</option>
        <option value="oldest"    ${sort === 'oldest'    ? 'selected' : ''}>Oldest first</option>
        <option value="name"      ${sort === 'name'      ? 'selected' : ''}>Name A–Z</option>
        <option value="contacted" ${sort === 'contacted' ? 'selected' : ''}>Last contacted</option>
      </select>
    </div>

    ${stats.opted_out > 0 && status === 'all' ? html`
      <div class="note note-info" style="margin-bottom:14px">
        <div>${stats.opted_out} lead${stats.opted_out === 1 ? ' has' : 's have'} opted out.
        They are hard-excluded from every send.</div>
      </div>` : ''}

    <div id="bulkbar" hidden class="note note-info"
         style="margin-bottom:14px;align-items:center;gap:12px">
      <strong id="bulk-count" style="flex:1"></strong>
      <select id="bulk-status" style="max-width:170px">
        <option value="">Set status…</option>
        ${STATUSES.map((s) => html`<option value="${s}">${s}</option>`)}
      </select>
      ${canQueue ? html`<button class="primary" data-act="bulk-queue">Queue emails</button>` : ''}
      <button class="tiny" data-act="bulk-clear">Clear</button>
    </div>

    <div class="card">
      ${leads.length === 0 ? html`
        <div class="empty">
          <h3>${q || status !== 'all' ? 'No leads match that filter' : 'No leads yet'}</h3>
          <p>${q || status !== 'all'
              ? 'Try clearing the search or picking a different status.'
              : 'Add one by hand, or use Find leads to search Google Places for businesses with no website.'}</p>
          ${!q && status === 'all' ? html`<p style="margin-top:14px">
            <button class="primary" data-act="add">+ Add your first lead</button></p>` : ''}
        </div>` : html`
        <div class="table-scroll">
        <table class="ledger">
          <thead><tr>
            <th style="width:32px"><input type="checkbox" id="pick-all"
                  style="width:15px;height:15px;accent-color:var(--green)" aria-label="Select all"></th>
            <th>Business</th><th>Category</th><th>Location</th><th>Contact</th>
            <th>Status</th><th class="nowrap">Last contacted</th><th></th>
          </tr></thead>
          <tbody>
            ${leads.map((l) => html`
              <tr data-id="${l.id}">
                <td><input type="checkbox" class="pick" value="${l.id}"
                           data-emailable="${!l.opted_out && Boolean(l.email)}"
                           style="width:15px;height:15px;accent-color:var(--green)"
                           aria-label="Select ${l.business_name}"></td>
                <td>
                  <span class="biz">${l.business_name}</span>
                  <span class="sub">${fmtDate(l.created_at)}${l.source ? ` · ${l.source}` : ''}</span>
                  ${l.opted_out ? html`<div style="margin-top:5px"><span class="tag">opted out</span></div>` : ''}
                </td>
                <td class="sub">${l.category ?? '—'}</td>
                <td class="sub">${l.location ?? '—'}</td>
                <td class="sub">
                  ${l.email ? html`<a href="mailto:${l.email}">${l.email}</a><br>` : ''}
                  ${l.phone ? html`<span class="mono">${l.phone}</span>` : (l.email ? '' : '—')}
                </td>
                <td>${statusPill(l.status)}</td>
                <td class="sub nowrap">
                  ${l.last_contacted_at ? html`${fmtDate(l.last_contacted_at)}<br>
                    <span style="opacity:.7">${relative(l.last_contacted_at)}</span>` : '—'}
                </td>
                <td>
                  <div class="rowactions">
                    ${l.email && !l.opted_out ? html`
                      <button class="tiny" data-act="compose" data-id="${l.id}" title="Write to this lead">Write</button>` : ''}
                    <button class="tiny" data-act="edit" data-id="${l.id}">Edit</button>
                    <button class="tiny danger" data-act="delete" data-id="${l.id}"
                            data-name="${l.business_name}" title="Delete">✕</button>
                  </div>
                </td>
              </tr>`)}
          </tbody>
        </table>
        </div>`}
    </div>
    ${leads.length ? html`<p class="hint" style="margin-top:10px">
      Showing ${leads.length} lead${leads.length === 1 ? '' : 's'}.</p>` : ''}
  `);

  on(root, 'click', '[data-filter]', (_e, el) => setParam('status', el.dataset.filter));

  const search = $('#q', root);
  let timer;
  search?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const pos = search.selectionStart;
      setParam('q', search.value.trim());
      // Re-focus after the route re-render so typing is not interrupted.
      setTimeout(() => {
        const next = $('#q');
        if (next) { next.focus(); next.setSelectionRange(pos, pos); }
      }, 0);
    }, 320);
  });
  $('#sort', root)?.addEventListener('change', (ev) => setParam('sort', ev.target.value));

  on(root, 'click', '[data-act="add"]', async () => {
    if (await openLeadForm()) refresh();
  });

  on(root, 'click', '[data-act="edit"]', async (_e, el) => {
    const { lead } = await api.leads.get(el.dataset.id);
    if (await openLeadForm(lead)) refresh();
  });

  on(root, 'click', '[data-act="delete"]', async (_e, el) => {
    const ok = await confirmDialog({
      title: 'Delete lead',
      message: `Permanently delete "${el.dataset.name}"? Any sent-email history for this lead is kept in the sent log.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await api.leads.remove(el.dataset.id);
    toast('Lead deleted');
    refresh();
  });

  on(root, 'click', '[data-act="compose"]', (_e, el) => {
    location.hash = `/compose?lead=${el.dataset.id}`;
  });

  /* ---- multi-select ---- */

  const picked = () => $$('.pick:checked', root);
  const syncBulk = () => {
    const bar = $('#bulkbar', root);
    if (!bar) return;
    const n = picked().length;
    bar.hidden = n === 0;
    bar.style.display = n === 0 ? 'none' : 'flex';
    const emailable = picked().filter((c) => c.dataset.emailable === 'true').length;
    $('#bulk-count', root).textContent =
      `${n} selected` + (canQueue ? ` · ${emailable} can be emailed` : '');
  };

  on(root, 'change', '.pick', syncBulk);
  $('#pick-all', root)?.addEventListener('change', (ev) => {
    $$('.pick', root).forEach((c) => { c.checked = ev.target.checked; });
    syncBulk();
  });
  on(root, 'click', '[data-act="bulk-clear"]', () => {
    $$('.pick', root).forEach((c) => { c.checked = false; });
    const all = $('#pick-all', root);
    if (all) all.checked = false;
    syncBulk();
  });

  $('#bulk-status', root)?.addEventListener('change', async (ev) => {
    const next = ev.target.value;
    if (!next) return;
    const ids = picked().map((c) => Number(c.value));
    await api.leads.bulkStatus(ids, next);
    toast(`${ids.length} lead(s) marked ${next}`);
    refresh();
  });

  on(root, 'click', '[data-act="bulk-queue"]', async () => {
    const emailable = picked().filter((c) => c.dataset.emailable === 'true').map((c) => Number(c.value));
    if (emailable.length === 0) {
      toast('None of those have an email address, or they have opted out', { error: true });
      return;
    }
    const { templates } = await api.templates.list();
    if (!templates.length) { toast('Write a template first', { error: true }); return; }

    const chosen = await modal({
      title: `Queue ${emailable.length} email${emailable.length === 1 ? '' : 's'}`,
      body: html`
        <div class="field">
          <label for="bq-template">Template</label>
          <select id="bq-template" name="template_id">
            ${templates.map((t) => html`<option value="${t.id}">${t.name}</option>`)}
          </select>
        </div>
        <p class="hint">
          These go to the Outbox for review. Nothing is sent until you read them there
          and confirm.
        </p>`,
      footer: html`
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Queue for review</button>`,
      onSubmit: (data) => Number(data.template_id),
    });
    if (!chosen) return;

    const res = await api.post('/api/gmail/queue', { template_id: chosen, lead_ids: emailable });
    toast(`Queued ${res.queued}` + (res.skipped.length ? ` · ${res.skipped.length} skipped` : ''));
    location.hash = '/outbox';
  });
}

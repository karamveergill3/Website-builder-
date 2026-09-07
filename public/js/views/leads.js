/* The lead list: the screen this tool is actually used from. */
import { api } from '../api.js';
import {
  html, mount, on, $, $$, modal, confirmDialog, toast,
  statusPill, relative, viewKeys, registerInterval,
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

  const view = params.view ?? '';
  const [{ leads: allLeads }, stats, gmail, ch] = await Promise.all([
    api.leads.list({ status, q, sort, limit: 1000 }),
    api.leads.stats(),
    api.get('/api/gmail/status').catch(() => null),
    api.get('/api/companies/status').catch(() => null),
  ]);
  const canQueue = gmail?.connected === true;
  const canCheck = ch?.configured === true;

  // Working views: what needs doing, rather than what state it is in.
  const VIEWS = {
    unchecked: (l) => l.block_code === 'UNCLASSIFIED',
    noemail:   (l) => l.can_email === false && l.block_code === 'NO_EMAIL',
    nosite:    (l) => l.has_website === 0,
    // "Ready" has to mean ready to APPROACH. It meant "lawful to email",
    // which is a different question, so every lead emailed yesterday counted
    // as ready again this morning — and the bulk queue took the lot.
    ready:     (l) => l.can_email === true && l.can_contact === true,
    contacted: (l) => l.contacted_before === true,
  };
  const leads = view && VIEWS[view] ? allLeads.filter(VIEWS[view]) : allLeads;
  const counts = Object.fromEntries(
    Object.entries(VIEWS).map(([k, f]) => [k, allLeads.filter(f).length])
  );

  // Whether the screen is showing a subset. It decides what "delete" means:
  // deleting what you can see is the only reading that cannot surprise you.
  const filtered = Boolean(q) || status !== 'all' || Boolean(view);

  const go = (key, value) => {
    const next = new URLSearchParams({ status, q, sort, view });
    if (!value || value === 'all') next.delete(key); else next.set(key, value);
    for (const [k, v] of [...next]) if (!v) next.delete(k);
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
        ${(counts.unchecked || counts.noemail || counts.nosite || view) ? html`<span class="sep"></span>` : ''}
        ${counts.ready ? html`
          <button class="pill" data-view="ready" aria-pressed="${view === 'ready'}">ready <b>${counts.ready}</b></button>` : ''}
        ${counts.contacted ? html`
          <button class="pill" data-view="contacted" aria-pressed="${view === 'contacted'}"
            title="Already approached — these are not fresh targets">done <b>${counts.contacted}</b></button>` : ''}
        ${counts.unchecked ? html`
          <button class="pill" data-view="unchecked" aria-pressed="${view === 'unchecked'}">unchecked <b>${counts.unchecked}</b></button>` : ''}
        ${counts.noemail ? html`
          <button class="pill" data-view="noemail" aria-pressed="${view === 'noemail'}">no email <b>${counts.noemail}</b></button>` : ''}
        ${counts.nosite ? html`
          <button class="pill" data-view="nosite" aria-pressed="${view === 'nosite'}">no website <b>${counts.nosite}</b></button>` : ''}
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
      ${leads.length ? html`
        <button class="danger" data-act="wipe"
          title="${filtered ? 'Delete the leads this filter is showing' : 'Delete every lead'}"
          >${filtered ? `Delete these ${leads.length}` : 'Delete all'}</button>` : ''}
    </div>

    <div id="bulk" hidden class="bar" style="background:var(--green-lift);border:1px solid #bcd0c0;
         border-radius:var(--r-sm);padding:5px 10px;margin-bottom:10px">
      <b id="bulk-n" style="font-size:.8rem"></b>
      <div class="grow"></div>
      <select id="bulk-status" style="max-width:150px">
        <option value="">Set status…</option>
        ${STATUSES.map((s) => html`<option value="${s}">${s}</option>`)}
      </select>
      ${canCheck ? html`<button data-act="bulk-check">Check register</button>` : ''}
      <button data-act="paste-emails">Paste emails</button>
      <button data-act="bulk-site">Check websites</button>
      ${canQueue ? html`<button class="primary" data-act="bulk-queue">Queue emails</button>` : ''}
      <button data-act="bulk-find">Find contacts</button>
      <button class="danger" data-act="bulk-del">Delete</button>
      <button class="mini ghost" data-act="bulk-clear">Clear</button>
    </div>

    <div class="panel">
      ${leads.length === 0 ? html`
        <div class="blank">
          <strong>${q || status !== 'all' ? 'Nothing matches' : 'No leads yet'}</strong>
          ${q || status !== 'all' ? 'Try another filter.' : html`
            Set up the <a href="#/hunt">daily hunt</a> to find them for you,
            <a href="#/find">search the register</a> yourself, or add one by hand.`}
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
                       data-ok="${l.can_email && l.can_contact}"
                       data-contacted="${l.contacted_before === true}"
                       aria-label="Select ${l.business_name}"></td>
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
                <td class="meta">${l.category ?? '—'}
                  ${l.has_website === 0 ? html`<span class="flag" data-ok
                        title="Google returned no website">no site</span>` : ''}</td>
                <td>
                  ${statusPill(l.status)}
                  ${!l.can_email && l.block_code !== 'NO_EMAIL'
                    ? html` <span class="flag" title="${l.block_reason}">${BLOCKED[l.block_code] ?? 'blocked'}</span>` : ''}
                </td>
                <td class="meta nw">
                  ${l.contacted_at ? relative(l.contacted_at) : '—'}
                  ${l.contacted_before && !l.can_contact ? html`
                    <span class="flag" title="${l.contact_block_reason}"
                      >done${l.contacted_via ? ` · ${l.contacted_via}` : ''}</span>` : ''}
                </td>
                <td class="c-act">
                  ${l.can_email && l.can_contact
                    ? html`<button class="mini" data-act="write" data-id="${l.id}">Write</button>` : ''}
                  <button class="mini${l.can_contact ? '' : ' ghost'}" data-act="reach" data-id="${l.id}"
                          title="${l.can_contact
                            ? 'WhatsApp, SMS, call — or find contact details'
                            : l.contact_block_reason}">Reach</button>
                  ${l.block_code === 'UNCLASSIFIED' ? html`
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
  on(root, 'click', '[data-view]', (_e, el) => go('view', view === el.dataset.view ? '' : el.dataset.view));
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
    if (!canCheck) {
      const { lead } = await api.leads.get(el.dataset.id);
      window.open('https://find-and-update.company-information.service.gov.uk/search?q=' +
        encodeURIComponent(lead.business_name), '_blank', 'noopener');
      if (await openLeadForm(lead)) refresh();
      return;
    }
    if (await openRegisterDialog(el.dataset.id)) refresh();
  });

  on(root, 'click', '[data-act="reach"]', async (_e, el) => {
    const { openReachDialog } = await import('./reach.js');
    await openReachDialog(el.dataset.id);
    refresh();
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

  /**
   * Delete a batch of leads.
   *
   * The two things that survive are the point of the dialog, not small print:
   * an opt-out stays blocked, and a company already approached stays on the
   * no-repeat list. What the tick changes is only the companies never
   * contacted — those can be forgotten, so tomorrow's hunt is allowed to find
   * them again. Without the tick, clearing the list quietly retires every
   * business on it for good.
   */
  async function wipe({ ids, all, count }) {
    const what = all ? `all ${count} leads` : `${count} lead${count === 1 ? '' : 's'}`;
    const answer = await modal({
      title: all ? 'Delete every lead' : `Delete ${count} lead${count === 1 ? '' : 's'}`,
      body: html`
        <p style="margin:0 0 10px">This deletes ${what}. It cannot be undone.</p>
        <p class="tip" style="margin:0 0 12px">
          Two records outlive the rows on purpose: anyone opted out stays blocked,
          and any company already approached stays on the do-not-approach-again
          list. Sent history is kept.
        </p>
        <div class="check">
          <input id="f-forget" name="forget" type="checkbox">
          <label for="f-forget">Let the hunt find these businesses again
            <span class="tip" style="display:block;font-weight:400">
              Clears the "already found" record for the ones you have never
              contacted, so they can come back on a future run. Anyone you have
              already messaged stays blocked either way.</span></label>
        </div>`,
      footer: html`
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="danger">Delete ${count}</button>`,
      // modal() focuses the first field, which here is the tick box — and
      // Enter on a focused checkbox submits the form. On a dialog that empties
      // the list, the key you press without thinking must not be the one that
      // does it. The microtask runs after modal()'s own focus call.
      onMount: (r) => queueMicrotask(() => r.querySelector('[data-close]')?.focus()),
      onSubmit: (d) => ({ forget: Boolean(d.forget) }),
    });
    if (!answer) return;

    const res = await api.leads.bulkDelete({
      ...(all ? { all: true } : { ids }),
      forget: answer.forget,
    });
    toast(`Deleted ${res.deleted}`
      + (res.forgotten ? ` · ${res.forgotten} can be found again` : '')
      + (res.kept ? ` · ${res.kept} stay blocked, already approached` : ''),
      { ms: 6000 });
    refresh();
  }

  on(root, 'click', '[data-act="wipe"]', () => wipe(filtered
    ? { ids: leads.map((l) => l.id), count: leads.length }
    : { all: true, count: stats.total }));

  on(root, 'click', '[data-act="bulk-del"]', () => {
    const ids = picked().map((c) => Number(c.value));
    if (!ids.length) return toast('Pick some leads first', { error: true });
    return wipe({ ids, count: ids.length });
  });

  on(root, 'click', '[data-act="write"]', (_e, el) => { location.hash = `/compose?lead=${el.dataset.id}`; });

  /* ---- selection ---- */

  const picked = () => $$('.pick:checked', root).filter((el) => el.id !== 'pick-all');
  const sync = () => {
    const bar = $('#bulk', root);
    if (!bar) return;
    const n = picked().length;
    bar.hidden = n === 0;
    const chosen = picked();
    const ready = chosen.filter((c) => c.dataset.ok === 'true').length;
    // Say why the numbers differ. "20 selected · 3 ready to email" with no
    // explanation reads as a bug; the reason is that seventeen of them have
    // already had their approach.
    const done = chosen.filter((c) => c.dataset.contacted === 'true').length;
    $('#bulk-n', root).textContent = n + ' selected'
      + (canQueue ? ` · ${ready} ready to email` : '')
      + (done ? ` · ${done} already approached` : '');
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
  /**
   * Look up phone numbers and emails for the selected leads.
   *
   * The hunt files companies Google has never heard of, and those arrive
   * with nothing to contact them by. This searches directory listings — Yell,
   * Facebook, Checkatrade — which is the only remaining source once a
   * business has no website and no Google entry.
   *
   * Slow on purpose: the finder waits between requests so it reads like a
   * person rather than a scraper, so this is a background job with progress
   * rather than something to wait on.
   */
  on(root, 'click', '[data-act="bulk-find"]', async (_e, btn) => {
    const ids = picked().map((c) => Number(c.value));
    if (!ids.length) return toast('Pick some leads first', { error: true });

    const mins = Math.max(1, Math.ceil((ids.length * 5) / 60));
    const go = await confirmDialog({
      title: `Find contacts for ${ids.length} lead${ids.length === 1 ? '' : 's'}`,
      message: 'Searches public directory listings for a phone number or an '
        + 'email. It is deliberately unhurried — roughly five seconds a lead, '
        + `so this will take about ${mins} minute${mins === 1 ? '' : 's'}. `
        + 'Nothing is sent to anyone; it only reads pages that are already '
        + 'public.',
      confirmLabel: 'Start looking',
    });
    if (!go) return;

    btn.disabled = true;
    try {
      const res = await api.post('/api/leads/find-contacts', { lead_ids: ids });
      if (!res.started) return toast(res.reason ?? 'Nothing to look up');
      toast(`Looking up ${res.total}…`);

      // Poll until it finishes, then refresh so the new numbers show.
      const tick = setInterval(async () => {
        const { sweep } = await api.get('/api/leads/find-contacts/status');
        if (!sweep) return;
        const bar = $('#bulk-n', root);
        if (bar && sweep.running) {
          bar.textContent = `Looking up ${sweep.done} of ${sweep.total}…`;
        }
        if (!sweep.running) {
          clearInterval(tick);
          toast(`Found a phone for ${sweep.found_phone}, an email for ${sweep.found_email}`
            + `, nothing for ${sweep.none}`);
          refresh();
        }
      }, 1500);
      registerInterval(tick);
    } catch (err) {
      toast(err.message ?? 'Could not start', { error: true });
    } finally {
      btn.disabled = false;
    }
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

  on(root, 'click', '[data-act="paste-emails"]', async () => {
    const done = await modal({
      title: 'Paste in email addresses',
      wide: true,
      body: html`
        <div class="f">
          <label for="paste">One per line: business name, then the address</label>
          <textarea id="paste" name="text" class="code" rows="10" required
            placeholder="Crown Joinery, info@crownjoinery.co.uk&#10;Calder Groundworks  hello@caldergroundworks.co.uk"></textarea>
          <p class="tip">Comma, semicolon or tab separated, either order. Names are matched loosely.</p>
        </div>`,
      footer: html`
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Match and save</button>`,
      onSubmit: async (d) => {
        const res = await api.post('/api/leads/import-emails', { text: d.text });
        if (!res.matched && (res.unmatched.length || res.invalid.length)) {
          throw new Error(`Nothing matched. First problem: ${(res.unmatched[0] ?? res.invalid[0]).reason}`);
        }
        toast(`Updated ${res.matched}` +
          (res.unmatched.length + res.invalid.length
            ? ` · ${res.unmatched.length + res.invalid.length} not matched` : ''),
          { ms: 6000 });
        return true;
      },
    });
    if (done) refresh();
  });

  on(root, 'click', '[data-act="bulk-check"]', async () => {
    if (!await confirmDialog({
      title: 'Check the register',
      message: `Look up every unchecked lead on Companies House (${counts.unchecked || stats.unclassified}). ` +
               'Clear matches are applied; anything doubtful is left for you.',
      confirmLabel: 'Check them',
    })) return;
    try {
      await api.post('/api/companies/qualify-all');
    } catch (err) { return toast(err.message, { error: true, ms: 7000 }); }

    const poller = registerInterval(setInterval(async () => {
      const { run } = await api.get('/api/companies/qualify-all/status');
      if (!run) { clearInterval(poller); return; }
      toast(`Checked ${run.done}/${run.total} — ${run.matched} matched`, { ms: 1400 });
      if (!run.running) {
        clearInterval(poller);
        toast(`Done: ${run.matched} companies, ${run.ambiguous} need a look`, { ms: 6000 });
        refresh();
      }
    }, 1500));
  });

  on(root, 'click', '[data-act="bulk-site"]', async (_e, btn) => {
    const ids = picked().map((c) => Number(c.value));
    if (!ids.length) return toast('Select some leads first', { error: true });
    if (!await confirmDialog({
      title: 'Check for websites',
      message: `One billed Google lookup each for ${ids.length} lead(s). Only the yes/no answer is kept.`,
      confirmLabel: 'Check',
    })) return;
    btn.disabled = true;
    try {
      const res = await api.post('/api/places/check-website', { lead_ids: ids });
      toast(`${res.without_website} of ${res.checked} have no website`, { ms: 6000 });
      refresh();
    } catch (err) {
      toast(err.message, { error: true, ms: 7000 });
      btn.disabled = false;
    }
  });

  on(root, 'click', '[data-act="bulk-queue"]', async () => {
    const ready = picked().filter((c) => c.dataset.ok === 'true').map((c) => Number(c.value));
    if (!ready.length) {
      const done = picked().filter((c) => c.dataset.contacted === 'true').length;
      return toast(done
        ? `All ${done} of those have already been approached`
        : 'None of those are ready to email', { error: true });
    }

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

/**
 * Pick the right register entry for a lead. Deliberately a human decision:
 * a wrong match means sending unlawful marketing to a sole trader.
 */
export async function openRegisterDialog(leadId) {
  let data;
  try {
    data = await api.get(`/api/companies/lookup/${leadId}`);
  } catch (err) {
    toast(err.message, { error: true, ms: 7000 });
    return false;
  }

  const rows = data.candidates;
  const search = `https://find-and-update.company-information.service.gov.uk/search?q=${
    encodeURIComponent(data.lead.business_name)}`;

  return modal({
    title: data.lead.business_name,
    wide: true,
    body: rows.length === 0 ? html`
      <div class="blank">
        <strong>Nothing on the register matches that name</strong>
        Most likely a sole trader, which cannot be cold-emailed.
        <p style="margin-top:10px"><a href="${search}" target="_blank" rel="noopener">Search Companies House yourself ↗</a></p>
      </div>` : html`
      <div class="scroll-x" style="max-height:340px;overflow-y:auto">
        <table class="rows">
          <thead><tr><th class="c-pick"></th><th>Company</th><th>Registered office</th>
            <th class="nw">No.</th><th>Type</th></tr></thead>
          <tbody>
            ${rows.map((c, i) => html`
              <tr>
                <td class="c-pick"><input type="radio" name="company_number" value="${c.company_number}"
                       ${i === 0 && c.sendable ? 'checked' : ''} ${c.sendable ? '' : 'disabled'}
                       style="accent-color:var(--green)"></td>
                <td class="c-name"><span class="name" style="font-size:.9rem">${c.company_name}</span>
                  <span class="meta">${Math.round(c.score * 100)}% name match${
                    c.company_number === data.auto ? ' · clear match' : ''}</span></td>
                <td class="meta">${c.address_snippet ?? '—'}</td>
                <td class="meta mono nw">${c.company_number}</td>
                <td>${c.sendable
                  ? html`<span class="flag" data-ok>${c.company_type}</span>`
                  : html`<span class="flag" title="${c.trading ? 'Not a body corporate' : c.company_status}">${
                      c.trading ? c.company_type : c.company_status}</span>`}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>
      <p class="tip">
        Only bodies corporate can be cold-emailed. Nothing here?
        <a href="${search}" target="_blank" rel="noopener">Search Companies House ↗</a>
      </p>`,
    footer: html`
      <button type="button" data-close>Cancel</button>
      <button type="button" class="danger" data-sole>No match — sole trader</button>
      <div class="grow"></div>
      ${rows.some((c) => c.sendable) ? html`<button type="submit" class="primary">Attach</button>` : ''}`,
    onMount: (dlg, close) => {
      dlg.querySelector('[data-sole]')?.addEventListener('click', async () => {
        await api.post('/api/companies/mark-sole-trader', { lead_id: leadId });
        toast('Marked as a sole trader — cannot be emailed');
        close(true);
      });
    },
    onSubmit: async (d) => {
      if (!d.company_number) throw new Error('Pick a company, or mark it a sole trader.');
      const res = await api.post('/api/companies/attach', {
        lead_id: leadId, company_number: d.company_number,
      });
      toast(res.sendable ? 'Matched — you can email this one' : 'Matched, but not a body corporate');
      return true;
    },
  });
}

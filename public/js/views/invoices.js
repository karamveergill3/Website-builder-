/* Invoices: raise them, send the client a link, track what's paid. */
import { api } from '../api.js';
import { html, mount, on, $, $$, modal, confirmDialog, toast, statusPill, relative } from '../dom.js';

const gbp = (pence) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })
  .format((Number(pence) || 0) / 100);

const clientLink = (inv) => `${location.origin}/i/${inv.token}`;

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure ctx */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove(); return ok;
}

/* --------------------------------------------------------- create invoice */

async function openInvoiceForm(clients, { presetClientId } = {}) {
  const lineRow = (l = {}) => `
    <tr class="line">
      <td><input class="l-desc" type="text" value="${l.description ?? ''}" placeholder="One-page website design & build"></td>
      <td style="width:70px"><input class="l-qty" type="number" min="1" value="${l.qty ?? 1}" style="width:60px"></td>
      <td style="width:110px"><input class="l-unit" type="number" min="0" step="0.01" value="${l.unit ?? ''}" placeholder="0.00" style="width:100px"></td>
      <td class="num l-amt" style="width:90px">£0.00</td>
      <td style="width:28px"><button type="button" class="mini ghost l-del" title="Remove">✕</button></td>
    </tr>`;

  return modal({
    title: 'New invoice',
    wide: true,
    body: html`
      <div class="cols">
        <div class="f">
          <label for="iv-client">Client</label>
          <select id="iv-client" name="client_id">
            <option value="">— new client (type below) —</option>
            ${clients.map((c) => html`<option value="${c.id}" ${String(c.id) === String(presetClientId) ? 'selected' : ''}>${c.name}</option>`)}
          </select>
        </div>
        <div class="f">
          <label for="iv-kind">Type</label>
          <select id="iv-kind" name="kind">
            <option value="build">Website build</option>
            <option value="maintenance">Maintenance (one-off)</option>
          </select>
        </div>
        <div class="f">
          <label for="iv-deposit">Deposit</label>
          <select id="iv-deposit" name="deposit_mode">
            <option value="none">No deposit (full amount)</option>
            <option value="half-invoice">50% deposit invoice (send first)</option>
            <option value="final-half">Final invoice (50% deposit already paid)</option>
          </select>
        </div>
      </div>
      <div id="iv-newclient" class="panel" style="padding:10px;margin-bottom:10px" hidden>
        <div class="cols">
          <div class="f"><label>Business name</label><input id="nc-name" type="text" placeholder="Bloom Nails Ltd"></div>
          <div class="f"><label>Contact email <span class="opt">optional</span></label><input id="nc-email" type="email"></div>
        </div>
        <div class="f"><label>Address <span class="opt">optional</span></label><input id="nc-address" type="text"></div>
      </div>

      <label style="font-size:.8rem;font-weight:600">Lines</label>
      <table class="rows" style="margin-top:4px"><thead><tr>
        <th>Description</th><th>Qty</th><th>Unit £</th><th class="num">Amount</th><th></th>
      </tr></thead><tbody id="iv-lines"></tbody></table>
      <button type="button" class="mini" id="iv-addline" style="margin-top:6px">+ Add line</button>

      <div class="f" style="margin-top:12px"><label for="iv-notes">Note on the invoice <span class="opt">optional</span></label>
        <input id="iv-notes" name="notes" type="text" placeholder="Website build for Bloom Nails"></div>
      <div class="cols">
        <div class="f"><label for="iv-due">Due date <span class="opt">optional</span></label>
          <input id="iv-due" name="due_at" type="date"></div>
        <div class="f" style="align-self:end;text-align:right">
          <div class="meta">Total</div><div class="num" id="iv-total" style="font-size:1.4rem;font-weight:700">£0.00</div></div>
      </div>`,
    footer: html`<button type="button" data-close>Cancel</button>
      <button type="submit" class="primary">Create invoice</button>`,
    onMount: (root) => {
      const lines = $('#iv-lines', root);
      // Injected here rather than in the html`` template, which escapes an
      // interpolated string — so the row would render as literal text.
      // A build is pre-itemised so the invoice shows the full scope of work,
      // not one vague line. Price the ones you're charging for and delete the
      // rest; a blank-priced row is dropped on save, so nothing shows at £0.
      const BUILD_ITEMS = [
        'Bespoke one-page website, designed and built',
        'Mobile and tablet optimisation',
        'Click-to-call, WhatsApp and enquiry buttons',
        'Google and on-page SEO setup',
        'Business email and domain setup',
        'Secure hosting and SSL certificate (first year)',
        'Testing, launch and handover',
      ];
      for (const d of BUILD_ITEMS) lines.insertAdjacentHTML('beforeend', lineRow({ description: d }));
      const recalc = () => {
        let total = 0;
        for (const tr of $$('.line', root)) {
          const qty = Number(tr.querySelector('.l-qty').value) || 0;
          const unit = Number(tr.querySelector('.l-unit').value) || 0;
          const amt = Math.round(qty * unit * 100);
          tr.querySelector('.l-amt').textContent = gbp(amt);
          total += amt;
        }
        $('#iv-total', root).textContent = gbp(total);
      };
      on(root, 'input', '.l-qty, .l-unit', recalc);
      on(root, 'click', '.l-del', (_e, el) => {
        if ($$('.line', root).length > 1) { el.closest('.line').remove(); recalc(); }
      });
      $('#iv-addline', root).addEventListener('click', () => {
        lines.insertAdjacentHTML('beforeend', lineRow());
        recalc();
      });
      const clientSel = $('#iv-client', root);
      const syncNewClient = () => { $('#iv-newclient', root).hidden = Boolean(clientSel.value); };
      clientSel.addEventListener('change', syncNewClient);
      syncNewClient(); // show the new-client fields when none is preselected
      recalc();
    },
    onSubmit: async (d, root) => {
      let lines = $$('.line', root).map((tr) => ({
        description: tr.querySelector('.l-desc').value.trim(),
        qty: Number(tr.querySelector('.l-qty').value) || 1,
        unit_pounds: tr.querySelector('.l-unit').value,
      })).filter((l) => l.description && l.unit_pounds !== '');
      if (!lines.length) throw new Error('Add at least one line with a description and price.');

      // Deposit flow. The full job total (before VAT) drives the 50% split.
      const subPence = lines.reduce((n, l) =>
        n + Math.round((Number(l.qty) || 1) * (Number(l.unit_pounds) || 0) * 100), 0);
      let deposit_pounds;
      let notes = d.notes;
      if (d.deposit_mode === 'half-invoice') {
        // The first invoice: just the 50% deposit, as one clear line.
        const half = Math.round(subPence / 2);
        lines = [{ description: '50% deposit for your website (balance due on completion)',
                   qty: 1, unit_pounds: (half / 100).toFixed(2) }];
        notes = notes || 'This is the 50% deposit to begin the work. The balance is invoiced on completion.';
      } else if (d.deposit_mode === 'final-half') {
        // The final invoice: full itemised total, with the 50% deposit subtracted.
        deposit_pounds = (Math.round(subPence / 2) / 100).toFixed(2);
      }

      const body = { kind: d.kind, lines, notes, due_at: d.due_at || undefined, deposit_pounds };
      if (d.client_id) {
        body.client_id = Number(d.client_id);
      } else {
        const name = $('#nc-name', root).value.trim();
        if (!name) throw new Error('Pick a client or enter a new business name.');
        body.client = { name, email: $('#nc-email', root).value.trim(), address: $('#nc-address', root).value.trim() };
      }
      const res = await api.invoices.create(body);
      toast(`Invoice ${res.invoice.number} created`);
      return res.invoice;
    },
  });
}

/* --------------------------------------------------------------- the view */

export default async function invoicesView(root, _params, { refresh }) {
  const [{ invoices }, { plans }, settings] = await Promise.all([
    api.invoices.list(),
    api.invoices.plans().catch(() => ({ plans: [] })),
    api.settings.get().catch(() => ({ settings: {} })),
  ]);
  const clients = (await api.invoices.clients().catch(() => ({ clients: [] }))).clients;
  const s = settings.settings ?? {};

  const due = (i) => i.amount_due_pence ?? i.total_pence;
  const outstanding = invoices.filter((i) => i.status === 'sent')
    .reduce((n, i) => n + due(i), 0);
  const paid = invoices.filter((i) => i.status === 'paid')
    .reduce((n, i) => n + due(i), 0);

  const payReady = Boolean((s.pay_bank_account && s.pay_bank_name) || s.pay_paypal_link);

  mount(root, html`
    <div class="readout">
      <div><b class="num">${invoices.length}</b><span>Invoices</span></div>
      <div data-accent="warn"><b class="num">${gbp(outstanding)}</b><span>Outstanding</span></div>
      <div data-accent><b class="num">${gbp(paid)}</b><span>Paid</span></div>
    </div>

    ${!payReady ? html`
      <div class="msg msg-warn" style="margin-bottom:10px"><div class="grow">
        Add your <b>bank details or PayPal link</b> below so invoices tell clients how to pay.
      </div></div>` : ''}

    <div class="bar">
      <h2 style="margin:0">Invoices</h2>
      <div class="grow"></div>
      <button class="primary" data-act="new">New invoice</button>
    </div>

    <div class="panel">
      ${invoices.length === 0 ? html`<div class="blank"><strong>No invoices yet</strong>
        Raise one for a client you've won.</div>` : html`
        <div class="scroll-x"><table class="rows">
          <thead><tr><th>Number</th><th>Client</th><th>Type</th><th class="num">Total</th>
            <th>Status</th><th class="nw">Created</th><th></th></tr></thead>
          <tbody>
            ${invoices.map((i) => html`
              <tr data-id="${i.id}">
                <td class="mono">${i.number}</td>
                <td class="c-name"><span class="name">${i.client?.name ?? '—'}</span></td>
                <td class="meta">${i.kind === 'maintenance' ? 'Maintenance' : 'Build'}</td>
                <td class="num">${gbp(i.total_pence)}</td>
                <td>${statusPill(i.status)}${i.paid_method ? html` <span class="meta">${i.paid_method}</span>` : ''}</td>
                <td class="meta nw">${relative(i.created_at)}</td>
                <td class="c-act">
                  <button class="mini" data-act="link" data-id="${i.id}">Copy link</button>
                  <a class="mini" href="/i/${i.token}" target="_blank" rel="noopener">Open</a>
                  ${i.status === 'draft' ? html`<button class="mini" data-act="send" data-id="${i.id}">Mark sent</button>` : ''}
                  ${i.status !== 'paid' && i.status !== 'void' ? html`<button class="mini" data-act="paid" data-id="${i.id}">Mark paid</button>` : ''}
                  ${i.status === 'draft'
                    ? html`<button class="mini danger" data-act="del" data-id="${i.id}">✕</button>`
                    : (i.status !== 'void' ? html`<button class="mini danger" data-act="void" data-id="${i.id}">Void</button>` : '')}
                </td>
              </tr>`)}
          </tbody>
        </table></div>`}
    </div>

    <!-- maintenance plans -->
    <div class="bar" style="margin-top:16px">
      <h3 style="margin:0">Maintenance plans</h3>
      <span class="meta">Recurring monthly care plans</span>
      <div class="grow"></div>
      <button data-act="new-plan">New plan</button>
    </div>
    <div class="panel">
      ${plans.length === 0 ? html`<div class="blank"><strong>No plans</strong>
        A plan bills a client the same amount each month.</div>` : html`
        <div class="scroll-x"><table class="rows">
          <thead><tr><th>Client</th><th class="num">Monthly</th><th>Status</th><th class="nw">Next due</th><th></th></tr></thead>
          <tbody>
            ${plans.map((p) => html`
              <tr data-plan="${p.id}" style="${p.active ? '' : 'opacity:.55'}">
                <td class="c-name"><span class="name">${p.client_name}</span></td>
                <td class="num">${gbp(p.monthly_pence)}</td>
                <td>${p.active ? html`<span class="flag" data-ok>active</span>` : 'paused'}</td>
                <td class="meta nw">${p.next_due_on ?? '—'}</td>
                <td class="c-act">
                  ${p.active ? html`<button class="mini" data-act="bill" data-id="${p.id}">Bill this month</button>` : ''}
                  <button class="mini" data-act="toggle-plan" data-id="${p.id}" data-active="${p.active ? '0' : '1'}">
                    ${p.active ? 'Pause' : 'Resume'}</button>
                </td>
              </tr>`)}
          </tbody>
        </table></div>`}
    </div>

    <!-- payment + invoice settings -->
    <div class="bar" style="margin-top:16px"><h3 style="margin:0">Payment details</h3>
      <span class="meta">Shown on every invoice</span></div>
    <div class="panel"><div class="panel-bd">
      <form id="pay-form">
        <div class="cols">
          <div class="f"><label>Bank account name</label><input name="pay_bank_name" value="${s.pay_bank_name ?? ''}"></div>
          <div class="f"><label>Sort code</label><input name="pay_bank_sortcode" value="${s.pay_bank_sortcode ?? ''}" placeholder="00-00-00"></div>
          <div class="f"><label>Account number</label><input name="pay_bank_account" value="${s.pay_bank_account ?? ''}" placeholder="12345678"></div>
        </div>
        <div class="cols">
          <div class="f"><label>PayPal link <span class="opt">PayPal.me or a hosted invoice</span></label>
            <input name="pay_paypal_link" value="${s.pay_paypal_link ?? ''}" placeholder="https://paypal.me/yourname"></div>
          <div class="f"><label>Klarna note <span class="opt">shown as an option</span></label>
            <input name="pay_klarna_note" value="${s.pay_klarna_note ?? ''}" placeholder="Ask us about paying monthly with Klarna"></div>
        </div>
        <div class="cols">
          <div class="f"><label>Invoice prefix</label><input name="invoice_prefix" value="${s.invoice_prefix ?? 'INV'}" placeholder="KEY"></div>
          <div class="f"><label>Next invoice number <span class="opt">the next one you raise</span></label>
            <input id="iv-next-number" type="number" min="1" value="${Number(s.invoice_seq ?? 0) + 1}"></div>
          <div class="f"><label>VAT number <span class="opt">leave blank if not registered</span></label>
            <input name="biz_vat_number" value="${s.biz_vat_number ?? ''}"></div>
        </div>
        <div class="f"><label>Payment terms</label>
          <input name="invoice_terms" value="${s.invoice_terms ?? ''}" placeholder="Payment is due within 24 hours of the invoice date."></div>
        <div class="bar"><button type="submit" class="primary">Save payment details</button></div>
      </form>
    </div></div>
  `);

  /* ---- invoice actions ---- */
  on(root, 'click', '[data-act="new"]', async () => {
    if (await openInvoiceForm(clients)) refresh();
  });

  on(root, 'click', '[data-act="link"]', async (_e, el) => {
    const { invoice } = await api.invoices.get(el.dataset.id);
    const ok = await copy(clientLink(invoice));
    toast(ok ? 'Client link copied' : clientLink(invoice), { ms: 5000 });
  });

  on(root, 'click', '[data-act="send"]', async (_e, el) => {
    await api.invoices.sent(el.dataset.id);
    toast('Marked as sent'); refresh();
  });

  on(root, 'click', '[data-act="paid"]', async (_e, el) => {
    const method = await pickMethod();
    if (!method) return;
    await api.invoices.paid(el.dataset.id, method);
    toast('Marked as paid'); refresh();
  });

  on(root, 'click', '[data-act="void"]', async (_e, el) => {
    if (!await confirmDialog({ title: 'Void invoice',
      message: 'Void this invoice? It stays on record but is marked cancelled.',
      confirmLabel: 'Void', danger: true })) return;
    await api.invoices.void(el.dataset.id);
    toast('Voided'); refresh();
  });

  on(root, 'click', '[data-act="del"]', async (_e, el) => {
    if (!await confirmDialog({ title: 'Delete draft',
      message: 'Delete this draft invoice?', confirmLabel: 'Delete', danger: true })) return;
    await api.invoices.remove(el.dataset.id);
    toast('Deleted'); refresh();
  });

  /* ---- maintenance ---- */
  on(root, 'click', '[data-act="new-plan"]', async () => {
    const done = await modal({
      title: 'New maintenance plan',
      body: html`
        <div class="f"><label>Client</label>
          <select id="pl-client" name="client_id">
            <option value="">— new client —</option>
            ${clients.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
          </select></div>
        <div class="f" id="pl-newname-wrap"><label>…or a new business name</label>
          <input id="pl-newname" type="text" placeholder="Bloom Nails Ltd"></div>
        <div class="cols">
          <div class="f"><label>Monthly amount £</label><input name="monthly_pounds" type="number" min="0" step="0.01" required placeholder="30.00"></div>
          <div class="f"><label>Starts</label><input name="started_on" type="date"></div>
        </div>
        <div class="f"><label>Description</label><input name="description" type="text" value="Website maintenance & hosting"></div>`,
      footer: html`<button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Create plan</button>`,
      onSubmit: async (d, r) => {
        const body = { monthly_pounds: d.monthly_pounds, description: d.description, started_on: d.started_on || undefined };
        if (d.client_id) body.client_id = Number(d.client_id);
        else {
          const name = $('#pl-newname', r).value.trim();
          if (!name) throw new Error('Pick a client or enter a name.');
          body.client = { name };
        }
        await api.invoices.addPlan(body);
        toast('Plan created');
        return true;
      },
    });
    if (done) refresh();
  });

  on(root, 'click', '[data-act="bill"]', async (_e, el) => {
    try {
      const res = await api.invoices.billPlan(el.dataset.id);
      toast(`Invoice ${res.invoice.number} raised`);
      refresh();
    } catch (err) { toast(err.message, { error: true, ms: 5000 }); }
  });

  on(root, 'click', '[data-act="toggle-plan"]', async (_e, el) => {
    await api.invoices.setPlan(el.dataset.id, el.dataset.active === '1');
    refresh();
  });

  /* ---- payment settings ---- */
  on(root, 'submit', '#pay-form', async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    // "Next invoice number" is a friendlier UI than the raw counter (id only,
    // no name, so it stays out of the form's settings keys). A number is minted
    // as counter+1, so store one less than what they typed.
    const nextEl = ev.target.querySelector('#iv-next-number');
    if (nextEl && nextEl.value) {
      body.invoice_seq = String(Math.max(0, Math.round(Number(nextEl.value)) - 1));
    }
    await api.settings.save(body);
    toast('Saved');
    refresh();
  });
}

/** A tiny picker for how an invoice was paid. */
function pickMethod() {
  return modal({
    title: 'How was it paid?',
    body: html`<div class="pills" style="gap:8px">
      ${[['full', 'Paid in full'], ['bank', 'Bank transfer'], ['paypal', 'PayPal'], ['klarna', 'Klarna']]
        .map(([v, l]) => html`<button type="button" class="pill" data-method="${v}">${l}</button>`)}
    </div>`,
    footer: html`<button type="button" data-close>Cancel</button>`,
    onMount: (r, close) => {
      for (const b of $$('[data-method]', r)) b.addEventListener('click', () => close(b.dataset.method));
    },
  });
}

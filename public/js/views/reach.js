/* The Reach dialog: find contacts, then hand off through any channel.
 *
 * The state object is mutated in place by handlers on a single modal. Nothing
 * else can reach it, so the require-atomic-updates rule fires on every
 * await-then-assign — every one of those is a false positive here.
 */
/* eslint-disable require-atomic-updates */
import { api } from '../api.js';
import { html, modal, toast, on } from '../dom.js';

const CHANNEL_LABEL = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  call: 'Call',
};

const KIND_LABEL = {
  email: 'Email',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  website: 'Website',
  facebook: 'Facebook',
  other: 'Other',
};

/**
 * Reach modal — one screen that finds contacts and dispatches through the
 * channel the user picks. It is a modal, not a dedicated view, because a
 * user picking "reach out" is in the middle of a task on the leads list.
 */
export async function openReachDialog(leadId) {
  const lead = await api.leads.get(leadId);
  const leadRow = lead.lead ?? lead;
  const templates = (await api.templates.list()).templates;
  let state = {
    lead: leadRow,
    signals: [],
    finds: [],
    templates,
    channel: 'whatsapp',
    template_id: null,
    text: '',
    finding: false,
    lastPrepare: null,
  };

  // Initial fetch of any signals we already have.
  const initial = await api.contacts.signals(leadRow.id).catch(() => ({ signals: [], finds: [] }));
  state.signals = initial.signals;
  state.finds   = initial.finds;

  return modal({
    title: `Reach ${leadRow.business_name}`,
    wide: true,
    body: renderBody(state),
    footer: html`<button data-close class="ghost">Close</button>`,
    onMount(dlg) {
      wire(dlg, state);
    },
  });
}

/* --------------------------------------------------------------- render */

function renderBody(state) {
  const { lead } = state;
  return html`
    <div id="reach-root">
      ${leadSummary(lead)}
      ${signalsPanel(state)}
      ${channelPicker(state)}
      ${messagePanel(state)}
      ${state.lastPrepare ? preparedPanel(state.lastPrepare) : ''}
    </div>
  `;
}

function leadSummary(lead) {
  return html`
    <div class="panel"><div class="panel-bd">
      <div class="grow">
        <div><b>${lead.business_name}</b>
          ${lead.category ? html` · <span class="meta">${lead.category}</span>` : ''}
          ${lead.location ? html` · <span class="meta">${lead.location}</span>` : ''}
        </div>
        ${lead.registered_address ? html`<div class="meta mono" style="font-size:.85rem">${lead.registered_address}</div>` : ''}
        <div class="meta" style="margin-top:4px">
          <span>📞 ${lead.phone ?? '—'}</span> ·
          <span>✉ ${lead.email ?? '—'}</span> ·
          <span>Legal form: ${lead.entity_type}</span>
        </div>
        ${!lead.can_email && lead.block_reason ? html`
          <div class="msg msg-warn" style="margin-top:8px"><div class="grow">${lead.block_reason}</div></div>` : ''}
      </div>
    </div></div>`;
}

function signalsPanel(state) {
  const { signals, finding } = state;
  return html`
    <div class="panel">
      <div class="panel-hd">
        <h3 class="grow">Contact signals</h3>
        <button class="mini" data-act="find" ${finding ? 'disabled' : ''}>
          ${finding ? html`<span class="spin"></span> Finding…` : 'Find contacts'}
        </button>
      </div>
      <div class="panel-bd">
        ${!signals.length ? html`
          <p class="tip">No contact details discovered yet.
            <b>Find contacts</b> reads the lead's own website (if we know one) plus
            any public directory or Facebook page that mentions them.
            Everything it finds is scraped from public pages, not looked up in a paid service.</p>`
        : html`
          <table class="rows">
            <thead><tr><th>Kind</th><th>Value</th><th class="num">Confidence</th><th>Source</th><th></th></tr></thead>
            <tbody>
              ${signals.map((s) => html`
                <tr data-signal="${s.id}">
                  <td class="meta">${KIND_LABEL[s.kind] ?? s.kind}</td>
                  <td class="mono" style="font-size:.9rem"><b>${s.value}</b>
                    ${s.promoted_at ? html`<span class="flag" data-ok style="margin-left:4px">in use</span>` : ''}</td>
                  <td class="meta num">${s.confidence}</td>
                  <td class="meta">${s.source}</td>
                  <td class="c-act">
                    ${(s.kind === 'email' || s.kind === 'phone') && !s.promoted_at
                      ? html`<button class="mini" data-act="promote" data-sig="${s.id}">Use this</button>` : ''}
                    <button class="mini ghost" data-act="drop" data-sig="${s.id}">✕</button>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>`}
      </div>
    </div>`;
}

function channelPicker(state) {
  const { lead } = state;
  const options = [
    { c: 'email',    ok: lead.can_email,   why: lead.block_reason },
    { c: 'whatsapp', ok: Boolean(lead.phone) && lead.entity_type === 'corporate',
      why: !lead.phone ? 'No phone number.' : lead.entity_type !== 'corporate'
        ? 'Only corporate subscribers may be cold-messaged (PECR reg 22).' : '' },
    { c: 'sms',      ok: Boolean(lead.phone) && lead.entity_type === 'corporate',
      why: !lead.phone ? 'No phone number.' : lead.entity_type !== 'corporate'
        ? 'Only corporate subscribers may be cold-messaged (PECR reg 22).' : '' },
    { c: 'call',     ok: Boolean(lead.phone) && lead.entity_type === 'corporate',
      why: !lead.phone ? 'No phone number.' : lead.entity_type !== 'corporate'
        ? 'Only corporate subscribers may be cold-called (PECR reg 21).' : '' },
  ];
  return html`
    <div class="panel">
      <div class="panel-hd"><h3>Channel</h3></div>
      <div class="panel-bd">
        <div class="cols-4">
          ${options.map((o) => html`
            <button data-act="channel" data-channel="${o.c}"
                    class="${state.channel === o.c ? 'primary' : ''}"
                    ${!o.ok ? 'disabled' : ''}
                    title="${o.ok ? '' : o.why}">
              ${CHANNEL_LABEL[o.c]}${!o.ok ? ' — blocked' : ''}
            </button>`)}
        </div>
        <p class="tip">
          WhatsApp and SMS open on your phone with the message pre-filled —
          you tap Send once. Nothing is sent by the tool: there is no free API
          for either channel, so the tool prepares them and you dispatch.
          Email goes through your Gmail as normal.
        </p>
      </div>
    </div>`;
}

function messagePanel(state) {
  const { channel, templates, template_id, text, lead } = state;
  if (channel === 'call') {
    return html`
      <div class="panel">
        <div class="panel-hd"><h3>Ready to dial</h3></div>
        <div class="panel-bd">
          <p>Tap <b>Prepare call</b> to open your phone's dialler with the number filled in.</p>
          <button class="primary" data-act="prepare">Prepare call</button>
        </div>
      </div>`;
  }
  if (channel === 'email') {
    return html`
      <div class="panel">
        <div class="panel-hd"><h3>Email</h3></div>
        <div class="panel-bd">
          <p>Email uses the existing Compose screen —
            <a href="#/compose?lead=${lead.id}" data-act="email-hop">write and send there</a>.
            Every send goes through the PECR gate and appends your business footer.</p>
        </div>
      </div>`;
  }
  const forChannel = templates.filter((t) => t.channel === channel);
  const soft = channel === 'sms' ? 160 : 1024;
  const len = String(text ?? '').length;
  return html`
    <div class="panel">
      <div class="panel-hd">
        <h3 class="grow">Message</h3>
        <span class="meta">${len}/${soft} chars${len > soft ? ' — over limit' : ''}</span>
      </div>
      <div class="panel-bd">
        <div class="f">
          <label for="reach-tpl">Template</label>
          <select id="reach-tpl" data-act="tpl">
            <option value="">— pick a template or write below —</option>
            ${forChannel.map((t) => html`<option value="${t.id}" ${t.id === template_id ? 'selected' : ''}>${t.name}</option>`)}
          </select>
          ${!forChannel.length ? html`
            <p class="tip">No ${CHANNEL_LABEL[channel]} templates yet.
              <a href="#/templates" data-act="tpl-hop">Add one</a> — same placeholders as email.</p>` : ''}
        </div>
        <div class="f">
          <label for="reach-text">Text</label>
          <textarea id="reach-text" rows="5" data-act="text">${text ?? ''}</textarea>
        </div>
        <div class="bar">
          <button class="primary" data-act="prepare" ${!text ? 'disabled' : ''}>
            Prepare ${CHANNEL_LABEL[channel]}
          </button>
          <span class="meta">Nothing is sent yet. This opens ${CHANNEL_LABEL[channel]} with the text ready.</span>
        </div>
      </div>
    </div>`;
}

function preparedPanel(prep) {
  return html`
    <div class="panel">
      <div class="panel-hd"><h3>Ready to send</h3></div>
      <div class="panel-bd">
        <p><b>To:</b> <span class="mono">${prep.e164}</span>
          ${prep.mobile ? '' : html`<span class="flag" style="margin-left:4px">landline — WhatsApp may not answer</span>`}</p>
        ${prep.advice ? html`<div class="msg msg-info"><div class="grow">${prep.advice}</div></div>` : ''}
        <div class="bar" style="margin-top:8px">
          <a class="btn primary" href="${prep.url}" target="_blank" rel="noopener"
             data-act="hop" data-event="${prep.event_id}">Open ${CHANNEL_LABEL[prep.channel]}</a>
          <button data-act="mark-sent" data-event="${prep.event_id}">I sent it</button>
        </div>
        <p class="tip">"Open" launches ${CHANNEL_LABEL[prep.channel]} with the message.
          After you tap Send there, come back here and confirm — it updates the lead's
          last-contacted time and moves it to <i>sent</i>.</p>
      </div>
    </div>`;
}

/* --------------------------------------------------------------- wire */

function wire(dlg, state) {
  const rerender = () => {
    const root = dlg.querySelector('#reach-root');
    if (root) root.outerHTML = renderBody(state).toString();
  };

  on(dlg, 'click', '[data-act="channel"]', (_e, el) => {
    state.channel = el.dataset.channel;
    // When switching, drop any prepared handoff so we don't confuse the user.
    state.lastPrepare = null;
    if (state.channel === 'call') state.text = '';
    rerender();
  });

  on(dlg, 'change', '[data-act="tpl"]', async (_e, el) => {
    const id = Number(el.value);
    state.template_id = id || null;
    if (!id) { rerender(); return; }
    // Render via the preview endpoint... except templates render is a server
    // concern for email only. For SMS/WhatsApp we render locally with a
    // minimal renderer that mirrors the server's.
    const tpl = state.templates.find((t) => t.id === id);
    if (!tpl) { rerender(); return; }
    state.text = renderLocal(tpl.body, state.lead);
    rerender();
  });

  on(dlg, 'input', '[data-act="text"]', (_e, el) => {
    state.text = el.value;
    // Cheaper than a rerender: just update the length counter.
    const counter = dlg.querySelector('.panel-hd .meta');
    if (counter) {
      const soft = state.channel === 'sms' ? 160 : 1024;
      const len = state.text.length;
      counter.textContent = `${len}/${soft} chars${len > soft ? ' — over limit' : ''}`;
    }
  });

  on(dlg, 'click', '[data-act="find"]', async (_e, btn) => {
    state.finding = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Finding…';
    try {
      const r = await api.contacts.find(state.lead.id);
      state.signals = r.signals;
      const bits = [`${r.signals.length} signal${r.signals.length === 1 ? '' : 's'}`];
      if (r.sources?.length) bits.push(`from ${r.sources.join(', ')}`);
      toast('Found ' + bits.join(' '));
      if (r.errors?.length) {
        toast(`Some sources didn't answer: ${r.errors.join('; ')}`, { error: true, ms: 6000 });
      }
    } catch (err) {
      toast(err.message ?? 'Discovery failed', { error: true, ms: 5000 });
    } finally {
      state.finding = false;
      rerender();
    }
  });

  on(dlg, 'click', '[data-act="promote"]', async (_e, el) => {
    try {
      const r = await api.contacts.promote(state.lead.id, el.dataset.sig);
      state.signals = r.signals;
      // Reload the lead so email/phone display refreshes.
      const fresh = await api.leads.get(state.lead.id);
      state.lead = fresh.lead ?? fresh;
      toast('Applied to lead');
      rerender();
    } catch (err) {
      toast(err.message ?? 'Failed', { error: true });
    }
  });

  on(dlg, 'click', '[data-act="drop"]', async (_e, el) => {
    try {
      const r = await api.contacts.remove(state.lead.id, el.dataset.sig);
      state.signals = r.signals;
      rerender();
    } catch { /* nothing to do */ }
  });

  on(dlg, 'click', '[data-act="prepare"]', async (_e, btn) => {
    btn.disabled = true;
    try {
      const body = {
        lead_id: state.lead.id,
        channel: state.channel,
        text: state.channel === 'call' ? undefined : state.text,
      };
      const r = await api.outreach.prepare(body);
      state.lastPrepare = r;
      rerender();
    } catch (err) {
      toast(err.message ?? 'Cannot prepare', { error: true, ms: 6000 });
      btn.disabled = false;
    }
  });

  on(dlg, 'click', '[data-act="mark-sent"]', async (_e, el) => {
    try {
      await api.outreach.sent(el.dataset.event);
      toast('Marked sent');
      // Refresh the lead so status/last_contacted updates.
      const fresh = await api.leads.get(state.lead.id);
      state.lead = fresh.lead ?? fresh;
      state.lastPrepare = null;
      rerender();
    } catch (err) {
      toast(err.message ?? 'Could not mark sent', { error: true });
    }
  });

  // Hops close the modal so navigation feels right.
  on(dlg, 'click', '[data-act="email-hop"], [data-act="tpl-hop"]', () => {
    dlg.querySelector('[data-close]')?.click();
  });
}

/**
 * Local placeholder renderer for the modal preview. Server does the real
 * render at prepare-time; this just keeps the textarea in sync so the user
 * can tweak before sending.
 */
function renderLocal(body, lead) {
  const ctx = {
    business: lead.business_name ?? '',
    category: lead.category ?? '',
    location: lead.location ?? '',
    phone:    lead.phone ?? '',
    email:    lead.email ?? '',
    first_name: String(lead.business_name ?? '').trim().split(/\s+/)[0] ?? '',
  };
  return String(body ?? '').replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (m, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k] ?? '') : m;
  });
}


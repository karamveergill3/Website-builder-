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
  // Default channel picks itself from what the lead actually has. Hunt
  // leads have no website AND usually no email; they arrive with a phone
  // from Google Places, so WhatsApp / call are the honest default.
  const defaultChannel =
    leadRow.can_email ? 'email'
    : leadRow.phone   ? 'whatsapp'
    : 'email';

  let state = {
    lead: leadRow,
    signals: [],
    finds: [],
    templates,
    channel: defaultChannel,
    template_id: null,
    text: '',
    // What the last template render produced. Switching channel refills the
    // box only while the text is still exactly that — anything typed is the
    // user's, and losing it to a stray click is unforgivable.
    rendered: '',
    empty: [],
    finding: false,
    lastPrepare: null,
    manualUrl: '',
  };

  // Initial fetch of any signals we already have.
  const initial = await api.contacts.signals(leadRow.id).catch(() => ({ signals: [], finds: [] }));
  state.signals = initial.signals;
  state.finds   = initial.finds;

  // Open with the message already written, and already about this company.
  // A dialog that opens on an empty box and a template dropdown is a dialog
  // that asks you to do the work it exists to have done.
  await fillDefault(state);

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

/**
 * The template to open with, for one channel.
 *
 * The shipped first-message templates are named "First message — WhatsApp"
 * and so on, so prefer one of those and fall back to whatever exists. A
 * follow-up must never be the thing that opens on a business that has not
 * been written to yet.
 */
function defaultTemplateFor(templates, channel, lead) {
  const forChannel = templates.filter((t) => t.channel === channel);
  // Prefer the opener written for this lead's trade — the salon one for a
  // salon, the trades one for a roofer — matched on the sector suffix the
  // server put on the lead. Fall back to the plain first message (the one
  // with no "· sector" suffix), then anything.
  const label = lead?.sector_label;
  if (label) {
    const tuned = forChannel.find((t) => t.name.includes(`· ${label}`));
    if (tuned) return tuned;
  }
  return forChannel.find((t) => /^first/i.test(t.name) && !t.name.includes('·'))
    ?? forChannel.find((t) => /^first/i.test(t.name))
    ?? forChannel[0] ?? null;
}

/** Fill the box from a template, rendered for this lead by the server. */
async function fillFrom(state, id) {
  state.template_id = id || null;
  if (!id) { state.rendered = ''; state.empty = []; return; }
  try {
    const r = await api.templates.render(id, state.lead.id);
    state.text = r.body;
    state.rendered = r.body;
    state.empty = r.empty ?? [];
  } catch (err) {
    toast(err.message ?? 'Could not fill that template in', { error: true, ms: 5000 });
  }
}

/** Pick this channel's opening message, unless the user has typed their own. */
async function fillDefault(state) {
  if (state.channel === 'email' || state.channel === 'call') return;
  if (state.text && state.text !== state.rendered) return;   // theirs, not ours
  const tpl = defaultTemplateFor(state.templates, state.channel, state.lead);
  if (!tpl) { state.text = ''; state.rendered = ''; state.empty = []; return; }
  await fillFrom(state, tpl.id);
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
        ${lead.contacted_before ? html`
          <div class="msg ${lead.can_contact ? 'msg-info' : 'msg-warn'}" style="margin-top:8px">
            <div class="grow">
              <b>Already approached</b>${lead.contacted_via ? ` by ${lead.contacted_via}` : ''}
              ${lead.contacted_at ? ` on ${String(lead.contacted_at).slice(0, 10)}` : ''}.
              ${lead.can_contact
                ? 'They replied, so this is a conversation rather than a cold approach.'
                : 'A second cold approach is what gets a complaint made.'}
            </div>
          </div>` : ''}
      </div>
    </div></div>`;
}

function signalsPanel(state) {
  const { signals, finding, lead, manualUrl } = state;
  const noWeb = lead.has_website === 0;
  return html`
    <div class="panel">
      <div class="panel-hd">
        <h3 class="grow">Contact signals</h3>
        <button class="mini" data-act="find" ${finding ? 'disabled' : ''}>
          ${finding ? html`<span class="spin"></span> Finding…` : 'Find contacts'}
        </button>
      </div>
      <div class="panel-bd">
        ${noWeb ? html`
          <div class="msg msg-info" style="margin-bottom:10px"><div class="grow">
            This business has no website — that is why it is in the tool.
            Email addresses rarely exist for these leads (a business with no site
            is usually phone-first). <b>Find contacts</b> looks for their
            Yell, Facebook and Checkatrade listings instead, which usually
            carry a phone and sometimes an email.
          </div></div>
        ` : ''}
        <div class="cols" style="margin-bottom:10px">
          <div class="f">
            <label for="reach-url">Website URL <span class="opt">optional</span></label>
            <input id="reach-url" type="url" data-act="url" value="${manualUrl}"
                   placeholder="https://…"
                   autocomplete="off">
            <p class="tip">If you know one — a Facebook page URL works too — paste it and
              <b>Find contacts</b> will scrape it. Otherwise the search-engine path runs
              on its own.</p>
          </div>
        </div>
        ${!signals.length ? html`
          <p class="tip">No contact details discovered yet.
            Everything comes from public pages, never a paid lookup service.</p>`
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
          ${!lead.email && lead.has_website === 0 ? html`
            <div class="msg msg-warn"><div class="grow">
              This lead has no email address and no website — email is unlikely
              to reach them. WhatsApp or a call is the honest channel here.
            </div></div>` : ''}
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
        <p class="tip" style="margin-top:0">
          Written for <b>${lead.business_name}</b>${lead.location ? ` in ${lead.location}` : ''}${
            lead.category ? ` · ${lead.category}` : ''} — the name, town and trade
          are filled in from the lead, and your own details from Settings.
        </p>
        ${state.empty?.length ? html`
          <div class="msg msg-warn" style="margin-bottom:10px"><div class="grow">
            Nothing to put in ${state.empty.map((k) => `{{${k}}}`).join(', ')}, so
            ${state.empty.length === 1 ? 'it is' : 'they are'} blank in the message.
            ${state.empty.some((k) => k.startsWith('my_'))
              ? html`Your own details live on the <a href="#/settings" data-act="tpl-hop">Settings screen</a>.`
              : 'Fill it in on the lead, or edit the wording below.'}
          </div></div>` : ''}
        <div class="f">
          <label for="reach-tpl">Template</label>
          <select id="reach-tpl" data-act="tpl">
            <option value="">— pick a template or write below —</option>
            ${forChannel.map((t) => html`<option value="${t.id}" ${t.id === template_id ? 'selected' : ''}>${t.name}</option>`)}
          </select>
          ${!forChannel.length ? html`
            <p class="tip">No ${CHANNEL_LABEL[channel]} templates yet.
              <a href="#/templates" data-act="tpl-hop">Add the starters</a> on the Templates screen.</p>` : ''}
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
        <p class="tip">"Open" launches ${CHANNEL_LABEL[prep.channel]} with the message,
          and marks this company as approached — so tomorrow's list will not offer
          it to you again. If you close ${CHANNEL_LABEL[prep.channel]} without
          sending, undo it from the lead.</p>
      </div>
    </div>`;
}

/* --------------------------------------------------------------- wire */

function wire(dlg, state) {
  const rerender = () => {
    const root = dlg.querySelector('#reach-root');
    if (root) root.outerHTML = renderBody(state).toString();
  };

  on(dlg, 'click', '[data-act="channel"]', async (_e, el) => {
    state.channel = el.dataset.channel;
    // When switching, drop any prepared handoff so we don't confuse the user.
    state.lastPrepare = null;
    if (state.channel === 'call') { state.text = ''; state.rendered = ''; }
    else await fillDefault(state);
    rerender();
  });

  on(dlg, 'change', '[data-act="tpl"]', async (_e, el) => {
    await fillFrom(state, Number(el.value));
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

  on(dlg, 'input', '[data-act="url"]', (_e, el) => { state.manualUrl = el.value.trim(); });

  on(dlg, 'click', '[data-act="find"]', async (_e, btn) => {
    state.finding = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Finding…';
    try {
      const opts = state.manualUrl ? { website_url: state.manualUrl } : undefined;
      const r = await api.contacts.find(state.lead.id, opts);
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

  /**
   * Tapping "Open WhatsApp" IS the send, as far as this tool can ever know.
   * The link had no handler at all, so the only thing that recorded a message
   * was the separate "I sent it" button next to it — and a user who taps
   * Open, sends, and closes the tab recorded nothing. The company then looks
   * untouched tomorrow, which is how it gets messaged twice.
   *
   * The link is left to navigate normally; this only files the fact.
   */
  on(dlg, 'click', '[data-act="hop"]', async (_e, el) => {
    try {
      await api.outreach.sent(el.dataset.event);
      const fresh = await api.leads.get(state.lead.id);
      state.lead = fresh.lead ?? fresh;
      rerender();
    } catch {
      // Never block the handoff on bookkeeping: the user is mid-send, and
      // "I sent it" is still there to file it.
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



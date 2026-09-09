/* Compose: pick a lead and a template, read the finished email, send it. */
import { api } from '../api.js';
import { html, mount, on, $, toast, statusPill, esc, raw } from '../dom.js';

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure context */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

export default async function composeView(root, params, { navigate }) {
  const [{ leads }, { templates: allTemplates }, settings] = await Promise.all([
    api.leads.list({ limit: 1000 }),
    api.templates.list(),
    api.settings.get(),
  ]);

  // Email templates only. WhatsApp and SMS wording has no subject line and is
  // written for a phone screen; offering it here produced an email whose
  // subject was blank and whose body said "Reply STOP".
  const templates = allTemplates.filter((t) => (t.channel ?? 'email') === 'email');
  const usable = leads.filter((l) => !l.opted_out && l.block_code !== 'SUPPRESSED');
  // Land on a company that has not been approached yet. Defaulting to the
  // first merely-emailable lead put yesterday's send at the top of the
  // screen, ready to write again.
  const leadId = params.lead
    ?? usable.find((l) => l.can_email && l.can_contact)?.id
    ?? usable.find((l) => l.can_email)?.id
    ?? usable[0]?.id ?? '';
  // Open on a first approach rather than a follow-up: this screen is reached
  // from a lead that has not been written to.
  const templateId = params.template
    ?? templates.find((t) => /^first/i.test(t.name))?.id
    ?? templates[0]?.id ?? '';
  const gmailReady = settings.integrations?.gmail_connected === true;

  const go = (key, value) => {
    const next = new URLSearchParams({ lead: leadId, template: templateId });
    next.set(key, value);
    location.hash = `/compose?${next.toString()}`;
  };

  if (!templates.length || !usable.length) {
    const needTemplate = !templates.length;
    mount(root, html`
      <div class="bar"><h2>Compose</h2></div>
      <div class="panel"><div class="blank">
        <strong>${needTemplate ? 'No email templates yet' : 'No leads yet'}</strong>
        <a href="${needTemplate ? '#/templates' : '#/leads'}">${needTemplate ? 'Add the starters' : 'Add a lead'}</a>
      </div></div>`);
    return;
  }

  mount(root, html`
    <div class="bar">
      <h2>Compose</h2>
      <div class="grow"></div>
      <select id="c-lead" style="max-width:290px">
        ${usable.map((l) => html`
          <option value="${l.id}" ${String(l.id) === String(leadId) ? 'selected' : ''}>
            ${l.business_name}${l.can_email ? '' : '  ·  blocked'}${
              l.contacted_before && !l.can_contact ? '  ·  already approached' : ''}
          </option>`)}
      </select>
      <select id="c-template" style="max-width:210px">
        ${templates.map((t) => html`
          <option value="${t.id}" ${String(t.id) === String(templateId) ? 'selected' : ''}>${t.name}</option>`)}
      </select>
    </div>

    <div id="pv"><div class="loading"><span class="spin"></span></div></div>
  `);

  $('#c-lead', root).addEventListener('change', (e) => go('lead', e.target.value));
  $('#c-template', root).addEventListener('change', (e) => go('template', e.target.value));

  /* Handlers bind once; draw() only refreshes what they read. */
  const box = $('#pv', root);
  let data = null;

  const log = async (channel) => {
    if (!data) return;
    await api.emails.log({
      lead_id: Number(leadId), template_id: Number(templateId),
      channel, subject: data.subject, body: data.body, to_email: data.lead.email ?? '',
    });
    toast(`Logged to ${data.lead.business_name}`);
    await draw();
  };

  on(box, 'click', '[data-act="copy"]', async () => {
    if (!data) return;
    const ok = await copyText(`Subject: ${data.subject}\n\n${data.body}`);
    toast(ok ? 'Copied' : 'Could not copy — select the text', { error: !ok });
    if (ok) await log('copy');
  });
  on(box, 'click', '[data-act="mailto"]', () => setTimeout(() => log('mailto'), 400));
  on(box, 'click', '[data-act="sent"]', () => log('copy'));
  on(box, 'click', '[data-act="queue"]', async () => {
    await api.post('/api/gmail/queue', { lead_ids: [Number(leadId)], template_id: Number(templateId) });
    toast('Queued for review');
    navigate('/outbox');
  });

  await draw();

  async function draw() {
    try {
      data = await api.emails.preview(leadId, templateId);
    } catch (err) {
      data = null;
      mount(box, html`<div class="msg msg-bad"><div class="grow">${err.message}</div></div>`);
      return;
    }

    const sig = data.footer?.text ?? '';
    const at = sig ? data.body.lastIndexOf(sig) : -1;
    const main = at >= 0 ? data.body.slice(0, at) : data.body;
    const tail = at >= 0 ? data.body.slice(at) : '';
    const ready = data.compliant && data.lawful;

    mount(box, html`
      ${data.warnings.map((w) => html`
        <div class="msg ${/blocked|incomplete|PECR|consent/.test(w) ? 'msg-bad' : 'msg-warn'}"
             style="margin-bottom:10px"><div class="grow">${w}</div></div>`)}

      <div class="panel">
        <div class="panel-hd">
          <span class="name grow" style="font-size:.9rem">${data.lead.business_name}</span>
          ${statusPill(data.lead.status)}
        </div>
        <div class="panel-bd">
          <div class="mail">
            <div class="mail-hd"><dl>
              <dt>To</dt><dd>${data.lead.email ?? raw('<em>no email</em>')}</dd>
              <dt>Subject</dt><dd class="subj">${data.subject}</dd>
            </dl></div>
            <div class="mail-bd" style="max-height:none">${main}${
              tail ? raw(`<span class="sig">${esc(tail)}</span>`) : ''}</div>
          </div>

          <div class="bar" style="margin:12px 0 0">
            ${gmailReady && data.can_send ? html`
              <button class="primary" data-act="queue">Queue for Gmail</button>` : ''}
            <button data-act="copy" ${ready ? '' : 'disabled'}>Copy</button>
            ${ready && data.mailto ? html`<a class="btn" href="${data.mailto}" data-act="mailto">Mail app</a>` : ''}
            ${!data.compliant ? html`<a class="btn" href="#/settings">Add your business details</a>` : ''}
            ${data.compliant && !data.lawful ? html`<a class="btn" href="#/leads">Check this lead</a>` : ''}
            <div class="grow"></div>
            <button class="mini ghost" data-act="sent" ${ready ? '' : 'disabled'}>Mark sent</button>
          </div>
        </div>
      </div>`);
  }
}

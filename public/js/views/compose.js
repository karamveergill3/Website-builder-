/* Generate-email view: pick a lead + template, see the filled-in preview,
   copy it or open a mailto: draft. Queueing for Gmail appears once Phase 3
   is connected. */
import { api } from '../api.js';
import { html, mount, on, $, toast, statusPill, esc, raw } from '../dom.js';

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export default async function composeView(root, params, { navigate }) {
  const [{ leads }, { templates }, settings] = await Promise.all([
    api.leads.list({ sort: 'created', limit: 1000 }),
    api.templates.list(),
    api.settings.get(),
  ]);

  // Opted-out and suppressed leads are hidden entirely; leads blocked for a
  // fixable reason (not yet classified) still appear so the block is visible.
  const sendable = leads.filter((l) => !l.opted_out && l.block_code !== 'SUPPRESSED');
  const leadId = params.lead ?? sendable[0]?.id ?? '';
  const templateId = params.template ?? templates[0]?.id ?? '';

  const gmailReady = settings.integrations?.gmail_connected === true;

  const setParam = (key, value) => {
    const next = new URLSearchParams({ lead: leadId, template: templateId });
    next.set(key, value);
    location.hash = `/compose?${next.toString()}`;
  };

  if (!templates.length || !sendable.length) {
    mount(root, html`
      <div class="view-head"><div>
        <h2>Compose</h2>
        <p class="lede">Pick a lead and a template to see the finished email.</p>
      </div></div>
      <div class="card"><div class="empty">
        <h3>${!templates.length ? 'You need a template first' : 'You need a lead first'}</h3>
        <p>${!templates.length
            ? 'Templates hold the wording; leads fill in the blanks.'
            : 'Add a lead by hand, or find businesses with no website under Find leads.'}</p>
        <p style="margin-top:14px">
          <a class="btn btn-primary" href="${!templates.length ? '#/templates' : '#/leads'}">
            ${!templates.length ? 'Go to templates' : 'Go to leads'}</a>
        </p>
      </div></div>`);
    return;
  }

  mount(root, html`
    <div class="view-head">
      <div>
        <h2>Compose</h2>
        <p class="lede">The exact text that will go out, your compliance footer included.</p>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="grid2">
          <div class="field">
            <label for="c-lead">Lead</label>
            <select id="c-lead">
              ${sendable.map((l) => html`
                <option value="${l.id}" ${String(l.id) === String(leadId) ? 'selected' : ''}>
                  ${l.business_name}${l.location ? ` — ${l.location}` : ''}${l.email ? '' : '  (no email)'}
                </option>`)}
            </select>
            ${leads.length !== sendable.length ? html`
              <p class="hint">${leads.length - sendable.length} opted-out lead(s) hidden — they can never be emailed.</p>` : ''}
          </div>
          <div class="field">
            <label for="c-template">Template</label>
            <select id="c-template">
              ${templates.map((t) => html`
                <option value="${t.id}" ${String(t.id) === String(templateId) ? 'selected' : ''}>${t.name}</option>`)}
            </select>
          </div>
        </div>
      </div>
    </div>

    <div id="pv" style="margin-top:16px"><div class="loading"><span class="spinner"></span></div></div>
  `);

  $('#c-lead', root).addEventListener('change', (e) => setParam('lead', e.target.value));
  $('#c-template', root).addEventListener('change', (e) => setParam('template', e.target.value));

  await renderPreview();

  async function renderPreview() {
    const box = $('#pv', root);
    let data;
    try {
      data = await api.emails.preview(leadId, templateId);
    } catch (err) {
      mount(box, html`<div class="note note-danger"><div>${err.message}</div></div>`);
      return;
    }

    // Split the footer out so the preview can shade it as auto-appended text.
    const footerText = data.footer?.text ?? '';
    const idx = footerText ? data.body.lastIndexOf(footerText) : -1;
    const main = idx >= 0 ? data.body.slice(0, idx) : data.body;
    const tail = idx >= 0 ? data.body.slice(idx) : '';

    mount(box, html`
      ${data.warnings.map((w) => html`
        <div class="note ${w.includes('blocked') || w.includes('incomplete') || w.includes('PECR') ? 'note-danger' : 'note-warn'}"
             style="margin-bottom:12px"><div>${w}</div></div>`)}

      <div class="card">
        <div class="card-head">
          <span class="biz" style="flex:1">${data.lead.business_name}</span>
          ${statusPill(data.lead.status)}
          <span class="sub">via <strong>${data.template.name}</strong></span>
        </div>
        <div class="card-body">
          <div class="preview">
            <div class="preview-head"><dl>
              <dt>To</dt><dd>${data.lead.email ?? raw('<em>no email address</em>')}</dd>
              <dt>Subject</dt><dd class="subject">${data.subject}</dd>
            </dl></div>
            <div class="preview-body">${main}${tail ? raw(`<span class="footer-part">${esc(tail)}</span>`) : ''}</div>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:center">
            <button data-act="copy" ${data.compliant && data.lawful ? '' : 'disabled'}>Copy email</button>
            ${!data.compliant ? html`
              <a class="btn" href="#/settings">Fill in your business details</a>`
              : !data.lawful ? html`
                <a class="btn" href="#/leads">Set this lead's legal form</a>`
              : data.mailto ? html`
                <a class="btn" href="${data.mailto}" data-act="mailto">Open in mail app</a>` : html`
                <span class="hint">Add an email address to this lead to draft a message.</span>`}
            ${gmailReady && data.can_send ? html`
              <button class="primary" data-act="queue">Queue for Gmail</button>` : ''}
            <div style="flex:1"></div>
            <button class="tiny" data-act="mark-sent" ${data.compliant && data.lawful ? '' : 'disabled'}>Mark as sent</button>
          </div>
          <p class="hint" style="margin-top:9px">
            ${!data.compliant
              ? 'Blocked until your business details are set: every marketing email must identify you and offer a way to opt out.'
              : !data.lawful
                ? data.block_reason
                : '\u201cCopy\u201d and \u201cOpen in mail app\u201d hand the text to you \u2014 nothing is sent from here. Logging happens automatically so the sent log stays an accurate record.'}
          </p>
        </div>
      </div>`);

    const logIt = async (channel) => {
      await api.emails.log({
        lead_id: Number(leadId), template_id: Number(templateId),
        channel, subject: data.subject, body: data.body, to_email: data.lead.email ?? '',
      });
      toast(`Logged as sent to ${data.lead.business_name}`);
      await renderPreview();
    };

    on(box, 'click', '[data-act="copy"]', async () => {
      const ok = await copyToClipboard(`Subject: ${data.subject}\n\n${data.body}`);
      toast(ok ? 'Copied to clipboard' : 'Could not copy — select the text instead', { error: !ok });
      if (ok) await logIt('copy');
    });

    on(box, 'click', '[data-act="mailto"]', () => {
      // Let the browser open the draft, then log it.
      setTimeout(() => logIt('mailto'), 400);
    });

    on(box, 'click', '[data-act="mark-sent"]', () => logIt('copy'));

    on(box, 'click', '[data-act="queue"]', async () => {
      await api.post('/api/gmail/queue', {
        lead_ids: [Number(leadId)], template_id: Number(templateId),
      });
      toast('Queued — review and confirm in the Outbox');
      navigate('/outbox');
    });
  }
}

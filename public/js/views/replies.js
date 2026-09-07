/* Replies: what came back, what we read from it, and the mockup built from it. */
/* eslint-disable require-atomic-updates */
import { api } from '../api.js';
import {
  html, mount, on, toast, fmtDateTime, relative, modal, confirmDialog,
} from '../dom.js';

const CTA_LABEL = {
  call: 'Call now', quote: 'Get a quote', book: 'Book a visit',
  prices: 'See prices', gallery: 'See our work', enquire: 'Get in touch',
};
const CTAS = Object.keys(CTA_LABEL);

export default async function repliesView(root, _p, { refresh }) {
  const [data, ollama] = await Promise.all([
    api.get('/api/replies'),
    api.get('/api/ollama').catch(() => null),
  ]);
  const replies = data.replies ?? [];
  const gmail = data.gmail ?? {};

  mount(root, html`
    <div class="bar">
      <h2>Replies</h2>
      <div class="grow"></div>
      <button data-act="manual">Paste a reply</button>
      ${gmail.ready
        ? html`<button class="primary" data-act="sync">Check Gmail</button>`
        : ''}
    </div>

    ${!gmail.ready ? html`
      <div class="msg msg-warn" style="margin-bottom:10px"><div class="grow">
        <b>Not reading Gmail.</b> ${gmail.reason ?? ''}
        ${gmail.code === 'READ_DISABLED'
          ? html` Turn on <b>Read replies</b> in <a href="#/settings">Settings</a>.` : ''}
        <div class="tip" style="margin-top:6px">
          You can still paste a reply in by hand — it goes through exactly the same
          extraction and builds the same mockup.
        </div>
      </div></div>` : ''}

    ${ollama && !ollama.ok ? html`
      <div class="msg msg-info" style="margin-bottom:10px"><div class="grow">
        <b>Local model not running.</b> ${ollama.detail ?? ''}
        <div class="tip" style="margin-top:6px">
          ${ollama.fallback ?? ''}
          Install it for messier replies: <code class="mono">ollama pull ${ollama.model}</code>.
          It runs on this machine — free, private, and nothing is billed to any account.
        </div>
      </div></div>` : ''}

    ${!replies.length ? html`
      <div class="panel"><div class="panel-bd">
        <p class="tip">Nothing back yet. When a prospect replies, it lands here with the
          brief already pulled out of it — services, what they want visitors to do,
          whether they have a logo — and one button builds them a four-page site.</p>
      </div></div>`
    : replies.map((r) => replyCard(r))}
  `);

  /* ---- sync ---- */

  on(root, 'click', '[data-act="sync"]', async (_e, btn) => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.innerHTML = '<span class="spin"></span> Checking…';
    try {
      const out = await api.post('/api/replies/sync', {});
      if (!out.ok) {
        toast(out.reason ?? 'Could not read Gmail', { error: true, ms: 7000 });
      } else {
        toast(out.stored
          ? `${out.stored} new repl${out.stored === 1 ? 'y' : 'ies'}`
          : 'Nothing new');
        if (out.errors?.length) {
          toast(out.errors.join('; '), { error: true, ms: 8000 });
        }
      }
      refresh();
    } catch (err) {
      toast(err.message, { error: true, ms: 7000 });
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  /* ---- paste a reply by hand ---- */

  on(root, 'click', '[data-act="manual"]', async () => {
    const leads = (await api.leads.list({ limit: 200 })).leads ?? [];
    const ok = await modal({
      title: 'Paste a reply',
      wide: true,
      body: html`
        <p class="tip">For a reply that came by WhatsApp, text, or over the phone —
          anything not in the Gmail inbox. It goes through the same extraction.</p>
        <div class="f">
          <label for="mr-lead">Lead</label>
          <select id="mr-lead" name="lead_id" required>
            <option value="">— pick the business —</option>
            ${leads.map((l) => html`<option value="${l.id}">${l.business_name}${l.location ? ` — ${l.location}` : ''}</option>`)}
          </select>
        </div>
        <div class="f">
          <label for="mr-channel">Came in by</label>
          <select id="mr-channel" name="channel">
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">Text</option>
            <option value="email">Email</option>
            <option value="manual" selected>Phone call / other</option>
          </select>
        </div>
        <div class="f">
          <label for="mr-body">What they said</label>
          <textarea id="mr-body" name="body" rows="8" required
            placeholder="1. Roofing and guttering&#10;2. No logo, will send photos&#10;3. Want people to ring us"></textarea>
          <p class="tip">Numbered answers extract best, but plain prose works too.</p>
        </div>`,
      footer: html`
        <button data-close class="ghost">Cancel</button>
        <button data-submit class="primary">Save and extract</button>`,
      onSubmit: async (form) => {
        if (!form.lead_id) throw new Error('Pick which business replied');
        if (!form.body?.trim()) throw new Error('Paste what they wrote');
        await api.post('/api/replies/manual', {
          lead_id: Number(form.lead_id),
          channel: form.channel,
          body: form.body,
        });
        return true;
      },
    });
    if (ok) { toast('Reply saved and read'); refresh(); }
  });

  /* ---- per-reply actions ---- */

  on(root, 'click', '[data-act="reextract"]', async (_e, el) => {
    el.disabled = true;
    try {
      const out = await api.post(`/api/replies/${el.dataset.id}/extract`, {});
      toast(out.brief?.model_error
        ? `Re-read with rules only — ${out.brief.model_error}`
        : `Re-read (${out.brief?.source ?? 'rules'})`);
      refresh();
    } catch (err) {
      toast(err.message, { error: true });
      el.disabled = false;
    }
  });

  on(root, 'click', '[data-act="edit-brief"]', async (_e, el) => {
    const reply = replies.find((r) => String(r.id) === el.dataset.id);
    if (!reply?.brief) return;
    const b = reply.brief;
    const ok = await modal({
      title: `Brief — ${reply.business_name ?? 'lead'}`,
      wide: true,
      body: html`
        <div class="f">
          <label for="eb-name">Name to put on the site</label>
          <input id="eb-name" name="trading_name" type="text"
                 value="${b.trading_name ?? ''}"
                 placeholder="${reply.business_name ?? ''}" autocomplete="off">
          <p class="tip">What goes on the masthead. Usually shorter than the registered
            name — "Hillside Roofing" rather than "HILLSIDE ROOFING LIMITED".
            Left blank, the registered name is tidied and used.</p>
        </div>
        <div class="f">
          <label for="eb-services">Services <span class="opt">one per line</span></label>
          <textarea id="eb-services" name="services" rows="5">${(b.services ?? []).join('\n')}</textarea>
        </div>
        <div class="cols">
          <div class="f">
            <label for="eb-cta">What should a visitor do first?</label>
            <select id="eb-cta" name="primary_cta">
              ${CTAS.map((c) => html`<option value="${c}" ${b.primary_cta === c ? 'selected' : ''}>${CTA_LABEL[c]}</option>`)}
            </select>
            <p class="tip">This decides the hero and what the whole site is built around.</p>
          </div>
          <div class="f">
            <label for="eb-areas">Areas covered <span class="opt">one per line</span></label>
            <textarea id="eb-areas" name="areas" rows="4">${(b.areas ?? []).join('\n')}</textarea>
          </div>
        </div>
        <div class="f">
          <label for="eb-colours">Brand colours <span class="opt">one per line — a name or a #hex</span></label>
          <textarea id="eb-colours" name="brand_colours" rows="2">${(b.brand_colours ?? []).join('\n')}</textarea>
        </div>
        <div class="check">
          <input id="eb-logo" name="has_logo" type="checkbox" ${b.has_logo ? 'checked' : ''}>
          <label for="eb-logo">They have a logo</label>
        </div>
        <div class="check">
          <input id="eb-photos" name="has_photos" type="checkbox" ${b.has_photos ? 'checked' : ''}>
          <label for="eb-photos">They have photos of their work</label>
        </div>
        <div class="f" style="margin-top:10px">
          <label for="eb-notes">Notes</label>
          <textarea id="eb-notes" name="notes" rows="3">${b.notes ?? ''}</textarea>
        </div>`,
      footer: html`
        <button data-close class="ghost">Cancel</button>
        <button data-submit class="primary">Save brief</button>`,
      onSubmit: async (form) => {
        await api.patch(`/api/replies/${reply.id}/brief`, {
          trading_name: form.trading_name,
          services: form.services,
          primary_cta: form.primary_cta,
          areas: form.areas,
          brand_colours: form.brand_colours,
          has_logo: form.has_logo === 'on',
          has_photos: form.has_photos === 'on',
          notes: form.notes,
        });
        return true;
      },
    });
    if (ok) { toast('Brief saved'); refresh(); }
  });

  on(root, 'click', '[data-act="build"]', async (_e, el) => {
    el.disabled = true;
    el.innerHTML = '<span class="spin"></span> Building…';
    try {
      const out = await api.post('/api/mockups', { reply_id: Number(el.dataset.id) });
      toast('Mockup built');
      window.open(out.mockup.url, '_blank', 'noopener');
      refresh();
    } catch (err) {
      toast(err.message, { error: true, ms: 7000 });
      el.disabled = false;
      el.textContent = 'Build mockup';
    }
  });

  on(root, 'click', '[data-act="rebuild"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'Build it again',
      message: 'Generates a fresh mockup at a new link. The old link keeps working '
             + 'until you delete it, so anything already sent is not broken.',
      confirmLabel: 'Rebuild',
    })) return;
    try {
      const out = await api.post('/api/mockups', { reply_id: Number(el.dataset.id) });
      window.open(out.mockup.url, '_blank', 'noopener');
      refresh();
    } catch (err) { toast(err.message, { error: true }); }
  });

  on(root, 'click', '[data-act="copy-link"]', async (_e, el) => {
    const url = new URL(el.dataset.url, location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast(url, { ms: 9000 });
    }
  });
}

/* ------------------------------------------------------------- rendering */

function replyCard(r) {
  const b = r.brief;
  return html`
    <div class="panel">
      <div class="panel-hd">
        <h3 class="grow">${r.business_name ?? r.from_address ?? 'Unknown'}
          ${r.location ? html`<span class="meta" style="font-weight:400"> — ${r.location}</span>` : ''}
        </h3>
        <span class="meta">${r.channel}</span>
        <span class="meta nw" title="${fmtDateTime(r.received_at)}">${relative(r.received_at)}</span>
      </div>
      <div class="panel-bd">
        ${r.subject ? html`<div class="meta" style="margin-bottom:6px">${r.subject}</div>` : ''}
        <div style="white-space:pre-wrap;border-left:3px solid var(--line);padding-left:12px;
                    margin-bottom:14px;color:var(--muted);font-size:.94rem">${r.body}</div>

        ${b ? briefPanel(r, b) : html`
          <div class="msg msg-warn"><div class="grow">
            No brief yet.
            <button class="mini" data-act="reextract" data-id="${r.id}">Read it</button>
          </div></div>`}
      </div>
    </div>`;
}

function briefPanel(r, b) {
  const gaps = [];
  if (!b.services?.length) gaps.push('services');
  if (!b.primary_cta) gaps.push('what visitors should do');

  return html`
    <div class="readout" style="margin-bottom:12px">
      <div><b class="num" style="font-size:1rem">${(b.services ?? []).length}</b><span>Services</span></div>
      <div><b class="num" style="font-size:1rem">${b.primary_cta ? CTA_LABEL[b.primary_cta] : '—'}</b><span>Main action</span></div>
      <div><b class="num" style="font-size:1rem">${b.has_photos ? 'Yes' : 'No'}</b><span>Has photos</span></div>
      <div data-accent="${b.confidence >= 70 ? '' : 'warn'}">
        <b class="num" style="font-size:1rem">${b.confidence}%</b><span>Confidence</span></div>
      <div><b class="num" style="font-size:1rem">${b.source === 'rules' ? 'Rules' : 'Rules + model'}</b><span>Read by</span></div>
    </div>

    ${b.trading_name && b.trading_name !== r.business_name ? html`
      <p class="tip">Site will be titled <b>${b.trading_name}</b>
        <span class="meta">(registered as ${r.business_name})</span></p>` : ''}

    ${b.services?.length ? html`
      <p class="tip">
        ${b.services.map((s) => html`<span class="flag" data-ok style="margin-right:4px">${s}</span>`)}
        ${(b.areas ?? []).map((a) => html`<span class="flag" style="margin-right:4px">${a}</span>`)}
      </p>` : ''}

    ${gaps.length ? html`
      <div class="msg msg-warn" style="margin-bottom:10px"><div class="grow">
        Could not work out: ${gaps.join(', ')}. Fill it in and the site will be
        properly theirs rather than generic.
      </div></div>` : ''}

    <div class="bar">
      <button class="mini" data-act="edit-brief" data-id="${r.id}">Edit brief</button>
      <button class="mini ghost" data-act="reextract" data-id="${r.id}">Read again</button>
      <div class="grow"></div>
      ${r.mockup ? html`
        <a class="btn mini" href="${r.mockup.token ? `/m/${r.mockup.token}/` : '#'}"
           target="_blank" rel="noopener">Open mockup</a>
        <button class="mini" data-act="copy-link" data-url="/m/${r.mockup.token}/">Copy link</button>
        <button class="mini ghost" data-act="rebuild" data-id="${r.id}">Rebuild</button>
      ` : html`
        <button class="primary" data-act="build" data-id="${r.id}">Build mockup</button>
      `}
    </div>
    ${r.mockup ? html`
      <p class="tip">Built ${relative(r.mockup.generated_at)} — four pages, on a private link.
        Paste it into your reply; nobody finds it without the link.</p>` : ''}`;
}

/* Template manager: create, edit, delete, with a live placeholder preview. */
import { api } from '../api.js';
import { html, mount, on, modal, confirmDialog, toast, fmtDate } from '../dom.js';

const SAMPLE = { business_name: 'Hillside Roofing', category: 'roofers', location: 'Otley',
                 phone: '01943 000000', email: 'hello@example.co.uk' };

const STARTERS = [
  {
    name: 'First contact — no website',
    subject: 'A website for {{business}}?',
    body: `Hi,

I came across {{business}} while looking for {{category}} in {{location}}, and noticed you don't seem to have a website yet.

I build simple, fast websites for small trades and local businesses — usually a single page with what you do, the areas you cover, photos of past work, and a click-to-call button so people on their phone can reach you in one tap.

If that's of any interest, I'd be glad to put together a rough mock-up of what {{business}} could look like, free and with no obligation. Just reply and let me know.

Best wishes,`,
  },
  {
    name: 'Follow-up — one week later',
    subject: 'Following up — {{business}}',
    body: `Hi,

I wrote last week about putting a website together for {{business}}. I know how it goes when you're busy on the tools, so this is just a short nudge in case it got buried.

Still happy to mock something up at no cost if you'd like to see what it would look like. And if it's not for you, no problem at all — just say and I won't email again.

Best wishes,`,
  },
];

function editorBody(t = {}) {
  return html`
    <div class="field">
      <label for="t-name">Template name</label>
      <input id="t-name" name="name" type="text" required value="${t.name ?? ''}"
             placeholder="e.g. First contact — no website" autocomplete="off">
    </div>
    <div class="field">
      <label for="t-subject">Subject line</label>
      <input id="t-subject" name="subject" type="text" required value="${t.subject ?? ''}"
             placeholder="A website for {{business}}?" autocomplete="off">
    </div>
    <div class="field">
      <label for="t-body">Body</label>
      <textarea id="t-body" name="body" class="body-editor" required>${t.body ?? ''}</textarea>
      <p class="hint">
        Placeholders: <code>{{business}}</code> <code>{{category}}</code> <code>{{location}}</code>
        — also <code>{{phone}}</code> <code>{{email}}</code>.
        Your business details and the opt-out line are appended automatically to every email; don't repeat them here.
      </p>
    </div>
    <div class="field">
      <label>Preview <span class="opt">(with sample data)</span></label>
      <div class="preview">
        <div class="preview-head"><dl>
          <dt>Subject</dt><dd class="subject" data-pv="subject"></dd>
        </dl></div>
        <div class="preview-body" data-pv="body" style="max-height:220px"></div>
      </div>
    </div>`;
}

/** Mirror the same substitution the server does, for the live preview. */
function fill(str, lead) {
  const ctx = {
    business: lead.business_name, category: lead.category, location: lead.location,
    phone: lead.phone, email: lead.email,
    first_name: String(lead.business_name).split(/\s+/)[0],
  };
  return String(str ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) =>
    Object.prototype.hasOwnProperty.call(ctx, k.toLowerCase()) ? (ctx[k.toLowerCase()] ?? '') : m);
}

function wirePreview(root) {
  const sync = () => {
    const subject = root.querySelector('#t-subject')?.value ?? '';
    const body = root.querySelector('#t-body')?.value ?? '';
    root.querySelector('[data-pv="subject"]').textContent = fill(subject, SAMPLE) || '(no subject)';
    root.querySelector('[data-pv="body"]').textContent = fill(body, SAMPLE) || '(empty)';
  };
  root.querySelector('#t-subject')?.addEventListener('input', sync);
  root.querySelector('#t-body')?.addEventListener('input', sync);
  sync();
}

async function openEditor(t) {
  const editing = Boolean(t?.id);
  return modal({
    title: editing ? `Edit "${t.name}"` : 'New template',
    wide: true,
    body: editorBody(t),
    footer: html`
      <button type="button" data-close>Cancel</button>
      <button type="submit" class="primary">${editing ? 'Save template' : 'Create template'}</button>`,
    onMount: wirePreview,
    onSubmit: async (data) => {
      const res = editing
        ? await api.templates.update(t.id, data)
        : await api.templates.create(data);
      res.warnings?.forEach((w) => toast(w, { error: true, ms: 6000 }));
      toast(editing ? 'Template saved' : 'Template created');
      return res.template;
    },
  });
}

export default async function templatesView(root, _params, { refresh }) {
  const { templates } = await api.templates.list();

  mount(root, html`
    <div class="view-head">
      <div>
        <h2>Templates</h2>
        <p class="lede">The emails you send. Placeholders are filled in from each lead when you compose.</p>
      </div>
      <div class="spacer"></div>
      ${templates.length === 0 ? html`<button data-act="starters">Add starter templates</button>` : ''}
      <button class="primary" data-act="new">+ New template</button>
    </div>

    ${templates.length === 0 ? html`
      <div class="card"><div class="empty">
        <h3>No templates yet</h3>
        <p>Write one from scratch, or drop in two ready-made starters you can edit.</p>
        <p style="margin-top:14px">
          <button data-act="starters">Add starter templates</button>
          <button class="primary" data-act="new">+ New template</button>
        </p>
      </div></div>` : templates.map((t) => html`
      <div class="card">
        <div class="card-head">
          <h3 style="flex:1">${t.name}</h3>
          <span class="sub">Updated ${fmtDate(t.updated_at)}</span>
          <button class="tiny" data-act="edit" data-id="${t.id}">Edit</button>
          <button class="tiny danger" data-act="delete" data-id="${t.id}" data-name="${t.name}">Delete</button>
        </div>
        <div class="card-body">
          <div class="preview">
            <div class="preview-head"><dl>
              <dt>Subject</dt><dd class="subject">${t.subject}</dd>
            </dl></div>
            <div class="preview-body" style="max-height:190px">${t.body}</div>
          </div>
        </div>
      </div>`)}
  `);

  on(root, 'click', '[data-act="new"]', async () => { if (await openEditor()) refresh(); });

  on(root, 'click', '[data-act="edit"]', async (_e, el) => {
    const t = templates.find((x) => String(x.id) === el.dataset.id);
    if (await openEditor(t)) refresh();
  });

  on(root, 'click', '[data-act="delete"]', async (_e, el) => {
    const ok = await confirmDialog({
      title: 'Delete template',
      message: `Delete "${el.dataset.name}"? Emails already sent with it keep their own copy in the sent log.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    await api.templates.remove(el.dataset.id);
    toast('Template deleted');
    refresh();
  });

  on(root, 'click', '[data-act="starters"]', async () => {
    for (const s of STARTERS) {
      try { await api.templates.create(s); } catch (err) {
        if (err.status !== 409) throw err;
      }
    }
    toast('Starter templates added — edit them to sound like you');
    refresh();
  });
}

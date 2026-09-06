/* Templates: the wording, with a live preview against sample data. */
import { api } from '../api.js';
import { html, mount, on, modal, confirmDialog, toast, fmtDate } from '../dom.js';

const SAMPLE = {
  business_name: 'Hillside Roofing Ltd', category: 'roofers', location: 'Otley',
  phone: '01943 000000', email: 'info@hillsideroofing.co.uk',
};

const STARTERS = [
  {
    name: 'First contact',
    subject: 'Website for {{business}}?',
    body: `Hi,

I was looking for {{category}} in {{location}} and came across {{business}}, but couldn't find a website for you.

I build simple one-page sites for local trades — what you do, the areas you cover, a few photos, and a button that dials you straight from a phone.

Happy to mock something up so you can see it, free and no obligation. Worth a look?

Best,`,
  },
  {
    name: 'Follow-up',
    subject: 'Following up — {{business}}',
    body: `Hi,

I wrote last week about a website for {{business}}. Just a short nudge in case it got buried.

Still glad to put a mock-up together if you'd like to see one. And if it's not for you, say the word and I won't write again.

Best,`,
  },
];

function fill(str, lead) {
  const ctx = {
    business: lead.business_name, category: lead.category, location: lead.location,
    phone: lead.phone, email: lead.email,
    first_name: String(lead.business_name).split(/\s+/)[0],
  };
  return String(str ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) =>
    Object.prototype.hasOwnProperty.call(ctx, k.toLowerCase()) ? (ctx[k.toLowerCase()] ?? '') : m);
}

async function openEditor(t) {
  const editing = Boolean(t?.id);
  return modal({
    title: editing ? t.name : 'New template',
    wide: true,
    body: html`
      <div class="cols">
        <div class="f">
          <label for="t-name">Name</label>
          <input id="t-name" name="name" type="text" required value="${t?.name ?? ''}" autocomplete="off">
        </div>
        <div class="f">
          <label for="t-subject">Subject</label>
          <input id="t-subject" name="subject" type="text" required value="${t?.subject ?? ''}" autocomplete="off">
        </div>
      </div>
      <div class="f">
        <label for="t-body">Body</label>
        <textarea id="t-body" name="body" class="code" required>${t?.body ?? ''}</textarea>
        <p class="tip">
          <code>{{business}}</code> <code>{{category}}</code> <code>{{location}}</code>
          <code>{{phone}}</code> <code>{{email}}</code>.
          Your details and the opt-out line are added automatically.
        </p>
      </div>
      <div class="f">
        <label>Preview</label>
        <div class="mail">
          <div class="mail-hd"><dl><dt>Subject</dt><dd class="subj" data-pv="subject"></dd></dl></div>
          <div class="mail-bd" data-pv="body" style="max-height:200px"></div>
        </div>
      </div>`,
    footer: html`
      <button type="button" data-close>Cancel</button>
      <button type="submit" class="primary">${editing ? 'Save' : 'Create'}</button>`,
    onMount: (root) => {
      const sync = () => {
        root.querySelector('[data-pv="subject"]').textContent =
          fill(root.querySelector('#t-subject')?.value ?? '', SAMPLE) || '(no subject)';
        root.querySelector('[data-pv="body"]').textContent =
          fill(root.querySelector('#t-body')?.value ?? '', SAMPLE) || '(empty)';
      };
      root.querySelector('#t-subject')?.addEventListener('input', sync);
      root.querySelector('#t-body')?.addEventListener('input', sync);
      sync();
    },
    onSubmit: async (d) => {
      const res = editing ? await api.templates.update(t.id, d) : await api.templates.create(d);
      res.warnings?.forEach((w) => toast(w, { error: true, ms: 6000 }));
      toast(editing ? 'Saved' : 'Created');
      return res.template;
    },
  });
}

export default async function templatesView(root, _p, { refresh }) {
  const { templates } = await api.templates.list();

  mount(root, html`
    <div class="bar">
      <h2>Templates</h2>
      <div class="grow"></div>
      ${templates.length === 0 ? html`<button data-act="starters">Add two starters</button>` : ''}
      <button class="primary" data-act="new">New template</button>
    </div>

    ${templates.length === 0 ? html`
      <div class="panel"><div class="blank">
        <strong>No templates</strong>
        Write one, or drop in two you can edit.
      </div></div>` : templates.map((t) => html`
      <div class="panel">
        <div class="panel-hd">
          <h3 class="grow">${t.name}</h3>
          <span class="meta">${fmtDate(t.updated_at)}</span>
          <button class="mini" data-act="edit" data-id="${t.id}">Edit</button>
          <button class="mini danger" data-act="del" data-id="${t.id}" data-name="${t.name}">Delete</button>
        </div>
        <div class="panel-bd">
          <div class="mail">
            <div class="mail-hd"><dl><dt>Subject</dt><dd class="subj">${t.subject}</dd></dl></div>
            <div class="mail-bd" style="max-height:170px">${t.body}</div>
          </div>
        </div>
      </div>`)}
  `);

  on(root, 'click', '[data-act="new"]', async () => { if (await openEditor()) refresh(); });

  on(root, 'click', '[data-act="edit"]', async (_e, el) => {
    const t = templates.find((x) => String(x.id) === el.dataset.id);
    if (await openEditor(t)) refresh();
  });

  on(root, 'click', '[data-act="del"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'Delete template',
      message: `Delete "${el.dataset.name}"? Emails already sent keep their own copy.`,
      confirmLabel: 'Delete', danger: true,
    })) return;
    await api.templates.remove(el.dataset.id);
    toast('Deleted');
    refresh();
  });

  on(root, 'click', '[data-act="starters"]', async () => {
    for (const s of STARTERS) {
      try { await api.templates.create(s); } catch (err) { if (err.status !== 409) throw err; }
    }
    toast('Added — edit them to sound like you');
    refresh();
  });
}

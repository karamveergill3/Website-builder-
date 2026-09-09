/* Templates: the wording, with a live preview against sample data. */
import { api } from '../api.js';
import { html, mount, on, modal, confirmDialog, toast, fmtDate } from '../dom.js';

const SAMPLE = {
  business_name: 'Hillside Roofing Ltd', category: 'roofers', location: 'Otley',
  phone: '07700 900123', email: 'info@hillsideroofing.co.uk',
};

const CHANNELS = [
  { c: 'email',    label: 'Email',    note: 'Your details and the opt-out line are appended automatically.' },
  { c: 'whatsapp', label: 'WhatsApp', note: 'No subject, and nothing is appended — say who you are and how to stop, in the message.' },
  { c: 'sms',      label: 'SMS',      note: 'Same again, and every 160 characters is another segment.' },
];


function fill(str, lead, me = {}) {
  const ctx = {
    business: lead.business_name, category: lead.category, location: lead.location,
    phone: lead.phone, email: lead.email,
    first_name: String(lead.business_name).split(/\s+/)[0],
    // The sender half, from Settings — so the preview shows the message as it
    // will actually go out rather than a page of {{my_name}}.
    my_name: me.biz_contact_name ?? '', my_business: me.biz_name ?? '',
    my_phone: me.biz_phone ?? '', my_email: me.biz_email ?? '',
    my_website: me.biz_website ?? '',
  };
  return String(str ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) =>
    Object.prototype.hasOwnProperty.call(ctx, k.toLowerCase()) ? (ctx[k.toLowerCase()] ?? '') : m);
}

async function openEditor(t, me = {}) {
  const editing = Boolean(t?.id);
  const channel = t?.channel ?? 'email';
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
          <label for="t-channel">Channel</label>
          <select id="t-channel" name="channel">
            ${CHANNELS.map((c) => html`
              <option value="${c.c}" ${channel === c.c ? 'selected' : ''}>${c.label}</option>`)}
          </select>
        </div>
      </div>
      <div class="f" data-subject-row>
        <label for="t-subject">Subject</label>
        <input id="t-subject" name="subject" type="text" value="${t?.subject ?? ''}" autocomplete="off">
      </div>
      <div class="f">
        <label for="t-body">Body</label>
        <textarea id="t-body" name="body" class="code" required>${t?.body ?? ''}</textarea>
        <p class="tip">
          About them: <code>{{business}}</code> <code>{{category}}</code>
          <code>{{location}}</code> <code>{{phone}}</code> <code>{{email}}</code>.
          About you, from Settings: <code>{{my_name}}</code>
          <code>{{my_business}}</code> <code>{{my_phone}}</code>
          <code>{{my_email}}</code> <code>{{my_website}}</code>.
        </p>
        <p class="tip" data-channel-note></p>
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
      const pick = () => root.querySelector('#t-channel')?.value ?? 'email';
      const sync = () => {
        const c = pick();
        const meta = CHANNELS.find((x) => x.c === c);
        // Only email has a subject line, so hiding the field is the honest
        // way to say so — a blank box the server then rejects is not.
        const row = root.querySelector('[data-subject-row]');
        if (row) row.hidden = c !== 'email';
        const body = fill(root.querySelector('#t-body')?.value ?? '', SAMPLE, me);
        root.querySelector('[data-pv="subject"]').textContent =
          fill(root.querySelector('#t-subject')?.value ?? '', SAMPLE, me) || '(no subject)';
        root.querySelector('[data-pv="body"]').textContent = body || '(empty)';
        const note = root.querySelector('[data-channel-note]');
        if (note) {
          note.textContent = `${meta?.note ?? ''} `
            + (c === 'email' ? '' : `${body.length} characters`
               + (c === 'sms' ? ` — ${Math.max(1, Math.ceil(body.length / 160))} text(s)` : ''));
        }
      };
      root.querySelector('#t-subject')?.addEventListener('input', sync);
      root.querySelector('#t-body')?.addEventListener('input', sync);
      root.querySelector('#t-channel')?.addEventListener('change', sync);
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
  const [{ templates }, settings] = await Promise.all([
    api.templates.list(),
    api.settings.get().catch(() => ({ settings: {} })),
  ]);
  const me = settings.settings ?? {};

  const byChannel = CHANNELS.map((c) => ({
    ...c,
    rows: templates.filter((t) => (t.channel ?? 'email') === c.c),
  }));

  mount(root, html`
    <div class="bar">
      <h2>Templates</h2>
      <div class="grow"></div>
      <button class="primary" data-act="starters" title="Puts back any of the shipped messages you have deleted">
        ${templates.length === 0 ? 'Add the starters' : 'Restore missing starters'}
      </button>
    </div>

    ${templates.length === 0 ? html`
      <div class="panel"><div class="blank">
        <strong>No templates</strong>
        Add the starters — a first message for email, WhatsApp and SMS — then
        edit them until they sound like you.
      </div></div>` : byChannel.map((group) => html`
      <div class="bar" style="margin-top:14px">
        <h3 style="margin:0">${group.label}</h3>
        <span class="meta">${group.note}</span>
      </div>
      ${group.rows.length === 0 ? html`
        <div class="panel"><div class="blank">
          <strong>No ${group.label} wording yet</strong>
          The Reach screen cannot offer ${group.label} without it.
        </div></div>` : group.rows.map((t) => html`
        <div class="panel">
          <div class="panel-hd">
            <h3 class="grow">${t.name}</h3>
            <span class="meta">${fmtDate(t.updated_at)}</span>
            <button class="mini" data-act="edit" data-id="${t.id}">Edit</button>
            <button class="mini danger" data-act="del" data-id="${t.id}" data-name="${t.name}">Delete</button>
          </div>
          <div class="panel-bd">
            <div class="mail">
              ${t.channel === 'email' || !t.channel ? html`
                <div class="mail-hd"><dl><dt>Subject</dt><dd class="subj">${fill(t.subject, SAMPLE, me)}</dd></dl></div>` : ''}
              <div class="mail-bd" style="max-height:170px">${fill(t.body, SAMPLE, me)}</div>
            </div>
            <p class="tip">Shown filled in for a sample business. Each lead gets its own.</p>
          </div>
        </div>`)}`)}
  `);

  on(root, 'click', '[data-act="edit"]', async (_e, el) => {
    const t = templates.find((x) => String(x.id) === el.dataset.id);
    if (await openEditor(t, me)) refresh();
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
    const res = await api.templates.starters();
    toast(res.added
      ? `Added ${res.added} — edit them to sound like you`
      : 'Nothing missing; you already have all of them');
    if (res.added) refresh();
  });
}

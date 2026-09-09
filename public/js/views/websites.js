/* Websites: the shared library of finished, handed-over sites. */
import { api } from '../api.js';
import { html, mount, on, $, modal, confirmDialog, toast, fmtDateTime } from '../dom.js';

const fmtSize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

async function openArchiveForm(clients) {
  return modal({
    title: 'Archive a finished site',
    body: html`
      <p class="tip" style="margin-top:0">
        Upload the finished site's ZIP. It goes into the shared library so anyone
        on the team can pull it back later. Logins are <b>not</b> stored here —
        those go in the handover letter to the client.
      </p>
      <div class="f">
        <label for="w-client">Client <span class="opt">optional</span></label>
        <select id="w-client" name="client_id">
          <option value="">— or just type a name below —</option>
          ${clients.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
        </select>
      </div>
      <div class="f">
        <label for="w-name">Business name</label>
        <input id="w-name" name="business_name" type="text" placeholder="Hillside Roofing Ltd">
      </div>
      <div class="cols">
        <div class="f"><label for="w-domain">Domain <span class="opt">optional</span></label>
          <input id="w-domain" name="domain" type="text" placeholder="hillsideroofing.co.uk"></div>
        <div class="f"><label for="w-host">Hosted on <span class="opt">optional</span></label>
          <input id="w-host" name="host" type="text" placeholder="Netlify (client's account)"></div>
      </div>
      <div class="f">
        <label for="w-notes">Notes <span class="opt">optional</span></label>
        <input id="w-notes" name="notes" type="text" placeholder="Handed over 09/26, domain in their name">
      </div>
      <div class="f">
        <label for="w-file">Finished site ZIP</label>
        <input id="w-file" type="file" accept=".zip,application/zip">
        <p class="tip">Max 60 MB. The built site, zipped.</p>
      </div>`,
    footer: html`
      <button type="button" data-close>Cancel</button>
      <button type="submit" class="primary">Archive it</button>`,
    onSubmit: async (d, r) => {
      const file = $('#w-file', r).files[0];
      if (!file) throw new Error('Pick the site ZIP to upload.');
      if (!/\.zip$/i.test(file.name)) throw new Error('That needs to be a .zip file.');
      const client = clients.find((c) => String(c.id) === d.client_id);
      const business_name = (d.business_name || '').trim() || client?.name;
      if (!business_name) throw new Error('Pick a client or type a business name.');
      await api.websites.upload(file, {
        business_name,
        client_id: d.client_id || undefined,
        domain: d.domain || undefined,
        host: d.host || undefined,
        notes: d.notes || undefined,
      });
      toast(`Archived ${business_name}`);
      return true;
    },
  });
}

export default async function websitesView(root, _p, { refresh }) {
  const [{ sites, disk_used: disk }, clients] = await Promise.all([
    api.websites.list(),
    api.invoices.clients().then((r) => r.clients).catch(() => []),
  ]);

  mount(root, html`
    <div class="bar">
      <h2>Websites</h2>
      <span class="meta">Finished sites, handed over — shared with the whole team</span>
      <div class="grow"></div>
      <span class="meta">${fmtSize(disk)} stored</span>
      <button class="primary" data-act="archive">Archive a site</button>
    </div>

    <div class="panel">
      ${sites.length === 0 ? html`
        <div class="blank"><strong>Nothing archived yet</strong>
          When a build is done and handed over, upload its ZIP here so the team
          keeps a copy — and it drops off your active work.</div>` : html`
        <div class="scroll-x"><table class="rows">
          <thead><tr>
            <th>Business</th><th>Domain</th><th>Hosted on</th>
            <th class="num">Size</th><th class="nw">Archived</th><th></th>
          </tr></thead>
          <tbody>
            ${sites.map((s) => html`
              <tr>
                <td class="c-name"><span class="name">${s.business_name}</span>
                  ${s.notes ? html`<span class="meta">${s.notes}</span>` : ''}</td>
                <td class="meta">${s.domain ?? '—'}</td>
                <td class="meta">${s.host ?? '—'}</td>
                <td class="meta num">${fmtSize(s.file_size)}</td>
                <td class="meta nw">${fmtDateTime(s.archived_at)}
                  ${s.archived_by_name ? html`<span class="meta" style="display:block">by ${s.archived_by_name}</span>` : ''}</td>
                <td class="c-act">
                  <a class="mini" href="${api.websites.downloadUrl(s.id)}">Download</a>
                  <button class="mini danger" data-act="del" data-id="${s.id}" data-name="${s.business_name}">✕</button>
                </td>
              </tr>`)}
          </tbody>
        </table></div>`}
    </div>
  `);

  on(root, 'click', '[data-act="archive"]', async () => {
    if (await openArchiveForm(clients)) refresh();
  });

  on(root, 'click', '[data-act="del"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'Remove from archive',
      message: `Delete the archived site for ${el.dataset.name}? The ZIP is removed for good.`,
      confirmLabel: 'Delete', danger: true,
    })) return;
    await api.websites.remove(el.dataset.id);
    toast('Removed');
    refresh();
  });
}

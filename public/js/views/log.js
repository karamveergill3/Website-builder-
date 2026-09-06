/* Sent log: what went out, to whom, when. */
import { api } from '../api.js';
import { html, mount, on, modal, fmtDateTime } from '../dom.js';

const VIA = { mailto: 'Mail app', copy: 'Copied', gmail: 'Gmail' };

export default async function logView(root) {
  const { entries, total } = await api.emails.history({ limit: 300 });

  mount(root, html`
    <div class="bar">
      <h2>Sent</h2>
      <div class="grow"></div>
      ${total ? html`<span class="meta">${total} logged</span>` : ''}
    </div>

    ${entries.length === 0 ? html`
      <div class="panel"><div class="blank">
        <strong>Nothing sent yet</strong>
        Emails you copy, draft or send through Gmail all land here.
      </div></div>` : html`
      <div class="panel"><div class="scroll-x">
        <table class="rows">
          <thead><tr><th>Business</th><th>To</th><th>Subject</th><th>Via</th><th class="nw">When</th><th></th></tr></thead>
          <tbody>
            ${entries.map((e) => html`
              <tr>
                <td class="c-name"><span class="name">${e.lead_name}</span>
                    ${e.lead_id ? '' : html`<span class="meta">lead deleted</span>`}</td>
                <td class="meta mono">${e.to_email || '—'}</td>
                <td class="meta">${e.subject_snapshot}</td>
                <td class="meta nw">${VIA[e.channel] ?? e.channel}</td>
                <td class="meta nw">${fmtDateTime(e.sent_at)}</td>
                <td class="c-act"><button class="mini" data-act="view" data-id="${e.id}">Open</button></td>
              </tr>`)}
          </tbody>
        </table>
      </div></div>`}
  `);

  on(root, 'click', '[data-act="view"]', (_ev, el) => {
    const e = entries.find((x) => String(x.id) === el.dataset.id);
    modal({
      title: e.lead_name,
      wide: true,
      body: html`
        <div class="mail">
          <div class="mail-hd"><dl>
            <dt>To</dt><dd class="mono">${e.to_email || '—'}</dd>
            <dt>Subject</dt><dd class="subj">${e.subject_snapshot}</dd>
            <dt>Sent</dt><dd>${fmtDateTime(e.sent_at)} · ${VIA[e.channel] ?? e.channel}</dd>
            ${e.provider_message_id ? html`<dt>ID</dt><dd class="mono">${e.provider_message_id}</dd>` : ''}
          </dl></div>
          <div class="mail-bd" style="max-height:none">${e.body_snapshot}</div>
        </div>`,
      footer: html`<button type="button" data-close>Close</button>`,
    });
  });
}

/* The sent log: proof of what went out, to whom, and when. */
import { api } from '../api.js';
import { html, mount, on, modal, fmtDateTime, esc } from '../dom.js';

const CHANNEL_LABEL = { mailto: 'Mail app', copy: 'Copied by hand', gmail: 'Gmail API' };

export default async function logView(root) {
  const { entries, total } = await api.emails.history({ limit: 300 });

  mount(root, html`
    <div class="view-head">
      <div>
        <h2>Sent log</h2>
        <p class="lede">
          Every email this tool produced, stored exactly as it went out. Snapshots are immutable —
          editing a template later does not rewrite history.
        </p>
      </div>
    </div>

    ${entries.length === 0 ? html`
      <div class="card"><div class="empty">
        <h3>Nothing sent yet</h3>
        <p>Emails you copy, draft, or send through Gmail all land here.</p>
      </div></div>` : html`
      <div class="card">
        <div class="table-scroll">
        <table class="ledger">
          <thead><tr>
            <th>Business</th><th>To</th><th>Subject</th><th>Channel</th><th class="nowrap">Sent</th><th></th>
          </tr></thead>
          <tbody>
            ${entries.map((e) => html`
              <tr>
                <td><span class="biz">${e.lead_name}</span>
                    ${e.lead_id ? '' : html`<span class="sub">lead since deleted</span>`}</td>
                <td class="sub mono">${e.to_email || '—'}</td>
                <td class="sub">${e.subject_snapshot}</td>
                <td class="sub nowrap">${CHANNEL_LABEL[e.channel] ?? e.channel}</td>
                <td class="sub nowrap">${fmtDateTime(e.sent_at)}</td>
                <td><div class="rowactions">
                  <button class="tiny" data-act="view" data-id="${e.id}">View</button>
                </div></td>
              </tr>`)}
          </tbody>
        </table>
        </div>
      </div>
      <p class="hint" style="margin-top:10px">${total} email${total === 1 ? '' : 's'} logged.</p>`}
  `);

  on(root, 'click', '[data-act="view"]', (_ev, el) => {
    const e = entries.find((x) => String(x.id) === el.dataset.id);
    modal({
      title: `To ${e.lead_name}`,
      wide: true,
      body: html`
        <div class="preview">
          <div class="preview-head"><dl>
            <dt>To</dt><dd class="mono">${e.to_email || '—'}</dd>
            <dt>Subject</dt><dd class="subject">${e.subject_snapshot}</dd>
            <dt>Sent</dt><dd>${fmtDateTime(e.sent_at)} · ${CHANNEL_LABEL[e.channel] ?? e.channel}</dd>
            ${e.provider_message_id ? html`
              <dt>Msg ID</dt><dd class="mono" style="font-size:.78rem">${e.provider_message_id}</dd>` : ''}
          </dl></div>
          <div class="preview-body">${e.body_snapshot}</div>
        </div>`,
      footer: html`<button type="button" data-close>Close</button>`,
    });
  });
}

/* Outbox — connect Gmail, review every queued email in full, then one explicit
   confirmation sends them, spaced out and under a daily cap. */
import { api } from '../api.js';
import { html, mount, on, $, $$, modal, confirmDialog, toast, fmtDateTime } from '../dom.js';

let poller = null;

export default async function outboxView(root, _params, { refresh, navigate }) {
  clearInterval(poller);

  const status = await api.get('/api/gmail/status').catch(() => null);
  if (!status) {
    mount(root, html`
      <div class="view-head"><div><h2>Outbox</h2></div></div>
      <div class="card"><div class="empty">
        <h3>Gmail sending is unavailable</h3>
        <p>The Gmail routes failed to load. Check the server log.</p>
      </div></div>`);
    return;
  }

  if (!status.client_configured) {
    mount(root, html`
      <div class="view-head"><div>
        <h2>Outbox</h2>
        <p class="lede">Send reviewed emails through your own Gmail account.</p>
      </div></div>
      <div class="card"><div class="card-body">
        <div class="note note-warn"><div>
          <strong>Not set up yet.</strong> Add <code class="mono">GMAIL_CLIENT_ID</code> and
          <code class="mono">GMAIL_CLIENT_SECRET</code> to your <code class="mono">.env</code>,
          then restart the server.
        </div></div>
        <p style="margin-top:16px">
          You need an OAuth 2.0 client in the same Google Cloud project, with the Gmail API
          enabled. The walkthrough is in <code class="mono">docs/PHASE3-GMAIL.md</code>.
        </p>
        <p class="hint">Until then, Compose still gives you copy-and-paste and mail-app drafts.</p>
      </div></div>`);
    return;
  }

  if (!status.connected) {
    mount(root, html`
      <div class="view-head"><div>
        <h2>Outbox</h2>
        <p class="lede">Send reviewed emails through your own Gmail account.</p>
      </div></div>
      <div class="card"><div class="card-body" style="text-align:center;padding:46px 20px">
        <h3 style="margin-bottom:8px">Connect your Gmail</h3>
        <p class="hint" style="max-width:46ch;margin:0 auto 18px">
          You will be sent to Google to authorise this app. It asks only for permission to
          <strong>send</strong> mail — it cannot read your inbox, and it never sends anything
          you have not confirmed on this screen.
        </p>
        <button class="primary" data-act="connect">Connect Gmail</button>
        <p class="hint" style="margin-top:14px">Scopes requested: <code class="mono">${status.scopes.join(' ')}</code></p>
      </div></div>`);

    on(root, 'click', '[data-act="connect"]', async () => {
      const { url } = await api.get('/api/gmail/connect');
      window.location.href = url;
    });
    return;
  }

  await draw();

  async function draw() {
    const data = await api.get('/api/gmail/queue');
    const pending = data.pending;
    const done = data.queue.filter((q) => q.status !== 'pending');
    const run = data.active_send;
    const { cap, used, remaining } = data.daily;

    mount(root, html`
      <div class="view-head">
        <div>
          <h2>Outbox</h2>
          <p class="lede">
            Sending as <strong>${data.email ?? 'your Gmail account'}</strong> ·
            ${used} of ${cap} sent today · one email every ${data.delay_seconds}s.
          </p>
        </div>
        <div class="spacer"></div>
        <button class="tiny" data-act="disconnect">Disconnect</button>
      </div>

      ${run?.running ? html`
        <div class="note note-info" style="margin-bottom:14px">
          <div style="flex:1">
            <span class="spinner"></span>
            &nbsp;<strong>Sending ${run.done} of ${run.total}</strong> —
            ${run.sent} sent, ${run.failed} failed, ${run.skipped} skipped.
            Next in up to ${run.delay_seconds}s.
          </div>
          <button class="tiny danger" data-act="cancel">Stop</button>
        </div>` : run?.finished_at ? html`
        <div class="note ${run.failed ? 'note-warn' : 'note-info'}" style="margin-bottom:14px">
          <div><strong>Finished.</strong> ${run.sent} sent, ${run.failed} failed, ${run.skipped} skipped.
          ${run.stopped_reason ? html`<br>${run.stopped_reason}` : ''}</div>
        </div>` : ''}

      ${remaining === 0 ? html`
        <div class="note note-warn" style="margin-bottom:14px">
          <div><strong>Daily cap reached.</strong> ${used} sent today, cap is ${cap}.
          Raise it under <a href="#/settings">Settings</a> if you mean to — but a personal
          Gmail account that suddenly sends a lot of cold email is exactly what gets
          rate-limited or suspended.</div>
        </div>` : ''}

      <div class="card">
        <div class="card-head">
          <h3 style="flex:1">Awaiting your confirmation
            ${pending.length ? html`<span class="sub">— ${pending.length} email(s)</span>` : ''}</h3>
          ${pending.length ? html`
            <button class="tiny" data-act="clear">Discard all</button>
            <button class="primary" data-act="send" ${run?.running || remaining === 0 ? 'disabled' : ''}>
              Review and send ${Math.min(pending.length, remaining)}
            </button>` : ''}
        </div>
        ${pending.length === 0 ? html`
          <div class="empty">
            <h3>Nothing queued</h3>
            <p>Queue emails from <a href="#/compose">Compose</a>, or straight from the
               <a href="#/leads">lead list</a>.</p>
          </div>` : html`
          <div class="card-body" style="display:grid;gap:12px">
            ${pending.map((q) => html`
              <div class="preview">
                <div class="preview-head" style="display:flex;gap:12px;align-items:flex-start">
                  <dl style="flex:1">
                    <dt>To</dt><dd class="mono">${q.to_email}</dd>
                    <dt>Subject</dt><dd class="subject">${q.subject}</dd>
                  </dl>
                  <div style="display:flex;gap:6px;align-items:center">
                    <span class="sub">${q.business_name ?? 'deleted lead'}</span>
                    <button class="tiny" data-act="expand" data-id="${q.id}">Full text</button>
                    <button class="tiny danger" data-act="drop" data-id="${q.id}">Remove</button>
                  </div>
                </div>
                <div class="preview-body" style="max-height:260px">${q.body}</div>
                <div style="padding:8px 16px;border-top:1px solid var(--rule-soft);
                            background:var(--green-tint);font-size:.76rem;color:var(--green-deep)">
                  Includes your business details and the opt-out line — scroll the text above to read them.
                </div>
              </div>`)}
          </div>`}
      </div>

      ${done.length ? html`
        <div class="card">
          <div class="card-head"><h3 style="flex:1">Recent attempts</h3>
            <span class="sub">Every successful send is also in the <a href="#/log">sent log</a>.</span></div>
          <div class="table-scroll"><table class="ledger">
            <thead><tr><th>Business</th><th>To</th><th>Result</th><th>When</th></tr></thead>
            <tbody>
              ${done.slice(0, 40).map((q) => html`
                <tr>
                  <td><span class="biz">${q.business_name ?? '—'}</span></td>
                  <td class="sub mono">${q.to_email}</td>
                  <td>
                    <span class="status" data-s="${q.status === 'sent' ? 'won' : q.status === 'failed' ? 'lost' : 'new'}">
                      ${q.status}</span>
                    ${q.error ? html`<span class="sub" style="display:block">${q.error}</span>` : ''}
                  </td>
                  <td class="sub nowrap">${q.sent_at ? fmtDateTime(q.sent_at) : '—'}</td>
                </tr>`)}
            </tbody>
          </table></div>
        </div>` : ''}
    `);

    on(root, 'click', '[data-act="expand"]', (_e, el) => {
      const q = pending.find((x) => String(x.id) === el.dataset.id);
      modal({
        title: `To ${q.business_name ?? q.to_email}`,
        wide: true,
        body: html`<div class="preview">
          <div class="preview-head"><dl>
            <dt>To</dt><dd class="mono">${q.to_email}</dd>
            <dt>Subject</dt><dd class="subject">${q.subject}</dd>
          </dl></div>
          <div class="preview-body" style="max-height:none">${q.body}</div>
        </div>`,
        footer: html`<button type="button" data-close>Close</button>`,
      });
    });

    on(root, 'click', '[data-act="drop"]', async (_e, el) => {
      await api.del(`/api/gmail/queue/${el.dataset.id}`);
      toast('Removed from the queue');
      await draw();
    });

    on(root, 'click', '[data-act="clear"]', async () => {
      const ok = await confirmDialog({
        title: 'Discard queued emails',
        message: `Remove all ${pending.length} queued email(s)? Nothing has been sent, so nothing is lost.`,
        confirmLabel: 'Discard', danger: true,
      });
      if (!ok) return;
      await api.post('/api/gmail/queue/clear');
      await draw();
    });

    on(root, 'click', '[data-act="cancel"]', async () => {
      await api.post('/api/gmail/send/cancel');
      toast('Stopping after the current email');
    });

    on(root, 'click', '[data-act="disconnect"]', async () => {
      const ok = await confirmDialog({
        title: 'Disconnect Gmail',
        message: 'Prospect Book will no longer be able to send. Your sent log is kept.',
        confirmLabel: 'Disconnect', danger: true,
      });
      if (!ok) return;
      await api.post('/api/gmail/disconnect');
      refresh();
    });

    /* ---- the single explicit confirmation ---- */
    on(root, 'click', '[data-act="send"]', async () => {
      const willSend = pending.slice(0, remaining);
      const confirmed = await modal({
        title: `Send ${willSend.length} email${willSend.length === 1 ? '' : 's'}?`,
        wide: true,
        body: html`
          <div class="note note-warn" style="margin-bottom:14px"><div>
            This sends real email from <strong>${data.email}</strong>, one every
            ${data.delay_seconds} seconds. It cannot be undone once a message leaves.
          </div></div>
          <p style="margin-top:0">Going to:</p>
          <div class="table-scroll" style="max-height:280px;overflow-y:auto">
            <table class="ledger">
              <thead><tr><th>Business</th><th>Address</th><th>Subject</th></tr></thead>
              <tbody>
                ${willSend.map((q) => html`
                  <tr>
                    <td><span class="biz" style="font-size:.92rem">${q.business_name ?? '—'}</span></td>
                    <td class="sub mono">${q.to_email}</td>
                    <td class="sub">${q.subject}</td>
                  </tr>`)}
              </tbody>
            </table>
          </div>
          ${pending.length > remaining ? html`
            <p class="hint" style="margin-top:12px">
              ${pending.length - remaining} more stay queued — today's cap allows ${remaining} more.
            </p>` : ''}
          <div class="check" style="margin-top:16px">
            <input type="checkbox" id="ack" name="ack" required>
            <label for="ack">
              I have read these and I want them sent.
              Each carries my business details and an opt-out line.
            </label>
          </div>`,
        footer: html`
          <button type="button" data-close>Cancel</button>
          <button type="submit" class="primary">Send ${willSend.length} now</button>`,
        onSubmit: (fields) => {
          if (fields.ack !== 'on') throw new Error('Tick the box to confirm.');
          return true;
        },
      });
      if (confirmed !== true) return;

      try {
        await api.post('/api/gmail/send', {
          confirm: true,
          queue_ids: willSend.map((q) => q.id),
          expected_count: willSend.length,
        });
        toast('Sending started');
        await draw();
      } catch (err) {
        toast(err.message, { error: true, ms: 8000 });
        await draw();
      }
    });

    if (run?.running) {
      clearInterval(poller);
      poller = setInterval(async () => {
        const next = await api.get('/api/gmail/send/status');
        if (!next.active_send?.running) { clearInterval(poller); poller = null; await draw(); }
        else {
          const note = root.querySelector('.note-info div');
          const r = next.active_send;
          if (note) note.innerHTML =
            `<span class="spinner"></span> &nbsp;<strong>Sending ${r.done} of ${r.total}</strong> — ` +
            `${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped.`;
        }
      }, 2000);
    }
  }
}

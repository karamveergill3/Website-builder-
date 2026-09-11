/* Outbox: read every queued email, confirm once, then it sends. */
import { api } from '../api.js';
import {
  html, mount, on, modal, confirmDialog, toast, fmtDateTime, registerInterval,
} from '../dom.js';

export default async function outboxView(root, _params, { refresh }) {
  const status = await api.get('/api/gmail/status').catch(() => null);

  if (!status?.client_configured) {
    mount(root, html`
      <div class="bar"><h2>Outbox</h2></div>
      <div class="panel"><div class="panel-bd">
        <div class="msg msg-warn"><div class="grow">
          Set <code class="mono">GMAIL_CLIENT_ID</code> and <code class="mono">GMAIL_CLIENT_SECRET</code>
          in <code class="mono">.env</code> and restart — see <code class="mono">docs/PHASE3-GMAIL.md</code>.
          Compose still gives you copy-and-paste and mail-app drafts.
        </div></div>
      </div></div>`);
    return;
  }

  if (!status.connected) {
    mount(root, html`
      <div class="bar"><h2>Outbox</h2></div>
      <div class="panel">
        <div class="panel-bd">
          <div class="msg msg-bad"><div class="grow">
            <b>Don't connect your main account.</b>
            Gmail's policies prohibit unsolicited commercial mail at any volume, and the stated
            sanction includes disabling the Google Account — on a personal address that means
            losing the mailbox itself. Use a separate account.
            <a href="#/deliverability">How to keep mail out of junk</a>
          </div></div>
          <div class="bar" style="margin:14px 0 0">
            <button class="primary" data-act="connect">Connect Gmail</button>
            <span class="meta">Asks only for permission to send — it cannot read your inbox.</span>
          </div>
        </div>
      </div>`);
    on(root, 'click', '[data-act="connect"]', async () => {
      const { url } = await api.get('/api/gmail/connect');
      window.location.href = url;
    });
    return;
  }

  let data = null;
  let pending = [];
  let remaining = 0;

  on(root, 'click', '[data-act="open"]', (_e, el) => {
    const q = pending.find((x) => String(x.id) === el.dataset.id);
    if (!q) return;
    modal({
      title: q.business_name ?? q.to_email,
      wide: true,
      body: html`<div class="mail">
        <div class="mail-hd"><dl>
          <dt>To</dt><dd class="mono">${q.to_email}</dd>
          <dt>Subject</dt><dd class="subj">${q.subject}</dd>
        </dl></div>
        <div class="mail-bd" style="max-height:none">${q.body}</div>
      </div>`,
      footer: html`<button type="button" data-close>Close</button>`,
    });
  });

  on(root, 'click', '[data-act="drop"]', async (_e, el) => {
    await api.del(`/api/gmail/queue/${el.dataset.id}`);
    await draw();
  });

  on(root, 'click', '[data-act="clear"]', async () => {
    if (!await confirmDialog({
      title: 'Discard queue',
      message: `Remove all ${pending.length}? Nothing has been sent.`,
      confirmLabel: 'Discard', danger: true,
    })) return;
    await api.post('/api/gmail/queue/clear');
    await draw();
  });

  on(root, 'click', '[data-act="stop"]', async () => {
    await api.post('/api/gmail/send/cancel');
    toast('Stopping after the current email');
  });

  on(root, 'click', '[data-act="disconnect"]', async () => {
    if (!await confirmDialog({
      title: 'Disconnect Gmail',
      message: 'Sending stops. Your sent log is kept.',
      confirmLabel: 'Disconnect', danger: true,
    })) return;
    await api.post('/api/gmail/disconnect');
    refresh();
  });

  on(root, 'click', '[data-act="send"]', async () => {
    const batch = pending.slice(0, remaining);
    if (!batch.length) return;
    const ok = await modal({
      title: `Send ${batch.length}?`,
      wide: true,
      body: html`
        <div class="msg msg-warn" style="margin-bottom:12px"><div class="grow">
          Real email from <b>${data.email}</b>, ${data.delay_min_seconds}–${data.delay_max_seconds}s apart.
          It cannot be undone.
        </div></div>
        <div class="scroll-x" style="max-height:260px;overflow-y:auto">
          <table class="rows">
            <thead><tr><th>Business</th><th>To</th><th>Subject</th></tr></thead>
            <tbody>${batch.map((q) => html`
              <tr><td class="c-name"><span class="name" style="font-size:.88rem">${q.business_name ?? '—'}</span></td>
                  <td class="meta mono">${q.to_email}</td>
                  <td class="meta">${q.subject}</td></tr>`)}
            </tbody>
          </table>
        </div>
        ${pending.length > remaining ? html`
          <p class="tip">${pending.length - remaining} stay queued — today's cap allows ${remaining} more.</p>` : ''}
        <div class="check" style="margin-top:14px">
          <input type="checkbox" id="ack" name="ack" required>
          <label for="ack">I've read these and want them sent.</label>
        </div>`,
      footer: html`
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Send ${batch.length}</button>`,
      onSubmit: (f) => {
        if (f.ack !== 'on') throw new Error('Tick the box to confirm.');
        return true;
      },
    });
    if (ok !== true) return;

    try {
      await api.post('/api/gmail/send', {
        confirm: true, queue_ids: batch.map((q) => q.id), expected_count: batch.length,
      });
      toast('Sending');
    } catch (err) {
      toast(err.message, { error: true, ms: 8000 });
    }
    await draw();
  });

  await draw();

  async function draw() {
    data = await api.get('/api/gmail/queue');
    pending = data.pending;
    remaining = data.daily.remaining;
    const done = data.queue.filter((q) => q.status !== 'pending');
    const run = data.active_send;
    const { cap, used } = data.daily;

    mount(root, html`
      <div class="bar">
        <h2>Outbox</h2>
        <span class="meta"><span class="mono">${data.email ?? ''}</span> ·
          ${used}/${cap} today · ${data.delay_min_seconds}–${data.delay_max_seconds}s apart</span>
        <div class="grow"></div>
        ${pending.length ? html`
          <button class="mini" data-act="clear">Discard all</button>
          <button class="primary" data-act="send" ${run?.running || remaining === 0 ? 'disabled' : ''}>
            Review and send ${Math.min(pending.length, remaining)}</button>` : ''}
        <button class="mini ghost" data-act="disconnect">Disconnect</button>
      </div>

      ${run?.running ? html`
        <div class="msg msg-info" style="margin-bottom:10px">
          <div class="grow" id="prog"><span class="spin"></span>
            Sending ${run.done}/${run.total} — ${run.sent} sent, ${run.failed} failed, ${run.skipped} skipped</div>
          <button class="mini danger" data-act="stop">Stop</button>
        </div>`
      : run?.finished_at ? html`
        <div class="msg ${run.failed ? 'msg-warn' : 'msg-info'}" style="margin-bottom:10px"><div class="grow">
          Finished — ${run.sent} sent, ${run.failed} failed, ${run.skipped} skipped.
          ${run.stopped_reason ?? ''}</div></div>` : ''}

      ${remaining === 0 && pending.length ? html`
        <div class="msg msg-warn" style="margin-bottom:10px"><div class="grow">
          Daily cap reached (${used}/${cap}). <a href="#/settings">Raise it</a> if you mean to.
        </div></div>` : ''}

      ${pending.length === 0 ? html`
        <div class="panel"><div class="blank">
          <strong>Nothing queued</strong>
          Queue from <a href="#/compose">Compose</a> or the <a href="#/leads">lead list</a>.
        </div></div>` : html`
        <div class="panel">
          <div class="panel-hd"><h3 class="grow">Awaiting confirmation — ${pending.length}</h3></div>
          <div class="scroll-x"><table class="rows">
            <thead><tr><th>Business</th><th>To</th><th>Subject</th><th></th></tr></thead>
            <tbody>${pending.map((q) => html`
              <tr>
                <td class="c-name"><span class="name">${q.business_name ?? '—'}</span></td>
                <td class="meta mono">${q.to_email}</td>
                <td class="meta">${q.subject}</td>
                <td class="c-act">
                  <button class="mini" data-act="open" data-id="${q.id}">Read</button>
                  <button class="mini danger" data-act="drop" data-id="${q.id}">✕</button>
                </td>
              </tr>`)}
            </tbody>
          </table></div>
        </div>`}

      ${done.length ? html`
        <div class="panel">
          <div class="panel-hd"><h3 class="grow">Recent attempts</h3>
            <a class="meta" href="#/log">Sent log</a></div>
          <div class="scroll-x"><table class="rows">
            <thead><tr><th>Business</th><th>To</th><th>Result</th><th class="nw">When</th></tr></thead>
            <tbody>${done.slice(0, 40).map((q) => html`
              <tr>
                <td class="c-name"><span class="name" style="font-size:.9rem">${q.business_name ?? '—'}</span></td>
                <td class="meta mono">${q.to_email}</td>
                <td><span class="status" data-s="${q.status === 'sent' ? 'won' : q.status === 'failed' ? 'lost' : 'new'}">${q.status}</span>
                    ${q.error ? html`<span class="meta" style="display:block">${q.error}</span>` : ''}</td>
                <td class="meta nw">${q.sent_at ? fmtDateTime(q.sent_at) : '—'}</td>
              </tr>`)}
            </tbody>
          </table></div>
        </div>` : ''}
    `);

    if (run?.running) {
      const poller = registerInterval(setInterval(async () => {
        const next = await api.get('/api/gmail/send/status');
        if (!next.active_send?.running) { clearInterval(poller); await draw(); return; }
        const el = root.querySelector('#prog');
        const r = next.active_send;
        if (el) el.innerHTML = `<span class="spin"></span> Sending ${r.done}/${r.total} — ` +
          `${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped`;
      }, 2000));
    }
  }
}

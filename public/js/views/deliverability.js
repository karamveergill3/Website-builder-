/* Deliverability: what the tool enforces to keep mail out of junk, and the
   handful of things it cannot do for you. */
import { api } from '../api.js';
import { html, mount, $ } from '../dom.js';

export default async function deliverabilityView(root) {
  const [gmail, settings] = await Promise.all([
    api.get('/api/gmail/status').catch(() => null),
    api.settings.get(),
  ]);
  const p = gmail?.policy;
  const s = settings.settings;
  const warm = p?.daily?.warmup;

  mount(root, html`
    <div class="bar"><h2>Deliverability</h2>
      <div class="grow"></div>
      ${gmail?.connected ? html`<span class="meta mono">${gmail.email}</span>` : ''}
    </div>

    ${p ? html`
      <div class="readout">
        <div data-accent="${p.daily.remaining ? '' : 'warn'}">
          <b class="num">${p.daily.remaining}</b><span>Left today</span></div>
        <div><b class="num">${p.daily.used}/${p.daily.cap}</b><span>Sent today</span></div>
        <div data-accent="${p.window.open ? '' : 'warn'}">
          <b class="num">${p.window.open ? 'Open' : 'Shut'}</b><span>Sending window</span></div>
        <div><b class="num">${warm?.cap === null || !warm ? 'Full' : `Day ${warm.day}`}</b>
          <span>${warm?.cap === null || !warm ? 'Warm-up done' : 'Warm-up'}</span></div>
      </div>` : ''}

    <div class="panel">
      <div class="panel-hd"><h3>What is enforced before anything sends</h3></div>
      <div class="scroll-x"><table class="rows">
        <tbody>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">Address checked</span>
              <span class="meta">Syntax, typos, throwaway providers, and a real MX lookup</span></td>
              <td class="c-act">${s.verify_addresses === '1'
                ? html`<span class="flag" data-ok>on</span>` : html`<span class="flag">off</span>`}</td></tr>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">Draft scored</span>
              <span class="meta">Links, shorteners, images, length, subject shape, unfilled placeholders</span></td>
              <td class="c-act">${s.spam_check_enabled === '1'
                ? html`<span class="flag" data-ok>on</span>` : html`<span class="flag">off</span>`}</td></tr>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">Warm-up ramp</span>
              <span class="meta">5 a day, rising to your cap over four weeks</span></td>
              <td class="c-act">${s.warmup_enabled === '1'
                ? html`<span class="flag" data-ok>on</span>` : html`<span class="flag">off</span>`}</td></tr>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">Sending window</span>
              <span class="meta">${s.window_start_hour}:00–${s.window_end_hour}:00${
                s.window_weekdays_only === '1' ? ', weekdays only' : ''}</span></td>
              <td class="c-act">${s.window_enabled === '1'
                ? html`<span class="flag" data-ok>on</span>` : html`<span class="flag">off</span>`}</td></tr>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">One company at a time</span>
              <span class="meta">No second address at the same domain for ${s.domain_cooldown_days} days</span></td>
              <td class="c-act">${Number(s.domain_cooldown_days) > 0
                ? html`<span class="flag" data-ok>on</span>` : html`<span class="flag">off</span>`}</td></tr>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">Randomised gaps</span>
              <span class="meta">${s.send_delay_min_seconds}–${s.send_delay_max_seconds}s apart, never a fixed cadence</span></td>
              <td class="c-act"><span class="flag" data-ok>on</span></td></tr>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">List-Unsubscribe header</span>
              <span class="meta">Off below bulk volumes — it makes Gmail draw an “Unsubscribe” chip</span></td>
              <td class="c-act">${s.list_unsubscribe_enabled === '1'
                ? html`<span class="flag">on</span>` : html`<span class="flag" data-ok>off</span>`}</td></tr>
        </tbody>
      </table></div>
      <div class="panel-bd" style="border-top:1px solid var(--rule-2)">
        <a class="btn mini" href="#/settings">Change these</a>
      </div>
    </div>

    <div class="panel">
      <div class="panel-hd"><h3>Try a draft</h3></div>
      <div class="panel-bd">
        <div class="f">
          <label for="d-subject">Subject</label>
          <input id="d-subject" type="text" placeholder="Website for Hillside Roofing?">
        </div>
        <div class="f">
          <label for="d-body">Body</label>
          <textarea id="d-body" class="code" rows="9" placeholder="Paste a draft to score it."></textarea>
        </div>
        <div id="score"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-hd"><h3>What this cannot fix</h3></div>
      <div class="panel-bd">
        <p class="tip" style="margin:0 0 8px">
          Nothing guarantees the inbox, and anyone who says otherwise is selling something.
          Three limits are worth knowing:
        </p>
        <ul style="margin:0;padding-left:18px;font-size:.82rem;line-height:1.8">
          <li><b>gmail.com has no reputation you can build.</b> You inherit the average of every
            Gmail account there is, and you can never see your own numbers — Postmaster Tools
            needs DNS proof of a domain you own. A dedicated sending domain is the real fix, and
            it is worse than Gmail for its first month or two while it has no history.</li>
          <li><b>One complaint is a large fraction of your signal.</b> At 25 a day, a single
            spam mark is a 4% rate against a 0.1% target. Relevance is the whole defence;
            volume cannot substitute for it.</li>
          <li><b>Replies are the strongest positive signal</b>, and the send-only Gmail
            permission cannot read them. Check the mailbox yourself and mark anyone who asks
            to stop as <a href="#/compliance">opted out</a>.</li>
        </ul>
        <p class="tip" style="margin:10px 0 0">
          The reasoning and sources are in <code class="mono">docs/DELIVERABILITY.md</code>.
        </p>
      </div>
    </div>
  `);

  let t;
  const score = async () => {
    const subject = $('#d-subject', root).value;
    const body = $('#d-body', root).value;
    const box = $('#score', root);
    if (!subject && !body) { box.innerHTML = ''; return; }
    const r = await api.post('/api/emails/score', { subject, body });
    mount(box, html`
      <div class="msg ${r.level === 'block' ? 'msg-bad' : r.level === 'warn' ? 'msg-warn' : 'msg-info'}">
        <div class="grow">
          <b>${r.level === 'block' ? 'Would be blocked'
            : r.level === 'warn' ? 'Worth a look' : 'Looks fine'}</b>
          — ${r.stats.body_words} words, ${r.stats.links} link${r.stats.links === 1 ? '' : 's'}
          ${r.checks.length ? html`<ul>${r.checks.map((c) => html`
            <li><b>${c.title}</b> — ${c.detail}</li>`)}</ul>` : ''}
        </div>
      </div>`);
  };
  for (const id of ['#d-subject', '#d-body']) {
    $(id, root).addEventListener('input', () => { clearTimeout(t); t = setTimeout(score, 350); });
  }
}

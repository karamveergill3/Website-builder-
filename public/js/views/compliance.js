/* Rules: who may be written to, and what every email must carry. */
import { api } from '../api.js';
import { html, mount, on, modal, toast, fmtDate, confirmDialog } from '../dom.js';

export default async function complianceView(root, _p, { refresh }) {
  const [stats, sup] = await Promise.all([
    api.leads.stats(),
    api.get('/api/suppression').catch(() => ({ entries: [], total: 0 })),
  ]);

  mount(root, html`
    <div class="bar"><h2>Rules</h2>
      <div class="grow"></div>
      <a class="meta" href="https://find-and-update.company-information.service.gov.uk/"
         target="_blank" rel="noopener">Companies House ↗</a>
    </div>

    <div class="readout">
      <div data-accent><b class="num">${stats.emailable}</b><span>Can email</span></div>
      <div data-accent="${stats.unclassified ? 'warn' : ''}"><b class="num">${stats.unclassified}</b><span>Need checking</span></div>
      <div><b class="num">${stats.individual}</b><span>Sole traders</span></div>
      <div><b class="num">${stats.suppressed}</b><span>Suppressed</span></div>
    </div>

    <div class="panel">
      <div class="panel-hd"><h3>Who may be cold-emailed</h3></div>
      <div class="scroll-x"><table class="rows">
        <tbody>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">Limited companies, PLCs, LLPs, CICs</span>
              <span class="meta">Scottish partnerships, chartered and public bodies</span></td>
              <td class="c-act"><span class="flag" data-ok>permitted</span></td></tr>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">Sole traders</span>
              <span class="meta">and ordinary partnerships in England, Wales, NI</span></td>
              <td class="c-act"><span class="flag">not permitted</span></td></tr>
          <tr><td class="c-name"><span class="name" style="font-size:.9rem">Personal mailboxes</span>
              <span class="meta">gmail.com, hotmail.co.uk, btinternet.com …</span></td>
              <td class="c-act"><span class="flag">not permitted</span></td></tr>
        </tbody>
      </table></div>
      <div class="panel-bd" style="border-top:1px solid var(--rule-2)">
        <p class="tip" style="margin:0">
          PECR reg. 22 turns on the recipient's legal form, not on whether the address looks
          like a business one. Most small trades are sole traders, so a large share of any
          search will be unsendable. A name ending in “Ltd” is not evidence — Google shows
          trading names — which is why marking a lead as a company needs its
          <b>company number</b>.
        </p>
      </div>
    </div>

    <div class="panel">
      <div class="panel-hd"><h3>What every email carries</h3></div>
      <div class="panel-bd">
        <p class="tip" style="margin:0 0 8px">
          Reg. 23 applies to every marketing email, to both kinds of subscriber. Sending is
          blocked until these are set under <a href="#/settings">Settings</a>.
        </p>
        <ul style="margin:0;padding-left:18px;font-size:.82rem;line-height:1.75">
          <li>a line saying the message is marketing</li>
          <li>your name, trading name and a real postal address</li>
          <li>company number and registered office, if you trade as a company</li>
          <li>where you got their details — UK GDPR Art. 14, because it came from a third party</li>
          <li>a one-line opt-out</li>
        </ul>
      </div>
    </div>

    <div class="panel">
      <div class="panel-hd">
        <h3 class="grow">Suppression list — ${sup.total}</h3>
        <button class="mini" data-act="add">Add address</button>
      </div>
      ${sup.entries.length === 0 ? html`
        <div class="blank">Nobody has opted out yet.</div>` : html`
        <div class="scroll-x"><table class="rows">
          <thead><tr><th>Address</th><th>Business</th><th>Reason</th><th class="nw">Added</th><th></th></tr></thead>
          <tbody>${sup.entries.map((e) => html`
            <tr>
              <td class="mono">${e.email}</td>
              <td class="meta">${e.business_name ?? '—'}</td>
              <td class="meta">${e.reason}</td>
              <td class="meta nw">${fmtDate(e.added_at)}</td>
              <td class="c-act"><button class="mini danger" data-act="lift" data-email="${e.email}">Lift</button></td>
            </tr>`)}
          </tbody>
        </table></div>`}
      <div class="panel-bd" style="border-top:1px solid var(--rule-2)">
        <p class="tip" style="margin:0">
          No grace period in UK law — stop immediately. Marking a lead opted out records the
          address here, so it stays blocked even if the lead is deleted and re-imported. The ICO
          says suppress rather than delete, for exactly that reason.
        </p>
      </div>
    </div>

    <div class="panel">
      <div class="panel-hd"><h3>What is stored</h3></div>
      <div class="panel-bd">
        <p class="tip" style="margin:0">
          Google's terms permit keeping a place ID but name “copy and save business names,
          addresses” as prohibited scraping. So only the place ID and a has-a-website flag are
          stored; names and phone numbers are held in memory for one review session. Anything
          you keep long-term should come from Companies House or the business itself. Your
          <a href="#/log">sent log</a> is your own record and is unaffected.
        </p>
        <p class="tip" style="margin:8px 0 0">
          Full detail and sources in <code class="mono">docs/COMPLIANCE.md</code>, including a
          section on what could not be verified. Not legal advice.
        </p>
      </div>
    </div>
  `);

  on(root, 'click', '[data-act="lift"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'Lift suppression',
      message: `Allow ${el.dataset.email} to be emailed again? Only if they asked you to.`,
      confirmLabel: 'Lift', danger: true,
    })) return;
    await api.del(`/api/suppression/${encodeURIComponent(el.dataset.email)}`);
    toast('Lifted');
    refresh();
  });

  on(root, 'click', '[data-act="add"]', async () => {
    const added = await modal({
      title: 'Add to suppression list',
      body: html`
        <div class="f">
          <label for="sup-email">Email</label>
          <input id="sup-email" name="email" type="email" required autocomplete="off">
          <p class="tip">For when someone asks you to stop by phone or in person.</p>
        </div>
        <div class="cols">
          <div class="f">
            <label for="sup-biz">Business <span class="opt">optional</span></label>
            <input id="sup-biz" name="business_name" type="text" autocomplete="off">
          </div>
          <div class="f">
            <label for="sup-why">Reason</label>
            <input id="sup-why" name="reason" type="text" value="asked to stop" autocomplete="off">
          </div>
        </div>`,
      footer: html`
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Add</button>`,
      onSubmit: async (d) => { await api.post('/api/suppression', d); return true; },
    });
    if (added) { toast('Added'); refresh(); }
  });
}

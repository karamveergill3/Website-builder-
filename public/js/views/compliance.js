/* What the tool enforces, and why. Plain English, with the sources.
   Kept in the app rather than only in docs/ because these are the rules that
   decide who you may write to, and they are worth re-reading. */
import { api } from '../api.js';
import { html, mount, on, toast, fmtDate, confirmDialog } from '../dom.js';

export default async function complianceView(root, _p, { refresh }) {
  const [stats, suppression] = await Promise.all([
    api.leads.stats(),
    api.get('/api/suppression').catch(() => ({ entries: [], total: 0 })),
  ]);

  mount(root, html`
    <div class="view-head">
      <div>
        <h2>Who you may write to</h2>
        <p class="lede">
          The rules this tool enforces, and where they come from. Worth reading once properly —
          the classification rule is the one that catches people out.
        </p>
      </div>
    </div>

    <div class="stats">
      <div class="stat" data-tone="won"><span class="n num">${stats.emailable}</span>
        <span class="k">Can email</span></div>
      <div class="stat" data-tone="sent"><span class="n num">${stats.unclassified}</span>
        <span class="k">Need checking</span></div>
      <div class="stat" data-tone="muted"><span class="n num">${stats.individual}</span>
        <span class="k">Sole traders</span></div>
      <div class="stat" data-tone="muted"><span class="n num">${stats.suppressed}</span>
        <span class="k">Suppressed</span></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>1. Only some businesses may be cold-emailed</h3></div>
      <div class="card-body">
        <p style="margin-top:0">
          PECR regulation 22 turns on the recipient's <strong>legal form</strong>, not on whether
          the address looks like a business one.
        </p>
        <table class="ledger">
          <thead><tr><th>Kind of business</th><th>Cold email without consent?</th></tr></thead>
          <tbody>
            <tr><td><strong>Limited companies, PLCs, LLPs, CICs</strong><br>
                    <span class="sub">Scottish partnerships, chartered and public bodies too</span></td>
                <td><span class="status" data-s="won">permitted</span></td></tr>
            <tr><td><strong>Sole traders</strong><br>
                    <span class="sub">and ordinary (non-LLP) partnerships in England, Wales and NI</span></td>
                <td><span class="status" data-s="lost">not permitted</span></td></tr>
            <tr><td><strong>Any personal mailbox</strong><br>
                    <span class="sub">gmail.com, hotmail.co.uk, btinternet.com and the like</span></td>
                <td><span class="status" data-s="lost">not permitted</span></td></tr>
          </tbody>
        </table>
        <div class="note note-warn" style="margin-top:16px"><div>
          <strong>A great many small trades are sole traders.</strong> Expect a large share of any
          Google Places sweep to be unsendable. That is the filter working, not failing.
        </div></div>
        <p class="hint" style="margin-top:14px">
          Because of this, a lead cannot be marked as a limited company without a
          <strong>company number</strong> on the record. A trading name ending in “Ltd” is not
          evidence — Google shows trading names, which often differ from registered names.
          Check the
          <a href="https://find-and-update.company-information.service.gov.uk/" target="_blank"
             rel="noopener">Companies House register</a>.
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>2. Every email must identify you and offer an opt-out</h3></div>
      <div class="card-body">
        <p style="margin-top:0">
          Regulation 23 applies to <em>every</em> marketing email, to both kinds of subscriber.
          You must not conceal who you are, and you must give a valid address for someone to ask
          you to stop. The footer this tool appends covers:
        </p>
        <ul>
          <li>a line saying the message is marketing, so it is not disguised as anything else</li>
          <li>your name, trading name and a real postal address</li>
          <li>your company number and registered office, if you trade as a limited company</li>
          <li>where you got their details, which UK GDPR Article 14 requires when the data came
              from a third party such as a map listing</li>
          <li>a one-line opt-out</li>
        </ul>
        <p class="hint">
          Sending is blocked outright until the required details are filled in under
          <a href="#/settings">Settings</a>. A VAT number is not legally required in a marketing
          email — include it if you like.
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 style="flex:1">3. Opt-outs are permanent — ${suppression.total} address(es) suppressed</h3>
        <button class="tiny" data-act="add-suppression">Add an address</button>
      </div>
      <div class="card-body">
        <p style="margin-top:0">
          There is no grace period in UK law: stop immediately. Marking a lead
          <strong>opted out</strong> also records the address here, so it stays blocked even if
          you later delete the lead and re-import the same business. The ICO's guidance is to
          suppress rather than delete, for exactly that reason.
        </p>
        ${suppression.entries.length === 0 ? html`
          <p class="hint">Nobody has opted out yet.</p>` : html`
          <div class="table-scroll"><table class="ledger">
            <thead><tr><th>Address</th><th>Business</th><th>Reason</th><th>Added</th><th></th></tr></thead>
            <tbody>
              ${suppression.entries.map((e) => html`
                <tr>
                  <td class="mono">${e.email}</td>
                  <td class="sub">${e.business_name ?? '—'}</td>
                  <td class="sub">${e.reason}</td>
                  <td class="sub nowrap">${fmtDate(e.added_at)}</td>
                  <td><div class="rowactions">
                    <button class="tiny danger" data-act="unsuppress" data-email="${e.email}">Lift</button>
                  </div></td>
                </tr>`)}
            </tbody>
          </table></div>
          <p class="hint" style="margin-top:10px">
            Only lift a suppression if the person has asked you to.
          </p>`}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>4. What is stored, and what is not</h3></div>
      <div class="card-body">
        <p style="margin-top:0">
          Google's Maps Platform terms permit keeping a <strong>place ID</strong>, but name
          “copy and save business names, addresses” as a prohibited example of scraping. So this
          tool stores the place ID and whether the place had a website, and holds names,
          addresses and phone numbers in memory for the length of a review session only.
        </p>
        <p>
          Details you import onto a lead are marked as Places-derived. Anything you intend to
          keep long-term should come from a source you may store — Companies House, or the
          business itself. Since you have to check Companies House anyway to classify a lead,
          that is usually the same piece of work.
        </p>
        <div class="note note-info"><div>
          Your <a href="#/log">sent log</a> is your own record of your own correspondence and is
          not affected by any of this.
        </div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <p class="hint" style="margin:0">
          Sources and the full detail are in <code class="mono">docs/COMPLIANCE.md</code>.
          Those notes were compiled from ICO and legislation.gov.uk guidance but could not be
          verified against the live pages when this was built — the section headed
          “What is not verified” says exactly what that covers. None of this is legal advice,
          and it is worth an hour of a solicitor's time before sending at any volume.
        </p>
      </div>
    </div>
  `);

  on(root, 'click', '[data-act="unsuppress"]', async (_e, el) => {
    const ok = await confirmDialog({
      title: 'Lift this suppression',
      message: `Allow ${el.dataset.email} to be emailed again? Only do this if they have asked you to.`,
      confirmLabel: 'Lift', danger: true,
    });
    if (!ok) return;
    await api.del(`/api/suppression/${encodeURIComponent(el.dataset.email)}`);
    toast('Suppression lifted');
    refresh();
  });

  on(root, 'click', '[data-act="add-suppression"]', async () => {
    const { modal } = await import('../dom.js');
    const added = await modal({
      title: 'Add to the suppression list',
      body: html`
        <div class="field">
          <label for="sup-email">Email address</label>
          <input id="sup-email" name="email" type="email" required autocomplete="off">
          <p class="hint">Use this when someone asks you to stop by phone or in person.</p>
        </div>
        <div class="field">
          <label for="sup-business">Business <span class="opt">(optional)</span></label>
          <input id="sup-business" name="business_name" type="text" autocomplete="off">
        </div>
        <div class="field">
          <label for="sup-reason">Reason</label>
          <input id="sup-reason" name="reason" type="text" value="asked to stop" autocomplete="off">
        </div>`,
      footer: html`
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary">Add</button>`,
      onSubmit: async (data) => { await api.post('/api/suppression', data); return true; },
    });
    if (added) { toast('Added to the suppression list'); refresh(); }
  });
}

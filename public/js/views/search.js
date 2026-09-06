/* Find leads — sweep Google Places for UK businesses with no website.
   Nothing is ever imported automatically: results land in a review list with
   checkboxes and an explicit "Add to tracker". */
import { api } from '../api.js';
import { html, mount, on, $, $$, toast, fmtDateTime } from '../dom.js';

let poller = null;

export default async function searchView(root, params, { navigate }) {
  clearInterval(poller);

  const status = await api.get('/api/places/status').catch(() => null);

  if (!status) {
    mount(root, html`
      <div class="view-head"><div><h2>Find leads</h2></div></div>
      <div class="card"><div class="empty">
        <h3>Search is unavailable</h3>
        <p>The Places routes failed to load. Check the server log.</p>
      </div></div>`);
    return;
  }

  if (!status.configured) {
    mount(root, html`
      <div class="view-head"><div>
        <h2>Find leads</h2>
        <p class="lede">Search Google Places for UK businesses that have no website.</p>
      </div></div>
      <div class="card"><div class="card-body">
        <div class="note note-warn"><div>
          <strong>Not set up yet.</strong>
          Add a Google Maps API key as <code class="mono">GOOGLE_MAPS_API_KEY</code> in your
          <code class="mono">.env</code>, then restart the server.
        </div></div>
        <p style="margin-top:16px">
          You need a Google Cloud project with <strong>Places API (New)</strong> enabled,
          billing switched on, and an API key restricted to that one API.
          The walkthrough is in <code class="mono">docs/PHASE2-PLACES.md</code>.
        </p>
        <p class="hint">The tracker works fine without this — you can add leads by hand.</p>
      </div></div>`);
    return;
  }

  const runId = params.run ? Number(params.run) : null;
  if (runId) return renderRun(root, runId, navigate);

  const { runs } = await api.get('/api/places/runs');

  mount(root, html`
    <div class="view-head">
      <div>
        <h2>Find leads</h2>
        <p class="lede">
          Search a category across as many towns as you like. A business only becomes a
          candidate if Google holds no website for it — and you still tick each one before
          anything joins the tracker.
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <form id="sweep">
          <div class="grid2">
            <div class="field">
              <label for="category">Category</label>
              <input id="category" name="category" type="text" required
                     placeholder="roofers" autocomplete="off">
              <p class="hint">What you would type into Google Maps, e.g. “roofers”, “mobile hairdresser”.</p>
            </div>
            <div class="field">
              <label for="pages">Depth per area</label>
              <select id="pages" name="pages_per_area">
                <option value="1">1 page — up to 20 businesses</option>
                <option value="2">2 pages — up to 40</option>
                <option value="3">3 pages — up to 60 (Google's maximum)</option>
              </select>
              <p class="hint">Each page is one billed request, whatever it returns.</p>
            </div>
          </div>
          <div class="field">
            <label for="areas">Towns and cities <span class="opt">(optional)</span></label>
            <textarea id="areas" name="areas" rows="6"
                      placeholder="Leeds&#10;Bradford&#10;Harrogate&#10;Skipton">${status.default_areas ?? ''}</textarea>
            <p class="hint">
              One per line, or comma-separated — paste in as many as you like (max ${status.limits.max_areas}).
              There is no fixed location bias: the sweep goes wherever you point it.
              Leave this empty to search the category on its own and let Google pick the
              geography — useful for a quick look, but a list of towns gives far better coverage.
            </p>
          </div>

          <div class="note note-info" id="estimate"><div>Enter some areas to see the cost estimate.</div></div>

          <div style="display:flex;gap:10px;align-items:center;margin-top:16px">
            <button type="submit" class="primary">Search</button>
            <span class="hint">Nothing is added to your tracker by this — you review everything first.</span>
          </div>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3 style="flex:1">Previous searches</h3>
        <span class="sub">${status.cached_places} places seen · ${status.cached_without_website} with no website</span>
      </div>
      ${runs.length === 0 ? html`
        <div class="empty"><p>No searches yet.</p></div>` : html`
        <div class="table-scroll"><table class="ledger">
          <thead><tr>
            <th>Search</th><th>Areas</th><th class="num">Found</th><th class="num">No website</th>
            <th>When</th><th></th>
          </tr></thead>
          <tbody>
            ${runs.map((r) => html`
              <tr>
                <td><span class="biz">${r.category}</span>
                    ${r.error ? html`<span class="sub" style="color:var(--clay)">${r.error}</span>` : ''}</td>
                <td class="sub">${r.areas.split('\n').slice(0, 3).join(', ')}${r.areas.split('\n').length > 3
                    ? ` +${r.areas.split('\n').length - 3} more` : ''}</td>
                <td class="sub num">${r.places_returned}</td>
                <td class="sub num">${r.candidates_found}</td>
                <td class="sub nowrap">${fmtDateTime(r.started_at)}${r.finished_at ? '' : ' · running'}</td>
                <td><div class="rowactions">
                  <button class="tiny" data-act="open" data-id="${r.id}">Review</button>
                </div></td>
              </tr>`)}
          </tbody>
        </table></div>`}
    </div>
  `);

  const refreshEstimate = async () => {
    const areas = $('#areas', root).value;
    const pages = $('#pages', root).value;
    const e = await api.get('/api/places/estimate', { areas, pages_per_area: pages });
    const box = $('#estimate', root);
    box.className = `note ${e.verified_on ? 'note-info' : 'note-warn'}`;
    mount(box, html`
      <div>
        <strong>${e.requests} billed request${e.requests === 1 ? '' : 's'}</strong>
        — roughly <strong>$${e.approx_usd.toFixed(2)}</strong> at $${e.per_1000_usd}/1,000,
        against a free allowance of about
        ${e.free_calls_per_month.toLocaleString('en-GB')} calls per SKU per month.
        ${e.verified_on
          ? html`<span class="hint" style="display:block;margin-top:4px">
              Rates confirmed by you on ${e.verified_on}. Re-check occasionally at
              <a href="${e.pricing_source}" target="_blank" rel="noopener">Google's billing page</a>.
            </span>`
          : html`<span style="display:block;margin-top:6px">
              <strong>These rates are unverified.</strong> They are a starting figure, not a quote —
              check the current numbers on
              <a href="${e.pricing_source}" target="_blank" rel="noopener">Google's billing page</a>
              and enter them under <a href="#/settings">Settings</a> before you rely on this.
            </span>`}
      </div>`);
  };

  let t;
  $('#areas', root).addEventListener('input', () => { clearTimeout(t); t = setTimeout(refreshEstimate, 300); });
  $('#pages', root).addEventListener('change', refreshEstimate);
  refreshEstimate();

  $('#sweep', root).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(ev.target));
      const res = await api.post('/api/places/search', data);
      navigate(`/search?run=${res.run.id}`);
    } catch (err) {
      toast(err.message, { error: true, ms: 7000 });
      btn.disabled = false;
    }
  });

  on(root, 'click', '[data-act="open"]', (_e, el) => navigate(`/search?run=${el.dataset.id}`));
}

/* ------------------------------------------------------- review one run */

async function renderRun(root, runId, navigate) {
  const draw = async () => {
    const data = await api.get(`/api/places/runs/${runId}`);
    const { run, candidates, summary, running } = data;
    const fresh = candidates.filter((c) => !c.is_lead);
    const expired = data.content_available === false;

    mount(root, html`
      <div class="view-head">
        <div>
          <h2>${run.category}</h2>
          <p class="lede">
            ${data.areas.length ? `${data.areas.length} area${data.areas.length === 1 ? '' : 's'}` : 'no location set'} ·
            ${run.places_returned} businesses looked at ·
            <strong>${summary.candidates} with no website</strong>
            ${summary.already_leads ? ` · ${summary.already_leads} already in your tracker` : ''}
          </p>
        </div>
        <div class="spacer"></div>
        <button data-act="back">← All searches</button>
      </div>

      ${running ? html`
        <div class="note note-info" style="margin-bottom:14px">
          <div><span class="spinner"></span> &nbsp;Searching — ${run.text_search_calls} request(s) so far.
          This page updates itself.</div>
        </div>` : ''}

      ${run.error ? html`
        <div class="note note-danger" style="margin-bottom:14px">
          <div><strong>The search stopped early.</strong><br>${run.error}</div>
        </div>` : ''}

      ${expired ? html`
        <div class="note note-warn" style="margin-bottom:14px">
          <div>
            <strong>These results have expired.</strong>
            Google's terms let this tool keep a place ID but not the business names, addresses or
            phone numbers behind it, so those are held in memory for
            ${data.content_ttl_minutes} minutes and then gone. This run still knows that
            ${summary.candidates} place(s) had no website — run the search again to see who they are.
          </div>
        </div>` : ''}

      ${expired ? html`
        <div class="card"><div class="empty">
          <h3>Nothing left to review here</h3>
          <p>Run the same search again to bring the details back.</p>
          <p style="margin-top:14px"><button class="primary" data-act="back">← New search</button></p>
        </div></div>`
        : fresh.length === 0 && !running ? html`
        <div class="card"><div class="empty">
          <h3>No new candidates</h3>
          <p>${summary.candidates > 0
              ? 'Every business without a website here is already in your tracker.'
              : 'Every business Google returned already has a website. Try another category or more towns.'}</p>
        </div></div>` : html`
        <div class="card">
          <div class="card-head">
            <strong style="flex:1">${fresh.length} to review</strong>
            <button class="tiny" data-act="all">Select all</button>
            <button class="tiny" data-act="none">Clear</button>
            <button class="primary" data-act="import" disabled>Add 0 to tracker</button>
          </div>
          <div class="table-scroll"><table class="ledger">
            <thead><tr>
              <th style="width:34px"></th><th>Business</th><th>Area</th>
              <th>Address</th><th>Phone</th><th>Status</th>
            </tr></thead>
            <tbody>
              ${candidates.map((c) => html`
                <tr>
                  <td>${c.is_lead
                    ? ''
                    : html`<input type="checkbox" class="pick" value="${c.place_id}"
                                  style="width:16px;height:16px;accent-color:var(--green)">`}</td>
                  <td><span class="biz">${c.display_name ?? '(unnamed)'}</span>
                      <span class="sub mono" style="font-size:.7rem">${c.place_id}</span></td>
                  <td class="sub">${c.area ?? '—'}</td>
                  <td class="sub">${c.address ?? '—'}</td>
                  <td class="sub mono">${c.phone ?? '—'}</td>
                  <td>${c.is_lead
                    ? html`<span class="status" data-s="won">in tracker</span>`
                    : html`<span class="status" data-s="new">new</span>`}</td>
                </tr>`)}
            </tbody>
          </table></div>
        </div>
        <p class="hint" style="margin-top:10px">
          Google returns no website for these. Phone numbers come straight from the listing;
          email addresses it does not hold, so you will need to find those or ring them.
          Details shown here are held in memory for ${data.content_ttl_minutes} minutes and are
          never written to your database — only the place ID is.
        </p>`}
    `);

    const picks = () => $$('.pick:checked', root).map((el) => el.value);
    const sync = () => {
      const btn = $('[data-act="import"]', root);
      if (!btn) return;
      const n = picks().length;
      btn.disabled = n === 0;
      btn.textContent = `Add ${n} to tracker`;
    };

    on(root, 'change', '.pick', sync);
    on(root, 'click', '[data-act="all"]', () => { $$('.pick', root).forEach((c) => { c.checked = true; }); sync(); });
    on(root, 'click', '[data-act="none"]', () => { $$('.pick', root).forEach((c) => { c.checked = false; }); sync(); });
    on(root, 'click', '[data-act="back"]', () => navigate('/search'));

    on(root, 'click', '[data-act="import"]', async (_e, btn) => {
      btn.disabled = true;
      try {
        const res = await api.post('/api/places/import', { run_id: runId, place_ids: picks() });
        toast(`Added ${res.imported} lead${res.imported === 1 ? '' : 's'}` +
              (res.skipped.length ? ` · ${res.skipped.length} skipped` : ''));
        await draw();
      } catch (err) {
        toast(err.message, { error: true });
        btn.disabled = false;
      }
    });

    if (running) {
      clearInterval(poller);
      poller = setInterval(async () => {
        const next = await api.get(`/api/places/runs/${runId}`);
        if (!next.running) { clearInterval(poller); poller = null; await draw(); }
        else {
          const note = root.querySelector('.note-info div');
          if (note) note.innerHTML =
            `<span class="spinner"></span> &nbsp;Searching — ${next.run.text_search_calls} request(s), ` +
            `${next.summary.candidates} candidate(s) so far.`;
        }
      }, 1500);
    }
  };

  await draw();
}

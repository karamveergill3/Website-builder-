/* Find: sweep Google Places for businesses with no website. */
import { api } from '../api.js';
import { html, mount, on, $, $$, toast, fmtDateTime, registerInterval } from '../dom.js';

export default async function searchView(root, params, { navigate }) {
  const status = await api.get('/api/places/status').catch(() => null);

  if (!status?.configured) {
    mount(root, html`
      <div class="bar"><h2>Find leads</h2></div>
      <div class="panel"><div class="panel-bd">
        <div class="msg msg-warn"><div class="grow">
          Set <code class="mono">GOOGLE_MAPS_API_KEY</code> in <code class="mono">.env</code> and restart.
          You need a Google Cloud project with <b>Places API (New)</b> enabled and billing on —
          walkthrough in <code class="mono">docs/PHASE2-PLACES.md</code>.
        </div></div>
      </div></div>`);
    return;
  }

  if (params.run) return reviewRun(root, Number(params.run), navigate);

  const { runs } = await api.get('/api/places/runs');

  mount(root, html`
    <div class="bar"><h2>Find leads</h2>
      <div class="grow"></div>
      <span class="meta">${status.cached_places} places seen · ${status.cached_without_website} with no website</span>
    </div>

    <div class="panel">
      <div class="panel-bd">
        <form id="sweep">
          <div class="cols">
            <div class="f">
              <label for="category">Trade</label>
              <input id="category" name="category" type="text" required placeholder="roofers" autocomplete="off">
            </div>
            <div class="f">
              <label for="pages">Depth</label>
              <select id="pages" name="pages_per_area">
                <option value="1">1 page — up to 20 each</option>
                <option value="2">2 pages — up to 40 each</option>
                <option value="3">3 pages — up to 60 each</option>
              </select>
            </div>
          </div>
          <div class="f">
            <label for="areas">Towns <span class="opt">one per line, optional</span></label>
            <textarea id="areas" name="areas" rows="5"
                      placeholder="Leeds&#10;Bradford&#10;Harrogate">${status.default_areas ?? ''}</textarea>
          </div>
          <div class="bar" style="margin:0">
            <button type="submit" class="primary">Search</button>
            <span class="meta" id="est"></span>
          </div>
        </form>
      </div>
    </div>

    ${runs.length ? html`
      <div class="panel">
        <div class="panel-hd"><h3>Previous</h3></div>
        <div class="scroll-x"><table class="rows">
          <thead><tr><th>Trade</th><th>Areas</th><th class="num">Seen</th><th class="num">No website</th>
            <th class="nw">When</th><th></th></tr></thead>
          <tbody>
            ${runs.map((r) => {
              const areas = r.areas ? r.areas.split('\n') : [];
              return html`
              <tr>
                <td class="c-name"><span class="name" style="font-size:.9rem">${r.category}</span>
                  ${r.error ? html`<span class="meta" style="color:var(--clay)">${r.error}</span>` : ''}</td>
                <td class="meta">${areas.length ? areas.slice(0, 3).join(', ') +
                  (areas.length > 3 ? ` +${areas.length - 3}` : '') : 'anywhere'}</td>
                <td class="meta num">${r.places_returned}</td>
                <td class="meta num">${r.candidates_found}</td>
                <td class="meta nw">${fmtDateTime(r.started_at)}${r.finished_at ? '' : ' · running'}</td>
                <td class="c-act"><button class="mini" data-act="open" data-id="${r.id}">Review</button></td>
              </tr>`;
            })}
          </tbody>
        </table></div>
      </div>` : ''}
  `);

  const estimate = async () => {
    const e = await api.get('/api/places/estimate', {
      areas: $('#areas', root).value, pages_per_area: $('#pages', root).value,
    });
    const el = $('#est', root);
    el.innerHTML = '';
    el.textContent = `${e.requests} request${e.requests === 1 ? '' : 's'} · about $${e.approx_usd.toFixed(2)}` +
      (e.verified_on ? ` · rates checked ${e.verified_on}` : ' · rates unverified');
    el.style.color = e.verified_on ? '' : 'var(--clay)';
  };
  let t;
  $('#areas', root).addEventListener('input', () => { clearTimeout(t); t = setTimeout(estimate, 250); });
  $('#pages', root).addEventListener('change', estimate);
  estimate();

  $('#sweep', root).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const res = await api.post('/api/places/search', Object.fromEntries(new FormData(ev.target)));
      navigate(`/search?run=${res.run.id}`);
    } catch (err) {
      toast(err.message, { error: true, ms: 7000 });
      btn.disabled = false;
    }
  });

  on(root, 'click', '[data-act="open"]', (_e, el) => navigate(`/search?run=${el.dataset.id}`));
}

/* ---------------------------------------------------------- review a run */

async function reviewRun(root, runId, navigate) {
  const picks = () => $$('.pick', root).filter((el) => el.checked && el.id !== 'pick-all').map((el) => el.value);
  const sync = () => {
    const btn = $('[data-act="import"]', root);
    if (!btn) return;
    const n = picks().length;
    btn.disabled = n === 0;
    btn.textContent = n ? `Add ${n}` : 'Add selected';
  };

  on(root, 'change', '.pick', (ev) => {
    if (ev.target.id === 'pick-all') {
      $$('.rows tbody .pick', root).forEach((c) => { c.checked = ev.target.checked; });
    }
    sync();
  });
  on(root, 'click', '[data-act="back"]', () => navigate('/search'));
  on(root, 'click', '[data-act="import"]', async (_e, btn) => {
    btn.disabled = true;
    try {
      const res = await api.post('/api/places/import', { run_id: runId, place_ids: picks() });
      toast(`Added ${res.imported}${res.skipped.length ? ` · ${res.skipped.length} skipped` : ''}`);
      await draw();
    } catch (err) {
      toast(err.message, { error: true, ms: 7000 });
      btn.disabled = false;
    }
  });

  await draw();

  async function draw() {
    const data = await api.get(`/api/places/runs/${runId}`);
    const { run, summary, running } = data;
    const candidates = data.candidates;
    const fresh = candidates.filter((c) => !c.is_lead);
    const expired = data.content_available === false;

    mount(root, html`
      <div class="bar">
        <button class="mini ghost" data-act="back">← Searches</button>
        <h2>${run.category}</h2>
        <span class="meta">${data.areas.length ? data.areas.join(', ') : 'anywhere'} ·
          ${run.places_returned} seen · ${summary.candidates} with no website</span>
        <div class="grow"></div>
        ${fresh.length && !expired ? html`
          <button class="primary" data-act="import" disabled>Add selected</button>` : ''}
      </div>

      ${running ? html`
        <div class="msg msg-info" style="margin-bottom:10px"><div class="grow" id="prog">
          <span class="spin"></span> Searching — ${run.text_search_calls} request(s)</div></div>` : ''}

      ${run.error ? html`
        <div class="msg msg-bad" style="margin-bottom:10px"><div class="grow">${run.error}</div></div>` : ''}

      ${expired ? html`
        <div class="panel"><div class="blank">
          <strong>Results expired</strong>
          Business names are held for ${data.content_ttl_minutes} minutes and never stored —
          Google's terms only allow keeping the place ID. Run the search again.
        </div></div>`
      : fresh.length === 0 && !running ? html`
        <div class="panel"><div class="blank">
          <strong>Nothing new</strong>
          ${summary.candidates ? 'All of these are already in your list.' : 'Every result had a website.'}
        </div></div>`
      : html`
        <div class="panel"><div class="scroll-x">
          <table class="rows">
            <thead><tr>
              <th class="c-pick"><input type="checkbox" id="pick-all" class="pick" aria-label="Select all"></th>
              <th>Business</th><th>Town</th><th>Address</th><th>Phone</th><th></th>
            </tr></thead>
            <tbody>
              ${candidates.map((c) => html`
                <tr>
                  <td class="c-pick">${c.is_lead ? '' : html`
                    <input type="checkbox" class="pick" value="${c.place_id}"
                           aria-label="Select ${c.display_name ?? c.place_id}">`}</td>
                  <td class="c-name"><span class="name">${c.display_name ?? '(unnamed)'}</span></td>
                  <td class="meta">${c.area ?? '—'}</td>
                  <td class="meta">${c.address ?? '—'}</td>
                  <td class="meta mono">${c.phone ?? '—'}</td>
                  <td class="c-act">${c.is_lead ? html`<span class="flag" data-ok>in list</span>` : ''}</td>
                </tr>`)}
            </tbody>
          </table>
        </div></div>
        <p class="tip">Google holds no email addresses — you'll need to find those or phone them.</p>`}
    `);

    sync();

    if (running) {
      const poller = registerInterval(setInterval(async () => {
        const next = await api.get(`/api/places/runs/${runId}`);
        if (!next.running) { clearInterval(poller); await draw(); return; }
        const el = $('#prog', root);
        if (el) el.innerHTML =
          `<span class="spin"></span> Searching — ${next.run.text_search_calls} request(s), ` +
          `${next.summary.candidates} found`;
      }, 1500));
    }
  }
}

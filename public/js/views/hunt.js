/* Hunt: the tool finding companies on its own, every day. */
import { api } from '../api.js';
import {
  html, mount, on, $, $$, toast, fmtDateTime, relative, registerInterval, confirmDialog,
} from '../dom.js';

export default async function huntView(root, _p, { refresh }) {
  const [s, ledgerRes, cstatus] = await Promise.all([
    api.get('/api/hunt/status').catch(() => null),
    api.get('/api/hunt/ledger').catch(() => ({ ledger: null })),
    api.get('/api/companies/status').catch(() => null),
  ]);
  const { ledger } = ledgerRes;

  if (!s?.configured) {
    mount(root, html`
      <div class="bar"><h2>Daily hunt</h2></div>
      <div class="panel"><div class="panel-bd">
        <div class="msg msg-warn"><div class="grow">
          Set <code class="mono">COMPANIES_HOUSE_API_KEY</code> in <code class="mono">.env</code>
          and restart — the hunt has nowhere to look without it.
          See <code class="mono">docs/COMPANIES-HOUSE.md</code>.
        </div></div>
      </div></div>`);
    return;
  }

  const c = s.config;
  const last = s.runs[0];
  const short = last && !last.error && last.found < last.target;

  // The funnel, in plain words: of everything the last run looked at, where
  // did it go? Surfaced on every run, because "1,355 looked at, 1 filed" with
  // no breakdown reads as broken, when the truth is usually one filter doing
  // exactly what it was ticked to do.
  const drops = (r) => {
    if (!r) return [];
    const out = [];
    const add = (n, label) => { if (n > 0) out.push({ n, label }); };
    add(r.had_website, 'already had a website');
    add((r.no_contact ?? 0) + (r.not_mobile ?? 0),
      c.requireMobile ? 'had no mobile on Google' : 'had no phone on Google');
    add(r.wrong_town, 'registered in another town');
    add(r.already_known, 'already seen before');
    return out.sort((a, b) => b.n - a.n);
  };
  const lastDrops = drops(last);
  const funnelLine = last && last.companies_seen
    ? `Of ${last.companies_seen.toLocaleString()} looked at: ${last.found} filed`
      + lastDrops.map((d) => ` · ${d.n.toLocaleString()} ${d.label}`).join('')
    : '';

  // Why a run came up short, told honestly. A run stops the moment it hits its
  // per-run budget (with thousands of combinations still untried), OR because
  // one filter discarded almost everything. Name whichever it was — and the
  // exact control to change — rather than always blaming "worked through".
  let shortReason = '';
  if (short) {
    const areasLeft = s.coverage.total - s.coverage.exhausted;
    const hitPages = (last.register_requests ?? 0) >= c.maxRegisterPages;
    const hitLookups = (last.places_requests ?? 0) >= c.maxPlacesRequests;
    const phoneDrop = (last.no_contact ?? 0) + (last.not_mobile ?? 0);
    const biggest = lastDrops[0];
    if (hitPages) {
      shortReason = `It read its limit of ${c.maxRegisterPages} register pages `
        + `and stopped, with ${areasLeft.toLocaleString()} trade/town combinations `
        + 'still to try. Raise “Register pages, max” below — the register is free, '
        + 'so this costs nothing — and run again.';
    } else if (hitLookups) {
      shortReason = `It used its budget of ${c.maxPlacesRequests} Google lookups `
        + `and stopped, with ${areasLeft.toLocaleString()} combinations still to try. `
        + 'Raise “Google lookups, max” below and run again (5,000 free a month).';
    } else if ((c.requirePhone || c.requireMobile) && phoneDrop >= last.found && phoneDrop > 0) {
      shortReason = `Nearly everything was dropped for having no `
        + `${c.requireMobile ? 'mobile' : 'phone'} number on Google `
        + `(${phoneDrop.toLocaleString()} of them). Businesses with no website often `
        + `aren't on Google at all, so there is no number to read — and this filter `
        + `then discards them, which is why so few come through. Untick `
        + `“Only businesses with a phone number”${c.requireMobile ? ' and “only mobiles”' : ''} `
        + `below, run again, and pull numbers afterwards with Find contacts on the Reach screen.`;
    } else if (biggest && biggest.label === 'already had a website' && biggest.n >= last.found) {
      shortReason = `Most already had a website (${biggest.n.toLocaleString()}), which is `
        + `the filter working — but it leaves fewer to find. Add more towns or trades to reach the target.`;
    } else if (biggest && biggest.label === 'registered in another town' && biggest.n >= last.found) {
      shortReason = `Most were registered in a different town (${biggest.n.toLocaleString()}). `
        + `Check the town spellings match how an address is written, or add a region with the buttons below.`;
    } else if (areasLeft <= 0) {
      shortReason = 'It has worked through every trade and town you listed. '
        + 'Add more towns or trades — worked-through ones re-open after a month.';
    } else {
      shortReason = 'Most high-street trades — hairdressers, nail bars, cafés — '
        + 'are sole traders, which Companies House does not hold and this tool '
        + 'cannot lawfully cold-contact, so the register simply has fewer of them. '
        + 'Add more towns, or mix in limited-company trades (electricians, '
        + 'plumbers, builders, garages) to reach the target faster.';
    }
  }

  mount(root, html`
    <div class="bar">
      <h2>Daily hunt</h2>
      <div class="grow"></div>
      ${s.active ? html`<span class="meta"><span class="spin"></span> running…</span>`
        : html`<button class="primary" data-act="run">Run now</button>`}
    </div>

    <div class="readout">
      <div data-accent="${s.found_today >= c.target ? '' : 'warn'}">
        <b class="num">${s.found_today}</b><span>Found today</span></div>
      <div><b class="num">${c.target}</b><span>Daily target</span></div>
      <div data-accent="${c.enabled ? '' : 'warn'}">
        <b class="num">${c.enabled ? 'On' : 'Off'}</b><span>Schedule</span></div>
      <div><b class="num">${s.coverage.total - s.coverage.exhausted}</b><span>Areas left</span></div>
      <div><b class="num">${s.coverage.found_total}</b><span>Found in total</span></div>
      ${ledger ? html`
        <div title="Companies this tool has ever shown you. None of them will be found again."
          ><b class="num">${ledger.companies}</b><span>Never repeated</span></div>
        <div title="Approached at least once, on any channel. These are not offered again."
          ><b class="num">${ledger.contacted}</b><span>Approached</span></div>` : ''}
    </div>

    ${s.active ? html`
      <div class="msg msg-info" style="margin-bottom:10px"><div class="grow" id="prog">
        <span class="spin"></span> Found ${s.active.found} of ${s.active.target} —
        ${s.active.companies_seen} companies looked at
      </div></div>` : ''}

    ${last?.error ? html`
      <div class="msg msg-bad" style="margin-bottom:10px"><div class="grow">
        Last run stopped: ${last.error}</div></div>` : ''}

    ${short ? html`
      <div class="msg msg-warn" style="margin-bottom:10px"><div class="grow">
        Last run found ${last.found} of ${last.target}. ${shortReason}
      </div></div>` : ''}

    ${!s.active && funnelLine ? html`
      <div class="msg msg-info" style="margin-bottom:10px"><div class="grow">
        ${funnelLine}.</div></div>` : ''}

    ${c.enabled && !s.active ? html`
      <div class="msg msg-info" style="margin-bottom:10px"><div class="grow">
        Next run ${s.next_run ? relative(s.next_run).replace('ago', '') : ''}
        at ${String(c.hour).padStart(2, '0')}:00, if the server is running.
        For a machine that sleeps, put <code class="mono">npm run hunt</code> in cron instead.
      </div></div>` : ''}

    <details class="panel" id="finder">
      <summary class="panel-hd">
        <span class="caret" aria-hidden="true">▸</span>
        <h3 class="grow">Search a trade &amp; town right now</h3>
        <span class="meta">one-off, hand-picked — the daily hunt does this on a schedule</span>
      </summary>
      <div class="panel-bd">
        <div class="cols">
          <div class="f">
            <label for="f-trade">Trade</label>
            <input id="f-trade" list="f-trades" type="text" placeholder="roofers" autocomplete="off">
            <datalist id="f-trades">
              ${(cstatus?.trades ?? []).map((t) => html`<option value="${t.example}">${t.label}</option>`)}
            </datalist>
            <p class="tip" id="f-sic"></p>
          </div>
          <div class="f">
            <label for="f-town">Town <span class="opt">optional</span></label>
            <input id="f-town" type="text" placeholder="Otley" autocomplete="off">
            <p class="tip">Matches whole words in the registered office — a town or a
              full postcode, not a partial one like LS21.</p>
          </div>
        </div>
        <div class="bar" style="margin:0">
          <button type="button" class="primary" data-act="find-run">Search the register</button>
          <span class="meta">Free, and every result is an active company you may lawfully email.</span>
        </div>
        <div id="find-out"></div>
      </div>
    </details>

    <form id="cfg">
      <div class="panel">
        <div class="panel-hd"><h3 class="grow">What to hunt</h3>
          ${s.plan.combinations
            ? html`<span class="meta">${s.plan.combinations} trade/town combination${s.plan.combinations === 1 ? '' : 's'}</span>`
            : html`<span class="flag">nothing to search</span>`}
        </div>
        <div class="panel-bd">
          <div class="cols">
            <div class="f">
              <label for="h-trades">Trades <span class="opt">one per line</span></label>
              <textarea id="h-trades" name="hunt_trades" rows="6"
                        placeholder="roofers&#10;plasterers&#10;electricians">${c.trades.join('\n')}</textarea>
              <p class="tip">
                <button type="button" class="mini" data-act="add-all-trades">Add every trade</button>
                — 80+ trades covering building, home services, motor, beauty, food, retail.
                Existing lines are kept; duplicates are dropped.
              </p>
              ${s.plan.unrecognised_trades.length ? html`
                <p class="tip" style="color:var(--clay)">
                  No SIC code for: ${s.plan.unrecognised_trades.join(', ')} — reword, or use a code.
                </p>` : ''}
            </div>
            <div class="f">
              <label for="h-areas">Towns <span class="opt">one per line</span></label>
              <textarea id="h-areas" name="hunt_areas" rows="6"
                        placeholder="Otley&#10;Ilkley&#10;Skipton">${c.areas.join('\n')}</textarea>
              <div class="bar" style="flex-wrap:wrap;gap:6px;margin-top:8px" id="town-presets">
                <span class="meta">Add a region:</span>
              </div>
              <p class="tip">Existing lines are kept; duplicates are dropped.
                There is no "every town" button on purpose — the hunt works
                through every trade in every town, so the two multiply.
                <b id="combo-note"></b></p>
            </div>
          </div>
          ${s.plan.trades.filter((t) => t.codes.length).length ? html`
            <p class="tip">
              ${s.plan.trades.filter((t) => t.codes.length).map((t) =>
                html`<span class="flag" data-ok style="margin-right:4px">${t.trade} → ${t.codes.join(', ')}</span>`)}
            </p>` : ''}
        </div>
      </div>

      <div class="panel">
        <div class="panel-hd"><h3>How it runs</h3></div>
        <div class="panel-bd">
          <div class="cols-3">
            <div class="f">
              <label for="h-target">Find per day</label>
              <input id="h-target" name="hunt_daily_target" type="number" min="1" max="500" value="${c.target}">
            </div>
            <div class="f">
              <label for="h-hour">Run at</label>
              <input id="h-hour" name="hunt_hour" type="number" min="0" max="23" value="${c.hour}">
            </div>
            <div class="f">
              <label for="h-mix">Max per trade</label>
              <input id="h-mix" name="hunt_max_per_trade" type="number" min="1" max="50"
                     value="${c.maxPerTrade}">
              <p class="tip">So a day's leads are a mix, not twenty roofers.
                Raised automatically if you have too few trades listed to reach
                the target.</p>
            </div>
            <div class="f">
              <label for="h-pages">Register pages, max</label>
              <input id="h-pages" name="hunt_max_register_pages" type="number" min="1" max="500"
                     value="${c.maxRegisterPages}">
            </div>
            <div class="f">
              <label for="h-places">Google lookups, max</label>
              <input id="h-places" name="hunt_max_places_requests" type="number" min="1" max="500"
                     value="${c.maxPlacesRequests}">
              <p class="tip">The only part that costs money — about one per town.</p>
            </div>
          </div>

          <div class="check" style="margin-top:6px">
            <input id="h-enabled" name="hunt_enabled" type="checkbox" ${c.enabled ? 'checked' : ''}>
            <label for="h-enabled">Run automatically every day</label>
          </div>
          <div class="check" style="margin-top:8px">
            <input id="h-places" name="hunt_include_places" type="checkbox"
                   ${s.places_configured && c.includePlaces ? 'checked' : ''}
                   ${s.places_configured ? '' : 'disabled'}>
            <label for="h-places">Also find businesses straight from Google
              <span class="tip" style="display:block;font-weight:400">
                On top of the Companies House register, pull Google's own listings for
                each trade and town and file the no-website ones — they come <b>with a
                phone number</b>, so these are the leads you can actually WhatsApp.
                ${!s.places_configured ? html`<span class="flag">needs a Google key</span>` : ''}</span></label>
          </div>
          <div class="check" style="margin-top:8px">
            <input id="h-nosite" name="hunt_require_no_website" type="checkbox"
                   ${s.places_configured && c.requireNoWebsite ? 'checked' : ''}
                   ${s.places_configured ? '' : 'disabled'}>
            <label for="h-nosite">Only businesses with no website
              ${!s.places_configured ? html`<span class="flag">needs a Google key</span>` : ''}</label>
          </div>
          ${!s.places_configured ? html`
            <p class="tip" style="margin-top:4px">
              Whether a business has a website is a question only Google can
              answer, so this needs <code class="mono">GOOGLE_MAPS_API_KEY</code>
              in <code class="mono">.env</code>. Until then the hunt files every
              company it finds and you check them yourself — more leads, more
              sifting.
            </p>` : ''}
          <div class="check" style="margin-top:8px">
            <input id="h-phone" name="hunt_require_phone" type="checkbox"
                   ${s.places_configured && c.requirePhone ? 'checked' : ''}
                   ${s.places_configured ? '' : 'disabled'}>
            <label for="h-phone">Only businesses with a phone number
              ${!s.places_configured ? html`<span class="flag">needs a Google key</span>` : ''}</label>
          </div>
          <div class="check" style="margin-top:6px;margin-left:22px">
            <input id="h-mobile" name="hunt_require_mobile" type="checkbox"
                   ${s.places_configured && c.requireMobile ? 'checked' : ''}
                   ${s.places_configured ? '' : 'disabled'}>
            <label for="h-mobile">…and only mobiles, starting 07
              <span class="tip" style="display:block;font-weight:400">
                WhatsApp and SMS reach 07 numbers and nothing else. A landline is a
                phone call in office hours — which is the one channel that costs you
                an hour a day. Tightest filter here: expect far fewer, all of them
                messageable.</span></label>
          </div>
          <div id="phone-filter-warn" class="msg msg-warn" style="margin-top:8px"
               ${(c.requirePhone || c.requireMobile) ? '' : 'hidden'}>
            <div class="grow">
              <b>This is the setting that starves the hunt.</b> It only keeps a
              business if Google already shows a number for it — but a business
              with no website usually isn't on Google at all, so there's nothing
              to read and it gets binned. On the last run this dropped the vast
              majority of what it looked at. Leave it <b>off</b>: the hunt files
              every no-website company, and <b>Find contacts</b> pulls the mobile
              afterwards so you can still WhatsApp them.
            </div>
          </div>
          <p class="tip" style="margin-top:4px">
            Neither Companies House nor Google holds an email address, so there
            is no "must have an email" to tick — nothing could satisfy it.
            The phone number comes from the Google listing, which is also the
            only reason a lead arrives contactable at all. Emails are found
            afterwards, per lead, with <b>Find contacts</b> on the Reach screen.
          </p>
          <div class="check" style="margin-top:8px">
            <input id="h-unlisted" name="hunt_include_unlisted" type="checkbox" ${c.includeUnlisted ? 'checked' : ''}>
            <label for="h-unlisted">Include companies Google has never heard of
              <span class="tip" style="display:block;font-weight:400">
                No listing usually means no website either — but a registered office can be an
                accountant's address rather than a working yard.</span></label>
          </div>
        </div>
      </div>

      <div class="bar" style="margin-top:12px">
        <button type="submit" class="primary">Save</button>
        <span class="meta">Everything the hunt finds still needs an email address and your
          confirmation before anything is sent.</span>
      </div>
    </form>

    ${s.runs.length ? html`
      <div class="panel">
        <div class="panel-hd"><h3 class="grow">Recent runs</h3></div>
        <div class="scroll-x"><table class="rows">
          <thead><tr><th class="nw">When</th><th>How</th><th class="num">Found</th>
            <th class="num">Seen</th><th class="num">Had a site</th>
            <th class="num" title="Skipped: Google held no phone number">No phone</th>
            <th class="num" title="Skipped: the only number was a landline, which WhatsApp and SMS cannot reach">Landline</th>
            <th class="num" title="Skipped: the address matched but the town did not">Wrong town</th>
            <th class="num">Requests</th>
            <th>Covered</th></tr></thead>
          <tbody>
            ${s.runs.map((r) => html`
              <tr>
                <td class="meta nw">${fmtDateTime(r.started_at)}</td>
                <td class="meta">${r.trigger}</td>
                <td class="num"><b>${r.found}</b><span class="meta">/${r.target}</span></td>
                <td class="meta num">${r.companies_seen}</td>
                <td class="meta num">${r.had_website}</td>
                <td class="meta num">${r.no_contact ?? 0}</td>
                <td class="meta num">${r.not_mobile ?? 0}</td>
                <td class="meta num">${r.wrong_town ?? 0}</td>
                <td class="meta num">${r.register_requests + r.places_requests}</td>
                <td class="meta">${r.error
                  ? html`<span style="color:var(--clay)">${r.error}</span>`
                  : (r.areas_covered ?? '—')}</td>
              </tr>`)}
          </tbody>
        </table></div>
      </div>` : ''}

    ${s.targets.length ? html`
      <div class="panel">
        <div class="panel-hd"><h3 class="grow">Ground covered</h3>
          <span class="meta">${s.coverage.exhausted} of ${s.coverage.total} worked through</span>
        </div>
        <div class="scroll-x"><table class="rows">
          <thead><tr><th>Trade</th><th>Town</th><th class="num">Read</th>
            <th class="num">Found</th><th class="nw">Last</th><th></th></tr></thead>
          <tbody>
            ${s.targets.map((t) => html`
              <tr>
                <td class="c-name"><span class="name" style="font-size:.9rem">${t.trade}</span>
                  <span class="meta mono">${t.sic_codes}</span></td>
                <td class="meta">${t.area ?? 'anywhere'}</td>
                <td class="meta num">${t.cursor}</td>
                <td class="meta num">${t.found_total}</td>
                <td class="meta nw">${t.last_run_at ? relative(t.last_run_at) : 'never'}</td>
                <td class="c-act">
                  ${t.exhausted_at ? html`<span class="flag">worked through</span>` : ''}
                  <button class="mini" data-act="reset" data-id="${t.id}">Restart</button>
                </td>
              </tr>`)}
          </tbody>
        </table></div>
      </div>` : ''}
  `);

  // The one-off register search, folded in from the old Find screen. Same
  // source the daily hunt works through — here as a hand-picked "get me these
  // right now". Kept out of #cfg so its inputs are never saved as settings.
  wireFinder();

  function wireFinder() {
    const tradeEl = $('#f-trade', root);
    if (!tradeEl) return;
    let results = null;

    const showSic = async () => {
      const el = $('#f-sic', root);
      const q = tradeEl.value.trim();
      if (!el) return;
      if (!q) { el.textContent = ''; return; }
      try {
        const t = await api.get('/api/companies/trade', { q });
        el.textContent = t.codes.length
          ? `SIC ${t.codes.join(', ')}${t.label ? ` — ${t.label}` : ''}`
          : 'No SIC code for that — try another word, or type a code such as 43910.';
        el.style.color = t.codes.length ? '' : 'var(--clay)';
      } catch { /* the hint is optional */ }
    };
    let deb;
    tradeEl.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(showSic, 250); });

    const picks = () => $$('.f-pick', root)
      .filter((c) => c.checked && c.id !== 'f-pick-all').map((c) => c.value);
    const sync = () => {
      const add = $('[data-act="find-add"]', root);
      if (!add) return;
      const n = picks().length;
      add.disabled = n === 0;
      add.textContent = n ? `Add ${n} as leads` : 'Add selected';
    };

    const draw = () => {
      const out = $('#find-out', root);
      const fresh = results.companies.filter((cc) => !cc.already_a_lead);
      mount(out, html`
        <div class="panel" style="margin-top:12px">
          <div class="panel-hd">
            <h3 class="grow">${results.total.toLocaleString('en-GB')} active
              ${results.trade.label ?? 'companies'}${results.location ? ` around ${results.location}` : ''}
              <span class="meta">— showing ${results.companies.length}</span></h3>
            <button class="primary" data-act="find-add" disabled>Add selected</button>
          </div>
          ${fresh.length === 0 ? html`
            <div class="blank"><strong>All of these are already leads</strong>
              Try another town, or a different trade.</div>` : html`
            <div class="scroll-x"><table class="rows">
              <thead><tr>
                <th class="c-pick"><input type="checkbox" id="f-pick-all" class="f-pick" aria-label="Select all"></th>
                <th>Company</th><th>Registered office</th><th class="nw">No.</th>
                <th class="nw">Since</th><th>Website</th><th></th>
              </tr></thead>
              <tbody>
                ${results.companies.map((cc) => html`
                  <tr>
                    <td class="c-pick">${cc.already_a_lead ? '' : html`
                      <input type="checkbox" class="f-pick" value="${cc.company_number}"
                             aria-label="Select ${cc.company_name}">`}</td>
                    <td class="c-name"><span class="name">${cc.company_name}</span>
                      <span class="meta">${cc.company_type}${cc.sic_codes.length ? ` · SIC ${cc.sic_codes.join(', ')}` : ''}</span></td>
                    <td class="meta">${cc.address_snippet ?? '—'}</td>
                    <td class="meta mono nw">${cc.company_number}</td>
                    <td class="meta nw">${(cc.date_of_creation ?? '').slice(0, 4)}</td>
                    <td>${cc.has_website === false ? html`<span class="flag">none found</span>`
                        : cc.has_website === true ? html`<span class="meta">has one</span>`
                        : html`<span class="meta">—</span>`}</td>
                    <td class="c-act">${cc.already_a_lead ? html`<span class="flag" data-ok>a lead</span>` : ''}</td>
                  </tr>`)}
              </tbody>
            </table></div>`}
        </div>
        <p class="tip">Neither Companies House nor Google holds an email address —
          the <a href="#/leads">lead list</a> shows which of these still need one.</p>`);
      sync();
    };

    const runSearch = async () => {
      const out = $('#find-out', root);
      const trade = tradeEl.value.trim();
      if (!trade) { toast('Type a trade first'); return; }
      mount(out, html`<div class="loading" style="margin-top:12px"><span class="spin"></span></div>`);
      try {
        results = await api.post('/api/companies/discover', {
          trade, location: $('#f-town', root).value, size: 100,
        });
      } catch (err) {
        mount(out, html`<div class="msg msg-bad" style="margin-top:12px"><div class="grow">${err.message}</div></div>`);
        return;
      }
      draw();
    };

    for (const el of [tradeEl, $('#f-town', root)]) {
      el?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); runSearch(); }
      });
    }
    on(root, 'click', '[data-act="find-run"]', runSearch);
    on(root, 'change', '.f-pick', (ev) => {
      if (ev.target.id === 'f-pick-all') {
        $$('.rows tbody .f-pick', root).forEach((c) => { c.checked = ev.target.checked; });
      }
      sync();
    });
    on(root, 'click', '[data-act="find-add"]', async (_e, btn) => {
      const chosen = picks();
      if (!chosen.length) return;
      btn.disabled = true;
      try {
        const res = await api.post('/api/companies/discover/import', {
          company_numbers: chosen,
          companies: results.companies,
          category: results.trade.label ?? tradeEl.value,
        });
        toast(`Added ${res.imported}${res.skipped?.length ? ` · ${res.skipped.length} skipped` : ''} — on the Leads screen`);
        await runSearch();
      } catch (err) {
        toast(err.message, { error: true, ms: 7000 });
        btn.disabled = false;
      }
    });
  }

  $('#cfg', root).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = Object.fromEntries(new FormData(ev.target));

    // Normalise every checkbox, found from the form itself rather than a
    // list someone has to remember to extend.
    //
    // FormData omits an unchecked box entirely and gives a checked one the
    // string "on", so both directions need fixing: without this an unticked
    // box stays ticked, and a box missing from the list saves "on" — which
    // is not "1", so it reads back as off and appears to untick itself on
    // save. That is exactly what happened when the phone filter was added
    // and the list was not updated with it.
    for (const box of ev.target.querySelectorAll('input[type="checkbox"]')) {
      if (box.name) form[box.name] = box.checked ? '1' : '0';
    }
    try {
      await api.settings.save(form);
      await api.post('/api/hunt/sync-targets');
      toast('Saved');
      refresh();
    } catch (err) {
      toast(err.message, { error: true, ms: 7000 });
    }
  });

  // Live warning: the phone/mobile filters are the usual reason a run finds
  // almost nothing, so say so the moment either is ticked, not just after a
  // wasted run.
  const phoneWarn = () => {
    const warn = $('#phone-filter-warn', root);
    if (!warn) return;
    warn.hidden = !($('#h-phone', root)?.checked || $('#h-mobile', root)?.checked);
  };
  $('#h-phone', root)?.addEventListener('change', phoneWarn);
  $('#h-mobile', root)?.addEventListener('change', phoneWarn);

  on(root, 'click', '[data-act="add-all-trades"]', async (_e, btn) => {
    btn.disabled = true;
    try {
      const { trades } = await api.get('/api/hunt/trades');
      const ta = $('#h-trades', root);
      const existing = new Set(
        (ta.value ?? '').split(/\n/).map((s) => s.trim().toLowerCase()).filter(Boolean)
      );
      const added = trades.filter((t) => !existing.has(t.toLowerCase()));
      if (!added.length) {
        toast('Every recognised trade is already listed');
        return;
      }
      const lines = (ta.value ? [ta.value.replace(/\s+$/, ''), ''] : []).concat(added);
      ta.value = lines.join('\n');
      toast(`Added ${added.length} trade${added.length === 1 ? '' : 's'} — Save to apply`);
    } catch (err) {
      toast(err.message ?? 'Could not load trades', { error: true });
    } finally {
      btn.disabled = false;
    }
  });

  /**
   * Region buttons. Fetched rather than hard-coded in the view so the town
   * lists have one home, on the server, next to the note explaining why the
   * spellings are what they are.
   */
  (async () => {
    const bar = $('#town-presets', root);
    if (!bar) return;
    let regions = [];
    try {
      ({ regions } = await api.get('/api/hunt/towns'));
    } catch {
      bar.remove();
      return;
    }
    for (const r of regions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini';
      b.dataset.act = 'add-towns';
      b.dataset.key = r.key;
      b.title = `${r.note} ${r.towns.length} towns.`;
      b.textContent = `${r.label} (${r.towns.length})`;
      bar.appendChild(b);
    }

    // How much work the current pair actually implies. A number beats a
    // warning: 80 trades across 40 towns is 3,200 combinations, and seeing
    // that is what stops someone pasting in the whole country.
    const combos = () => {
      const n = (sel) => ($(sel, root)?.value ?? '')
        .split(/\n/).map((x) => x.trim()).filter(Boolean).length;
      const t = n('#h-trades');
      const a = n('#h-areas');
      const note = $('#combo-note', root);
      if (!note) return;
      note.textContent = (t && a)
        ? `Right now: ${t} × ${a} = ${(t * a).toLocaleString()} combinations to work through.`
        : '';
    };
    combos();
    for (const sel of ['#h-trades', '#h-areas']) {
      $(sel, root)?.addEventListener('input', combos);
    }

    on(root, 'click', '[data-act="add-towns"]', (_e, btn) => {
      const region = regions.find((x) => x.key === btn.dataset.key);
      if (!region) return;
      const ta = $('#h-areas', root);
      const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
      const existing = (ta.value ?? '').split(/\n/).map((x) => x.trim()).filter(Boolean);
      const seen = new Set(existing.map(norm));
      const added = region.towns.filter((t) => !seen.has(norm(t)));
      if (!added.length) {
        toast(`Every ${region.label} town is already listed`);
        return;
      }
      ta.value = existing.concat(added).join('\n');
      combos();
      toast(`Added ${added.length} town${added.length === 1 ? '' : 's'} — Save to apply`);
    });
  })();

  on(root, 'click', '[data-act="run"]', async (_e, btn) => {
    btn.disabled = true;
    try {
      await api.post('/api/hunt/run', {});
      toast('Hunting…');
      watch();
    } catch (err) {
      toast(err.message, { error: true, ms: 8000 });
      btn.disabled = false;
    }
  });

  on(root, 'click', '[data-act="reset"]', async (_e, el) => {
    if (!await confirmDialog({
      title: 'Restart this town',
      message: 'Read it from the beginning of the register again. Companies already held are '
             + 'still skipped, so this only helps if the list has grown.',
      confirmLabel: 'Restart',
    })) return;
    await api.post(`/api/hunt/targets/${el.dataset.id}/reset`);
    refresh();
  });

  if (s.active) watch();

  function watch() {
    const poller = registerInterval(setInterval(async () => {
      const next = await api.get('/api/hunt/status');
      if (!next.active) {
        clearInterval(poller);
        const run = next.runs[0];
        toast(run?.error ? `Stopped: ${run.error}` : `Found ${run?.found ?? 0}`, {
          error: Boolean(run?.error), ms: 6000,
        });
        refresh();
        return;
      }
      const el = $('#prog', root);
      if (el) {
        el.innerHTML = '';
        el.textContent = `Found ${next.active.found} of ${next.active.target} — `
                       + `${next.active.companies_seen} companies looked at`;
      }
    }, 1500));
  }
}

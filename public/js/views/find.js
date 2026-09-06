/* Find: search the companies register by trade and town.
   Everything this returns is an active body corporate, so it is qualified to
   email before it becomes a lead — the opposite way round from searching a
   map and hoping. */
import { api } from '../api.js';
import { html, mount, on, $, $$, toast, viewKeys } from '../dom.js';

export default async function findView(root, params, { navigate }) {
  const status = await api.get('/api/companies/status').catch(() => null);

  if (!status?.configured) {
    mount(root, html`
      <div class="bar"><h2>Find companies</h2></div>
      <div class="panel"><div class="panel-bd">
        <div class="msg msg-warn"><div class="grow">
          Set <code class="mono">COMPANIES_HOUSE_API_KEY</code> in <code class="mono">.env</code>
          and restart. The key is free — see <code class="mono">docs/COMPANIES-HOUSE.md</code>.
        </div></div>
        <p class="tip" style="margin-top:12px">
          Meanwhile <a href="#/places">searching Google Places</a> still works, but almost
          everything it finds will need checking by hand.
        </p>
      </div></div>`);
    return;
  }

  let results = null;

  const picks = () => $$('.pick', root).filter((c) => c.checked && c.id !== 'pick-all').map((c) => c.value);
  const sync = () => {
    const n = picks().length;
    const add = $('[data-act="add"]', root);
    const check = $('[data-act="check"]', root);
    if (add) { add.disabled = n === 0; add.textContent = n ? `Add ${n} as leads` : 'Add selected'; }
    if (check) check.disabled = n === 0;
  };

  on(root, 'change', '.pick', (ev) => {
    if (ev.target.id === 'pick-all') {
      $$('.rows tbody .pick', root).forEach((c) => { c.checked = ev.target.checked; });
    }
    sync();
  });

  on(root, 'click', '[data-act="add"]', async (_e, btn) => {
    btn.disabled = true;
    try {
      const chosen = picks();
      const res = await api.post('/api/companies/discover/import', {
        company_numbers: chosen,
        companies: results.companies,
        category: results.trade.label ?? $('#trade', root).value,
      });
      toast(`Added ${res.imported}${res.skipped.length ? ` · ${res.skipped.length} skipped` : ''}`);
      await run();
    } catch (err) {
      toast(err.message, { error: true, ms: 7000 });
      btn.disabled = false;
    }
  });

  render();

  function render() {
    mount(root, html`
      <div class="bar">
        <h2>Find companies</h2>
        <div class="grow"></div>
        ${status.unchecked ? html`
          <a class="meta" href="#/leads?status=all">${status.unchecked} existing lead(s) still unchecked</a>` : ''}
        <a class="btn mini" href="#/places">Search Google instead</a>
      </div>

      <div class="panel">
        <div class="panel-bd">
          <form id="search">
            <div class="cols">
              <div class="f">
                <label for="trade">Trade</label>
                <input id="trade" name="trade" list="trades" type="text" required
                       placeholder="roofers" autocomplete="off" value="${params.trade ?? ''}">
                <datalist id="trades">
                  ${status.trades.map((t) => html`<option value="${t.example}">${t.label}</option>`)}
                </datalist>
                <p class="tip" id="sic"></p>
              </div>
              <div class="f">
                <label for="location">Town or postcode <span class="opt">optional</span></label>
                <input id="location" name="location" type="text" placeholder="Otley"
                       autocomplete="off" value="${params.location ?? ''}">
              </div>
            </div>
            <div class="bar" style="margin:0">
              <button type="submit" class="primary">Search the register</button>
              <span class="meta">Free, and every result is a company you may lawfully email.</span>
            </div>
          </form>
        </div>
      </div>

      <div id="out"></div>
    `);

    const trade = $('#trade', root);
    const showSic = async () => {
      const el = $('#sic', root);
      if (!trade.value.trim()) { el.textContent = ''; return; }
      const t = await api.get('/api/companies/trade', { q: trade.value });
      el.textContent = t.codes.length
        ? `SIC ${t.codes.join(', ')}${t.label ? ` — ${t.label}` : ''}`
        : 'No SIC code for that — try another word, or type a code such as 43910.';
      el.style.color = t.codes.length ? '' : 'var(--clay)';
    };
    let deb;
    trade.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(showSic, 250); });
    showSic();

    $('#search', root).addEventListener('submit', (ev) => {
      ev.preventDefault();
      run(Object.fromEntries(new FormData(ev.target)));
    });

    viewKeys(root, (ev) => { if (ev.key === '/') { ev.preventDefault(); trade.focus(); } });
  }

  async function run(form) {
    const body = form ?? {
      trade: $('#trade', root)?.value, location: $('#location', root)?.value,
    };
    const out = $('#out', root);
    mount(out, html`<div class="loading"><span class="spin"></span></div>`);
    try {
      results = await api.post('/api/companies/discover', { ...body, size: 100 });
    } catch (err) {
      mount(out, html`<div class="msg msg-bad"><div class="grow">${err.message}</div></div>`);
      return;
    }
    drawResults();
  }

  function drawResults() {
    const out = $('#out', root);
    const fresh = results.companies.filter((c) => !c.already_a_lead);
    const noSite = results.companies.filter((c) => c.has_website === false).length;

    mount(out, html`
      <div class="panel">
        <div class="panel-hd">
          <h3 class="grow">${results.total.toLocaleString('en-GB')} active
            ${results.trade.label ?? 'companies'}${results.location ? ` around ${results.location}` : ''}
            <span class="meta">— showing ${results.companies.length}</span></h3>
          ${noSite ? html`<span class="flag">${noSite} with no website</span>` : ''}
          <button class="mini" data-act="check" disabled>Check for websites</button>
          <button class="primary" data-act="add" disabled>Add selected</button>
        </div>
        ${fresh.length === 0 ? html`
          <div class="blank"><strong>All of these are already leads</strong>
            Try another town, or a different trade.</div>` : html`
          <div class="scroll-x"><table class="rows">
            <thead><tr>
              <th class="c-pick"><input type="checkbox" id="pick-all" class="pick" aria-label="Select all"></th>
              <th>Company</th><th>Registered office</th><th class="nw">No.</th>
              <th class="nw">Since</th><th>Website</th><th></th>
            </tr></thead>
            <tbody>
              ${results.companies.map((c) => html`
                <tr>
                  <td class="c-pick">${c.already_a_lead ? '' : html`
                    <input type="checkbox" class="pick" value="${c.company_number}"
                           aria-label="Select ${c.company_name}">`}</td>
                  <td class="c-name"><span class="name">${c.company_name}</span>
                    <span class="meta">${c.company_type}${c.sic_codes.length ? ` · SIC ${c.sic_codes.join(', ')}` : ''}</span></td>
                  <td class="meta">${c.address_snippet ?? '—'}</td>
                  <td class="meta mono nw">${c.company_number}</td>
                  <td class="meta nw">${(c.date_of_creation ?? '').slice(0, 4)}</td>
                  <td>${c.has_website === false ? html`<span class="flag">none found</span>`
                      : c.has_website === true ? html`<span class="meta">has one</span>`
                      : html`<span class="meta">—</span>`}</td>
                  <td class="c-act">${c.already_a_lead ? html`<span class="flag" data-ok>a lead</span>` : ''}</td>
                </tr>`)}
            </tbody>
          </table></div>`}
      </div>
      <p class="tip">
        Companies House holds no email addresses, and neither does Google. Once these are leads,
        the <a href="#/leads">lead list</a> shows which still need one.
      </p>
    `);
    sync();
  }

  /* Checking for websites needs the companies to be leads first, because the
     answer is stored against a lead. */
  on(root, 'click', '[data-act="check"]', async (_e, btn) => {
    const chosen = picks();
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const added = await api.post('/api/companies/discover/import', {
        company_numbers: chosen, companies: results.companies,
        category: results.trade.label ?? '',
      });
      const ids = added.leads.map((l) => l.id);
      if (!ids.length) { toast('Those are already leads — check them from the lead list'); return; }

      const res = await api.post('/api/places/check-website', { lead_ids: ids });
      toast(`${res.without_website} of ${res.checked} have no website`);
      navigate('/leads?sort=created');
    } catch (err) {
      toast(err.message, { error: true, ms: 8000 });
      btn.disabled = false;
      btn.textContent = 'Check for websites';
    }
  });
}

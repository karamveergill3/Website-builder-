/* Settings: the details that legally must appear in every email, plus limits. */
import { api } from '../api.js';
import { html, mount, $, toast } from '../dom.js';

const IDENTITY = [
  { k: 'biz_contact_name',  l: 'Your name',      req: true },
  { k: 'biz_name',          l: 'Trading name',   req: true },
  { k: 'biz_email',         l: 'Contact email',  req: true, type: 'email' },
  { k: 'biz_phone',         l: 'Phone',          type: 'tel' },
  { k: 'biz_website',       l: 'Your website' },
  { k: 'biz_company_number', l: 'Company no.',   mono: true },
  { k: 'biz_place_of_registration', l: 'Registered in', ph: 'England and Wales' },
  { k: 'biz_vat_number',    l: 'VAT no.',        mono: true },
];

export default async function settingsView(root, _p, { refresh }) {
  const data = await api.settings.get();
  const s = data.settings;
  const c = data.compliance;

  const field = (f) => html`
    <div class="f">
      <label for="s-${f.k}">${f.l}${f.req ? '' : html` <span class="opt">optional</span>`}</label>
      <input id="s-${f.k}" name="${f.k}" type="${f.type ?? 'text'}" value="${s[f.k] ?? ''}"
             placeholder="${f.ph ?? ''}" class="${f.mono ? 'mono' : ''}" autocomplete="off">
    </div>`;

  mount(root, html`
    <div class="bar">
      <h2>Settings</h2>
      <div class="grow"></div>
      ${c.complete
        ? html`<span class="flag" data-ok>Ready to send</span>`
        : html`<span class="flag">Sending blocked — ${c.missing.map((m) => m.label).join(', ')}</span>`}
    </div>

    <form id="settings">
      <div class="panel">
        <div class="panel-hd"><h3>Your details</h3>
          <span class="meta grow" style="text-align:right">Appended to every email</span></div>
        <div class="panel-bd">
          <div class="cols">${IDENTITY.map(field)}</div>
          <div class="f">
            <label for="s-biz_address">Postal address <span class="opt">required</span></label>
            <textarea id="s-biz_address" name="biz_address" rows="2">${s.biz_address ?? ''}</textarea>
          </div>
          <div class="f">
            <label for="s-optout_line">Opt-out line</label>
            <input id="s-optout_line" name="optout_line" type="text" value="${s.optout_line ?? ''}">
          </div>
          <details>
            <summary class="tip" style="cursor:pointer">More footer wording</summary>
            <div style="margin-top:10px">
              <div class="f">
                <label for="s-marketing_line">Marketing declaration</label>
                <input id="s-marketing_line" name="marketing_line" type="text" value="${s.marketing_line ?? ''}">
              </div>
              <div class="f">
                <label for="s-source_line">Where you got their details</label>
                <textarea id="s-source_line" name="source_line" rows="2">${s.source_line ?? ''}</textarea>
              </div>
            </div>
          </details>
        </div>
      </div>

      <div class="panel">
        <div class="panel-hd"><h3>Sending limits</h3></div>
        <div class="panel-bd">
          <div class="cols-3">
            <div class="f">
              <label for="s-daily_cap">Per day</label>
              <input id="s-daily_cap" name="daily_cap" type="number" min="1" max="500" value="${s.daily_cap}">
            </div>
            <div class="f">
              <label for="s-send_delay_min_seconds">Gap from (sec)</label>
              <input id="s-send_delay_min_seconds" name="send_delay_min_seconds" type="number"
                     min="0" max="3600" value="${s.send_delay_min_seconds}">
            </div>
            <div class="f">
              <label for="s-send_delay_max_seconds">…to (sec)</label>
              <input id="s-send_delay_max_seconds" name="send_delay_max_seconds" type="number"
                     min="0" max="3600" value="${s.send_delay_max_seconds}">
            </div>
          </div>
          <p class="tip">Gaps are randomised between the two — a fixed interval looks automated.</p>
        </div>
      </div>

      <div class="panel">
        <div class="panel-hd"><h3>Search</h3></div>
        <div class="panel-bd">
          <div class="cols">
            <div class="f">
              <label for="s-default_areas">Default towns</label>
              <textarea id="s-default_areas" name="default_areas" rows="3"
                        placeholder="Leeds&#10;Bradford">${s.default_areas ?? ''}</textarea>
            </div>
            <div class="f">
              <label for="s-default_region_code">Region</label>
              <input id="s-default_region_code" name="default_region_code" type="text"
                     value="${s.default_region_code ?? 'GB'}" style="max-width:90px">
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-hd"><h3>Places pricing</h3>
          <div class="grow"></div>
          ${s.places_pricing_verified_on
            ? html`<span class="flag" data-ok>Checked ${s.places_pricing_verified_on}</span>`
            : html`<span class="flag">Unverified</span>`}
        </div>
        <div class="panel-bd">
          <div class="cols-3">
            <div class="f">
              <label for="s-places_text_search_per_1000">Text Search $/1,000</label>
              <input id="s-places_text_search_per_1000" name="places_text_search_per_1000"
                     type="text" value="${s.places_text_search_per_1000 ?? '35'}">
            </div>
            <div class="f">
              <label for="s-places_details_per_1000">Details $/1,000</label>
              <input id="s-places_details_per_1000" name="places_details_per_1000"
                     type="text" value="${s.places_details_per_1000 ?? '20'}">
            </div>
            <div class="f">
              <label for="s-places_free_calls_per_month">Free calls/month</label>
              <input id="s-places_free_calls_per_month" name="places_free_calls_per_month"
                     type="text" value="${s.places_free_calls_per_month ?? '5000'}">
            </div>
            <div class="f">
              <label for="s-places_pricing_verified_on">Checked on</label>
              <input id="s-places_pricing_verified_on" name="places_pricing_verified_on"
                     type="text" placeholder="2026-09-06" value="${s.places_pricing_verified_on ?? ''}">
            </div>
          </div>
          <p class="tip">
            Read the current rates on
            <a href="https://developers.google.com/maps/documentation/places/web-service/usage-and-billing"
               target="_blank" rel="noopener">Google's billing page</a> and date the box.
          </p>
        </div>
      </div>

      <div class="bar" style="margin-top:14px">
        <button type="submit" class="primary">Save</button>
      </div>
    </form>

    <div class="panel">
      <div class="panel-hd"><h3>Footer preview</h3></div>
      <div class="panel-bd">
        ${c.footer_preview
          ? html`<div class="mail"><div class="mail-bd" style="max-height:none">${c.footer_preview}</div></div>`
          : html`<p class="tip" style="margin:0">Fill in the required details to see it.</p>`}
      </div>
    </div>

    <div class="panel">
      <div class="panel-hd"><h3>Connections</h3></div>
      <div class="scroll-x"><table class="rows">
        <tbody>
          <tr>
            <td class="c-name"><span class="name" style="font-size:.9rem">Google Places</span>
                <span class="meta">Finds businesses with no website</span></td>
            <td class="nw">${data.integrations.places_api_key_configured
              ? html`<span class="flag" data-ok>connected</span>`
              : html`<span class="flag">not set up</span>`}</td>
            <td class="meta">${data.integrations.places_api_key_configured
              ? 'Key found.'
              : html`Set <code class="mono">GOOGLE_MAPS_API_KEY</code> — see <code class="mono">docs/PHASE2-PLACES.md</code>`}</td>
          </tr>
          <tr>
            <td class="c-name"><span class="name" style="font-size:.9rem">Gmail</span>
                <span class="meta">Sends reviewed emails</span></td>
            <td class="nw">${data.integrations.gmail_connected
              ? html`<span class="flag" data-ok>connected</span>`
              : data.integrations.gmail_client_configured
                ? html`<span class="flag">not authorised</span>`
                : html`<span class="flag">not set up</span>`}</td>
            <td class="meta">${data.integrations.gmail_connected
              ? html`<span class="mono">${data.integrations.gmail_email}</span> · <a href="#/outbox">Outbox</a>`
              : data.integrations.gmail_client_configured
                ? html`<a href="#/outbox">Connect</a>`
                : html`Set <code class="mono">GMAIL_CLIENT_ID</code> and <code class="mono">GMAIL_CLIENT_SECRET</code>`}</td>
          </tr>
        </tbody>
      </table></div>
    </div>
  `);

  $('#settings', root).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api.settings.save(Object.fromEntries(new FormData(ev.target)));
      toast('Saved');
      refresh();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

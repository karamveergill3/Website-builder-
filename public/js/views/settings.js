/* Settings: the business identity that legally must appear in every email,
   plus sending guard-rails and integration status. */
import { api } from '../api.js';
import { html, mount, $, toast } from '../dom.js';

const IDENTITY = [
  { key: 'biz_contact_name',  label: 'Your name',            required: true,  hint: 'The real person sending the email.' },
  { key: 'biz_name',          label: 'Trading name',         required: true,  hint: 'Your business or trading name.' },
  { key: 'biz_address',       label: 'Postal address',       required: true,  hint: 'A real geographic address. A PO box alone is not enough.', textarea: true },
  { key: 'biz_email',         label: 'Contact email',        required: true,  type: 'email', hint: 'Where replies and opt-outs reach you.' },
  { key: 'biz_phone',         label: 'Phone',                type: 'tel' },
  { key: 'biz_website',       label: 'Your website' },
  { key: 'biz_company_number',label: 'Company number',       hint: 'Required in business emails if you trade as a limited company.' },
  { key: 'biz_vat_number',    label: 'VAT number',           hint: 'Include if VAT registered.' },
];

export default async function settingsView(root, _p, { refresh }) {
  const data = await api.settings.get();
  const s = data.settings;
  const c = data.compliance;

  mount(root, html`
    <div class="view-head">
      <div>
        <h2>Settings</h2>
        <p class="lede">
          These details are appended to every email this tool produces. UK law requires a marketing
          email to identify who sent it and to offer a way to opt out — so sending is blocked until
          the required fields are filled in.
        </p>
      </div>
    </div>

    ${c.complete ? html`
      <div class="note note-info" style="margin-bottom:16px">
        <div><strong>Identity complete.</strong> Every email will carry your details and an opt-out line.</div>
      </div>` : html`
      <div class="note note-danger" style="margin-bottom:16px">
        <div><strong>Sending is blocked.</strong> Still needed:
          <ul>${c.missing.map((m) => html`<li>${m.label}</li>`)}</ul>
        </div>
      </div>`}

    <form id="settings-form">
      <div class="card">
        <div class="card-head"><h3>Your business details</h3></div>
        <div class="card-body">
          <div class="grid2">
            ${IDENTITY.map((f) => html`
              <div class="field" ${f.textarea ? 'style="grid-column:1/-1"' : ''}>
                <label for="s-${f.key}">
                  ${f.label} ${f.required ? html`<span class="opt">(required)</span>` : html`<span class="opt">(optional)</span>`}
                </label>
                ${f.textarea
                  ? html`<textarea id="s-${f.key}" name="${f.key}" rows="3">${s[f.key] ?? ''}</textarea>`
                  : html`<input id="s-${f.key}" name="${f.key}" type="${f.type ?? 'text'}"
                                value="${s[f.key] ?? ''}" autocomplete="off">`}
                ${f.hint ? html`<p class="hint">${f.hint}</p>` : ''}
              </div>`)}
          </div>

          <div class="field" style="margin-top:6px">
            <label for="s-optout_line">Opt-out line</label>
            <input id="s-optout_line" name="optout_line" type="text" value="${s.optout_line ?? ''}">
            <p class="hint">
              One line, in every email. When someone takes you up on it, mark that lead
              <strong>opted out</strong> — they are then hard-excluded from all future sends.
            </p>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Sending guard-rails</h3></div>
        <div class="card-body">
          <div class="grid2">
            <div class="field">
              <label for="s-daily_cap">Daily send cap</label>
              <input id="s-daily_cap" name="daily_cap" type="number" min="1" max="500" value="${s.daily_cap}">
              <p class="hint">
                A hard stop this tool enforces. Gmail applies its own, much larger, daily limit
                on top — but hitting that is not the risk. Sending a lot of unsolicited mail from
                a personal account is what gets it rate-limited or suspended, so keep this low.
              </p>
            </div>
            <div class="field">
              <label for="s-send_delay_min_seconds">Gap between sends — from (seconds)</label>
              <input id="s-send_delay_min_seconds" name="send_delay_min_seconds"
                     type="number" min="0" max="3600" value="${s.send_delay_min_seconds}">
            </div>
            <div class="field">
              <label for="s-send_delay_max_seconds">…to (seconds)</label>
              <input id="s-send_delay_max_seconds" name="send_delay_max_seconds"
                     type="number" min="0" max="3600" value="${s.send_delay_max_seconds}">
              <p class="hint">
                Each gap is picked at random between these two. A fixed interval is the clearest
                signal that a program rather than a person is sending, so don't set them equal.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Places pricing</h3></div>
        <div class="card-body">
          <div class="note ${s.places_pricing_verified_on ? 'note-info' : 'note-warn'}"
               style="margin-bottom:16px">
            <div>
              ${s.places_pricing_verified_on
                ? html`You confirmed these against Google on <strong>${s.places_pricing_verified_on}</strong>.`
                : html`<strong>These figures have not been checked.</strong> They are a plausible
                       starting point, not a quote — the cost estimate on Find leads will say so
                       until you confirm them.`}
              Google reprices Maps Platform from time to time, so read the current numbers on
              <a href="https://developers.google.com/maps/documentation/places/web-service/usage-and-billing"
                 target="_blank" rel="noopener">Google's usage and billing page</a>,
              enter them here, and put today's date in the last box.
            </div>
          </div>
          <div class="grid3">
            <div class="field">
              <label for="s-places_text_search_per_1000">Text Search, USD per 1,000</label>
              <input id="s-places_text_search_per_1000" name="places_text_search_per_1000"
                     type="text" value="${s.places_text_search_per_1000 ?? '35'}">
              <p class="hint">The tier that includes websiteUri.</p>
            </div>
            <div class="field">
              <label for="s-places_details_per_1000">Place Details, USD per 1,000</label>
              <input id="s-places_details_per_1000" name="places_details_per_1000"
                     type="text" value="${s.places_details_per_1000 ?? '20'}">
              <p class="hint">Only used by the optional verification pass.</p>
            </div>
            <div class="field">
              <label for="s-places_free_calls_per_month">Free calls per SKU per month</label>
              <input id="s-places_free_calls_per_month" name="places_free_calls_per_month"
                     type="text" value="${s.places_free_calls_per_month ?? '5000'}">
            </div>
            <div class="field">
              <label for="s-places_pricing_verified_on">I checked these on</label>
              <input id="s-places_pricing_verified_on" name="places_pricing_verified_on"
                     type="text" placeholder="2026-09-06"
                     value="${s.places_pricing_verified_on ?? ''}">
              <p class="hint">Leave blank until you actually have.</p>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Lead search defaults</h3></div>
        <div class="card-body">
          <div class="field">
            <label for="s-default_areas">Default areas to sweep</label>
            <textarea id="s-default_areas" name="default_areas" rows="3"
                      placeholder="Leeds&#10;Bradford&#10;Harrogate">${s.default_areas ?? ''}</textarea>
            <p class="hint">One town or city per line. Pre-fills the Find leads screen.</p>
          </div>
          <div class="field" style="max-width:220px">
            <label for="s-default_region_code">Region code</label>
            <input id="s-default_region_code" name="default_region_code" type="text"
                   value="${s.default_region_code ?? 'GB'}">
            <p class="hint">Biases results to the UK. Leave as GB.</p>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:10px;align-items:center;margin-top:18px">
        <button type="submit" class="primary">Save settings</button>
        <span class="hint" id="save-state"></span>
      </div>
    </form>

    <div class="card" style="margin-top:22px">
      <div class="card-head"><h3>Footer preview</h3></div>
      <div class="card-body">
        ${c.footer_preview
          ? html`<div class="preview"><div class="preview-body" style="max-height:none">${c.footer_preview}</div></div>`
          : html`<p class="hint">Fill in the required fields above to see the footer that will be appended.</p>`}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Integrations</h3></div>
      <div class="card-body">
        <table class="ledger">
          <tbody>
            <tr>
              <td><strong>Google Places API</strong><br>
                  <span class="sub">Finds UK businesses with no website.</span></td>
              <td class="nowrap">${data.integrations.places_api_key_configured
                ? html`<span class="status" data-s="won">connected</span>`
                : html`<span class="status" data-s="new">not set up</span>`}</td>
              <td class="sub">${data.integrations.places_api_key_configured
                ? 'API key found in the environment.'
                : html`Set <code class="mono">GOOGLE_MAPS_API_KEY</code> in <code class="mono">.env</code> — see the README.`}</td>
            </tr>
            <tr>
              <td><strong>Gmail</strong><br>
                  <span class="sub">Sends reviewed emails from your own account.</span></td>
              <td class="nowrap">${data.integrations.gmail_connected
                ? html`<span class="status" data-s="won">connected</span>`
                : data.integrations.gmail_client_configured
                  ? html`<span class="status" data-s="sent">not authorised</span>`
                  : html`<span class="status" data-s="new">not set up</span>`}</td>
              <td class="sub">${data.integrations.gmail_connected
                ? html`Sending as <span class="mono">${data.integrations.gmail_email ?? 'your account'}</span>.
                       <a href="#/outbox">Go to Outbox</a>`
                : data.integrations.gmail_client_configured
                  ? html`<a href="#/outbox">Connect your Gmail account</a>`
                  : html`Set <code class="mono">GMAIL_CLIENT_ID</code> and <code class="mono">GMAIL_CLIENT_SECRET</code> — see the README.`}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `);

  $('#settings-form', root).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    try {
      await api.settings.save(body);
      toast('Settings saved');
      refresh();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

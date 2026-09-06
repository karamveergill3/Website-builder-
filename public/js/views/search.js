/* Find leads — Google Places search. Filled in by Phase 2. */
import { html, mount } from '../dom.js';

export default async function searchView(root) {
  mount(root, html`
    <div class="view-head"><div>
      <h2>Find leads</h2>
      <p class="lede">Search Google Places for UK businesses with no website.</p>
    </div></div>
    <div class="card"><div class="empty">
      <h3>Not built yet</h3>
      <p>Phase 2 adds the Google Places search. The tracker works fully without it.</p>
    </div></div>`);
}

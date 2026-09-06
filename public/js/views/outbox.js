/* Outbox — review-then-send via Gmail. Filled in by Phase 3. */
import { html, mount } from '../dom.js';

export default async function outboxView(root) {
  mount(root, html`
    <div class="view-head"><div>
      <h2>Outbox</h2>
      <p class="lede">Review each queued email, then confirm to send through Gmail.</p>
    </div></div>
    <div class="card"><div class="empty">
      <h3>Not built yet</h3>
      <p>Phase 3 adds Gmail sending. For now, Compose gives you copy and mail-app drafts.</p>
    </div></div>`);
}

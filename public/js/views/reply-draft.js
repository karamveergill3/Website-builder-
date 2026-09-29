/* The answer to a prospect's reply, drafted and ready to send.
 *
 * Shown straight after a reply is pasted in (Sent via WhatsApp, Replies), and
 * from any reply card. The text is editable; Copy puts it on the clipboard,
 * and Open in WhatsApp opens their chat in the WhatsApp app (WhatsApp Desktop
 * on a computer) with it already typed, so sending is one tap. Anything the reply calls for (they said stop, they have a site,
 * build their mock up) is a button here too.
 */
import { api } from '../api.js';
import { html, modal, toast } from '../dom.js';
import { inApp } from '../wa-link.js';

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* insecure context: fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

/** The chat in the WhatsApp app (WhatsApp Desktop on a computer), message typed in. */
export const waLink = (number, text) => inApp(number, text);

/** Fetch the draft for a reply again (optionally the "here's your mock up" one). */
/**
 * What a reply can be said to mean when it was read wrong (the same list as
 * KINDS in server/lib/reply-draft.js). Picking one writes that answer.
 */
export const KINDS = [
  ['no', 'Not interested'],
  ['elsewhere', 'Someone else is doing it'],
  ['has_site', 'Already have a site'],
  ['later', 'Maybe later'],
  ['yes', 'Yes please'],
  ['price', 'Asked the price'],
  ['answers', 'Answered the questions'],
  ['other', 'Something else'],
];

/** "They said: [Not interested] [Maybe later] …", the one it was answered as pressed. */
export const kindPicker = (draft) => (draft?.intent && !['stop', 'mockup'].includes(draft.intent) ? html`
  <div class="kinds" role="group" aria-label="What they said">
    <span class="meta">${draft.picked ? 'You said they meant:' : 'Read as:'}</span>
    ${KINDS.map(([id, label]) => html`<button type="button" class="mini" data-kind="${id}"
      aria-pressed="${draft.intent === id ? 'true' : 'false'}">${label}</button>`)}
  </div>` : '');

export const fetchDraft = async (replyId, kind = null) =>
  (await api.get(`/api/replies/${replyId}/draft`, { origin: location.origin, kind: kind ?? undefined })).draft;

/**
 * Do what a draft's button says: opt them out, mark them as having a site,
 * build their mock up. Returns { changed, next }: whether the lead changed,
 * and a draft to show next (the mock up message), if any.
 */
export async function runDraftAction(act, draft) {
  if (act === 'optout') {
    await api.leads.update(draft.lead_id, { opted_out: true, status: 'lost' });
    toast('Marked not interested. Nobody will contact them again');
    return { changed: true, next: null };
  }
  if (act === 'has-site') {
    await api.post(`/api/leads/${draft.lead_id}/has-website`, {});
    toast('Marked as having a website');
    return { changed: true, next: null };
  }
  if (act === 'build') {
    toast('Building their mock up…');
    await api.post('/api/mockups', { reply_id: draft.reply_id });
    return { changed: true, next: await fetchDraft(draft.reply_id, 'mockup') };
  }
  if (act === 'mockup-msg') return { changed: false, next: await fetchDraft(draft.reply_id, 'mockup') };
  return { changed: false, next: null };
}

/**
 * Show a draft. Resolves when the dialog closes; `changed` is true if an
 * action altered the lead (so the screen behind should refresh).
 */
export async function showReplyDraft(draft) {
  let changed = false;
  let next = null;

  await modal({
    title: draft.business_name ? `Reply to ${draft.business_name}` : 'Your reply',
    wide: true,
    body: html`
      <p style="margin:0 0 8px"><span class="flag" data-ok>${draft.label}</span></p>
      ${draft.reply_id ? kindPicker(draft) : ''}
      ${draft.note ? html`
        <div class="msg msg-warn" style="margin-bottom:10px"><div class="grow">${draft.note}</div></div>` : ''}
      ${draft.text ? html`
        <div class="f">
          <label for="rd-text">Your reply <span class="opt">edit it however you like</span></label>
          <textarea id="rd-text" rows="${Math.min(18, Math.max(6, draft.text.split('\n').length + 1))}">${draft.text}</textarea>
        </div>` : ''}
      ${draft.actions?.length || (draft.has_mockup && draft.intent !== 'mockup') ? html`
        <div class="bar" style="margin-top:6px">
          ${(draft.actions ?? []).map((a) => html`
            <button type="button" class="mini" data-action="${a.id}">${a.label}</button>`)}
          ${draft.has_mockup && draft.intent !== 'mockup' ? html`
            <button type="button" class="mini" data-action="mockup-msg">Draft the mock up message</button>` : ''}
        </div>` : ''}`,
    footer: html`
      <button type="button" data-close>Close</button>
      <div class="grow"></div>
      ${draft.text ? html`
        <button type="button" data-act="copy">Copy</button>
        ${draft.wa_number ? html`
          <a class="btn primary" data-act="wa"
             href="${waLink(draft.wa_number, draft.text)}">Open in WhatsApp</a>` : ''}` : ''}`,
    onMount: (dlg, close) => {
      const box = dlg.querySelector('#rd-text');
      const wa = dlg.querySelector('[data-act="wa"]');
      box?.addEventListener('input', () => {
        if (wa) wa.href = waLink(draft.wa_number, box.value);
      });
      dlg.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
        const ok = await copy(box?.value ?? draft.text);
        toast(ok ? 'Copied. Paste it into WhatsApp' : 'Could not copy: select the text instead', { error: !ok });
      });

      // Read wrong: say what they meant, and the answer is written again for it.
      for (const btn of dlg.querySelectorAll('[data-kind]')) {
        btn.addEventListener('click', async () => {
          if (btn.getAttribute('aria-pressed') === 'true') return;
          try {
            next = await fetchDraft(draft.reply_id, btn.dataset.kind);
            close(true);
          } catch (err) {
            toast(err.message ?? 'That did not work', { error: true });
          }
        });
      }

      for (const btn of dlg.querySelectorAll('[data-action]')) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const out = await runDraftAction(btn.dataset.action, draft);
            changed = changed || out.changed;
            if (out.next) { next = out.next; close(true); }
          } catch (err) {
            toast(err.message ?? 'That did not work', { error: true });
            btn.disabled = false;
          }
        });
      }
    },
  });

  // Built a mock up or asked for its message: show that draft next.
  if (next) changed = (await showReplyDraft(next)) || changed;
  return changed;
}

/* A follow-up on WhatsApp, with their mock up already built.
 *
 * Someone who hasn't answered comes due a follow-up a few days after the last
 * message (lib/follow-ups.js). This writes it (the first shows them a mock up
 * of their own site, a later one checks they saw it), opens their chat in
 * WhatsApp Desktop with it typed in, and records it once WhatsApp opens, the
 * same way the Reach dialog records a first message. The site never sends
 * anything itself.
 */
import { api } from '../api.js';
import { html, modal, mount, toast } from '../dom.js';
import { copy } from './reply-draft.js';
import { inApp, onWeb } from '../wa-link.js';

/** "Thursday 2 October", for when the next one is due. */
export const dueDay = (iso) => new Date(iso).toLocaleDateString('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long',
});

/**
 * Write the follow-up for lead `id` and show it. Resolves true when one was
 * recorded as sent (so the screen behind should refresh).
 */
export async function openFollowUp(id, name) {
  let draft;
  let prep;
  try {
    draft = await api.leads.followUp(id, location.origin);
    // Made ready now, so the link below is a real one to click; nothing is
    // on record as sent until WhatsApp opens (or "I sent it").
    prep = await api.outreach.prepare({
      lead_id: Number(id), channel: 'whatsapp', text: draft.text,
      follow_up: true, mockup_id: draft.mockup.id,
    });
  } catch (err) {
    toast(err.message ?? 'Could not write the follow-up', { error: true, ms: 7000 });
    return false;
  }

  const f = draft.follow_up;
  const number = String(prep.e164 ?? '').replace(/\D/g, '');
  let sent = false;

  await modal({
    title: `Follow up with ${name ?? draft.mockup?.business_name ?? 'them'}`,
    wide: true,
    body: html`
      <p style="margin:0 0 8px">
        <span class="flag" data-ok>Follow-up ${f.step} of ${f.sent + f.left}</span>
        <span class="meta">${f.step === 1
          ? 'Shows them the mock up of their site.' : 'Checks they saw the mock up.'}</span>
      </p>
      <p style="margin:0 0 10px">
        Their mock up: <a href="${draft.mockup.url}" target="_blank" rel="noopener">look at it first ↗</a>
        <span class="meta">${draft.mockup.built ? 'built just now, from their name, trade and town'
          : 'the same link every follow-up carries'}</span>
      </p>
      <div class="f">
        <label for="fu-text">The message <span class="opt">edit it however you like</span></label>
        <textarea id="fu-text" rows="${Math.min(14, Math.max(7, draft.text.split('\n').length + 1))}">${draft.text}</textarea>
      </div>
      <div data-help></div>`,
    footer: html`
      <button type="button" data-close>Not now</button>
      <div class="grow"></div>
      <button type="button" data-act="copy">Copy</button>
      <button type="button" data-act="mark-sent" title="You sent it another way: record it">I sent it</button>
      <a class="btn primary" data-act="open" href="${inApp(number, draft.text)}"
         title="Opens their chat in WhatsApp Desktop with this typed in">Open in WhatsApp</a>`,
    onMount: (dlg, close) => {
      const box = dlg.querySelector('#fu-text');
      const open = dlg.querySelector('[data-act="open"]');
      const help = dlg.querySelector('[data-help]');
      box.addEventListener('input', () => { open.href = inApp(number, box.value); });

      let recording = false;
      const record = async () => {
        if (recording || sent) return;
        recording = true;
        try {
          await api.outreach.sent(prep.event_id, box.value);
          sent = true;
          toast(f.left > 1
            ? `Follow-up recorded. The next is due in ${draft.days ?? 3} days if they don't answer`
            : 'Follow-up recorded. That was the last one: they’re left alone now');
          close(true);
        } catch (err) {
          toast(err.message ?? 'Could not record it', { error: true });
        } finally {
          recording = false;
        }
      };

      // Recorded when WhatsApp really opens and takes the focus; a link that
      // opened nothing records nothing, and says what to do instead.
      let stop = null;
      open.addEventListener('click', () => {
        stop?.();
        const opened = () => { stop?.(); record(); };
        const hidden = () => { if (document.visibilityState === 'hidden') opened(); };
        const late = setTimeout(() => {
          if (sent || !dlg.isConnected) return;
          mount(help, html`
            <div class="msg msg-warn" style="margin-top:10px"><div class="grow">
              WhatsApp didn’t open? Use <a href="${onWeb(number, box.value)}" target="_blank" rel="noopener"
              data-act="web">WhatsApp Web</a> instead, or send it from your phone and press <b>I sent it</b>.
            </div></div>`);
        }, 3500);
        const quit = setTimeout(() => stop?.(), 2 * 60 * 1000);
        stop = () => {
          window.removeEventListener('blur', opened);
          document.removeEventListener('visibilitychange', hidden);
          clearTimeout(late);
          clearTimeout(quit);
          stop = null;
        };
        window.addEventListener('blur', opened);
        document.addEventListener('visibilitychange', hidden);
      });
      // WhatsApp Web opens in a tab, so opening it is the send.
      help.addEventListener('click', (ev) => {
        if (ev.target.closest?.('[data-act="web"]')) { stop?.(); record(); }
      });
      dlg.querySelector('[data-act="mark-sent"]').addEventListener('click', () => { stop?.(); record(); });
      dlg.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        const ok = await copy(box.value);
        toast(ok ? 'Copied. Paste it into their WhatsApp chat, then press I sent it'
          : 'Could not copy: select the text instead', { error: !ok });
      });
    },
  });
  return sent;
}

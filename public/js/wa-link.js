/* Links that open a chat in the WhatsApp app itself.
 *
 * A wa.me link goes through a web page ("Continue to chat") before it reaches
 * the app. whatsapp://send is the link WhatsApp Desktop registers with
 * Windows (and the phone apps with the phone): it goes straight to that
 * number's chat in the app that is already open, with the message typed in
 * when there is one. The first time, the browser asks "Open WhatsApp?";
 * ticking "Always allow" makes it one click from then on.
 */

/** The chat with `number` (digits, country code first) in the WhatsApp app. */
export function inApp(number, text = '') {
  const digits = String(number ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return `whatsapp://send?phone=${digits}${text ? `&text=${encodeURIComponent(text)}` : ''}`;
}

/** The same chat on WhatsApp Web, for a computer without the app. */
export function onWeb(number, text = '') {
  const digits = String(number ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return `https://web.whatsapp.com/send?phone=${digits}${text ? `&text=${encodeURIComponent(text)}` : ''}`;
}

/** A wa.me link (as the server hands them out) turned into its app link. */
export function appFromWaMe(url) {
  const m = /^https:\/\/wa\.me\/(\d+)(?:\?text=(.*))?$/.exec(String(url ?? ''));
  return m ? `whatsapp://send?phone=${m[1]}${m[2] ? `&text=${m[2]}` : ''}` : url;
}

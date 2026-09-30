/**
 * A passcode on the front door.
 *
 * The hub is reachable from the whole internet, and until now the first thing a
 * stranger who guessed the address saw was the sign-in screen: a form telling
 * them a real system is here and inviting them to try. This puts a short code
 * in front of everything, so an unknown visitor sees nothing to attack.
 *
 * It is a DOOR CODE, not authentication, and it is not treated as if it were:
 * one shared secret, no identity, no audit trail. The accounts behind it are
 * still what actually protects the data (scrypt-hashed passwords, per-user
 * sessions — see auth.js). This only decides who gets to see the door.
 *
 * Two things follow from that:
 *
 *   - Six digits is a million guesses, which is perfectly walkable at a few
 *     requests a second. Rate limiting is therefore not optional here, it is
 *     the only thing standing between the code and a script. See ATTEMPTS.
 *
 *   - Anything a CLIENT is meant to open must never meet it. Invoices, Direct
 *     Debit returns and mockup previews are sent to prospects who have no code
 *     and no reason to be given one, so they are exempt below. Getting this
 *     wrong would not look like a security bug, it would look like the invoice
 *     link being broken.
 *
 * Unset SITE_PASSCODE and the whole thing is a no-op, which is what a local
 * install on a laptop wants.
 */
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export const GATE_COOKIE = 'keylo_gate';
const GATE_DAYS = 30;

/** Attempts allowed per address, and how long the window lasts. */
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Paths a client with no passcode has to be able to reach.
 *
 * `/i/` is an invoice and its payment returns, `/dd/` a Direct Debit return,
 * `/m/` a mockup preview. `/api/gmail/callback` is where Google sends the
 * browser back after OAuth, which happens in a window we do not control.
 */
const PUBLIC_PREFIXES = ['/i/', '/dd/', '/m/', '/api/gmail/callback', '/api/health'];

export const passcode = () => process.env.SITE_PASSCODE?.trim() || null;
export const enabled = () => Boolean(passcode());

const isPublicPath = (path) => PUBLIC_PREFIXES.some(
  (p) => path === p.replace(/\/$/, '') || path.startsWith(p)
);

/* ------------------------------------------------------------------ cookie */

/**
 * The cookie is derived from the passcode itself, so changing the code turns
 * every issued cookie into a forgery on the next request — no list to clear.
 */
const key = () => createHash('sha256').update(`keylo-gate:${passcode()}`).digest();

const sign = (value) => createHmac('sha256', key()).update(String(value)).digest('hex');

export function issueToken(now = Date.now()) {
  const expires = now + GATE_DAYS * 86_400_000;
  return `${expires}.${sign(expires)}`;
}

/** Constant-time compare of two hex strings of the same length. */
function sameHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function tokenValid(token, now = Date.now()) {
  const [expires, mac] = String(token ?? '').split('.');
  if (!expires || !mac) return false;
  if (!/^\d+$/.test(expires) || Number(expires) <= now) return false;
  return sameHex(mac, sign(expires));
}

/** Constant-time compare of the submitted code against the configured one. */
export function codeValid(submitted) {
  const given = String(submitted ?? '').trim();
  const real = passcode() ?? '';
  // Hash both first: timingSafeEqual throws on a length mismatch, and the
  // lengths themselves would otherwise leak how long the code is.
  return sameHex(
    createHash('sha256').update(given).digest('hex'),
    createHash('sha256').update(real).digest('hex'),
  );
}

/* ------------------------------------------------------------ rate limiting */

const ATTEMPTS = new Map();

/**
 * The address to count against. The app listens on loopback behind Caddy, so
 * the socket address is always 127.0.0.1 and X-Forwarded-For is the only real
 * signal. Caddy APPENDS the client to any header the client sent, so the last
 * entry is the one Caddy observed and the earlier ones are whatever the client
 * made up. Taking the last entry is therefore the only safe read.
 */
export function clientAddress(req) {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket?.remoteAddress ?? 'unknown');
}

export function attemptState(address, now = Date.now()) {
  const row = ATTEMPTS.get(address);
  if (!row || row.resetAt <= now) return { failures: 0, lockedFor: 0 };
  return {
    failures: row.failures,
    lockedFor: row.failures >= MAX_ATTEMPTS ? row.resetAt - now : 0,
  };
}

function recordFailure(address, now = Date.now()) {
  const row = ATTEMPTS.get(address);
  if (!row || row.resetAt <= now) ATTEMPTS.set(address, { failures: 1, resetAt: now + WINDOW_MS });
  else row.failures += 1;

  // The map is keyed on an attacker-supplied-ish value, so it cannot be
  // allowed to grow without bound. Sweep the expired rows as we go.
  if (ATTEMPTS.size > 500) {
    for (const [k, v] of ATTEMPTS) if (v.resetAt <= now) ATTEMPTS.delete(k);
  }
}

const clearFailures = (address) => ATTEMPTS.delete(address);

/** Test seam: forget every recorded attempt. */
export const resetAttempts = () => ATTEMPTS.clear();

/* -------------------------------------------------------------- the screen */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Only a local path may be echoed back into the form, or the gate becomes an
 * open redirect: a `next` pointing at somebody else's site would send the
 * person straight off our domain the moment they typed the right code, from a
 * link that looked like ours. A leading `//` is protocol-relative and counts
 * as off-site too.
 */
export function safeNext(value) {
  const v = String(value ?? '');
  return /^\/(?!\/)/.test(v) ? v : '/';
}

export function gatePage({ next = '/', error = null, nonce = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Keylo Studios</title><style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
 font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b1b33;color:#12233f}
.card{background:#fff;max-width:380px;width:100%;border-radius:16px;padding:40px 32px;
 box-shadow:0 24px 60px rgba(0,0,0,.35);text-align:center}
.mark{font-size:26px;font-weight:800;color:#0b1b33;letter-spacing:.02em}
.mark span{color:#c8a24b}
h1{font-size:17px;font-weight:600;margin:22px 0 4px}
p.sub{margin:0 0 24px;color:#4a5a72;font-size:14px}
input{width:100%;padding:14px;font-size:26px;text-align:center;letter-spacing:.42em;
 font-variant-numeric:tabular-nums;border:1.5px solid #c9d3e2;border-radius:10px;background:#f7f9fc;color:#12233f}
input:focus{outline:none;border-color:#c8a24b;background:#fff}
button{width:100%;margin-top:14px;padding:13px;font-size:15px;font-weight:600;border:0;border-radius:10px;
 background:#0b1b33;color:#fff;cursor:pointer}
button:hover{background:#12233f}
.err{margin:16px 0 0;padding:10px 12px;border-radius:8px;background:#fdecec;color:#98211f;font-size:14px}
</style></head><body>
<div class="card">
  <div class="mark"><span>&lt;</span> KEYLO STUDIOS</div>
  <h1>Enter your passcode</h1>
  <p class="sub">This hub is private.</p>
  <form method="POST" action="/gate">
    <input type="hidden" name="next" value="${esc(next)}">
    <input id="code" name="code" type="password" inputmode="numeric" pattern="[0-9]*"
           maxlength="6" autocomplete="off" autofocus aria-label="Passcode">
    <button type="submit">Continue</button>
  </form>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
</div>
<script nonce="${esc(nonce)}">
var f=document.getElementById('code');
f.addEventListener('input',function(){if(f.value.length===6)f.form.submit();});
</script>
</body></html>`;
}

function gateHeaders(res, nonce) {
  res.setHeader('Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; `
    + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');
}

const serveGate = (res, opts = {}) => {
  const nonce = randomBytes(16).toString('base64');
  gateHeaders(res, nonce);
  res.status(opts.status ?? 401).type('html').send(gatePage({ ...opts, nonce }));
};

export function gateCookie(token, { secure } = {}) {
  const bits = [
    `${GATE_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Expires=${new Date(Date.now() + GATE_DAYS * 86_400_000).toUTCString()}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/* ----------------------------------------------------------- the middleware */

/**
 * Mount before everything else. `readCookie` and `isSecure` are passed in
 * rather than imported so this module stays free of the auth module, which it
 * has nothing to do with.
 */
export function siteGate({ readCookie, isSecure }) {
  return function gate(req, res, next) {
    if (!enabled()) return next();
    if (isPublicPath(req.path)) return next();

    const held = readCookie(req.headers.cookie, GATE_COOKIE);
    const address = clientAddress(req);

    if (req.method === 'POST' && req.path === '/gate') {
      const { lockedFor } = attemptState(address);
      if (lockedFor > 0) {
        return serveGate(res, {
          status: 429,
          next: safeNext(req.body?.next),
          error: `Too many attempts. Try again in ${Math.ceil(lockedFor / 60000)} minute(s).`,
        });
      }
      if (!codeValid(req.body?.code)) {
        recordFailure(address);
        const left = MAX_ATTEMPTS - attemptState(address).failures;
        return serveGate(res, {
          next: safeNext(req.body?.next),
          error: left > 0 ? `Not right. ${left} attempt(s) left.` : 'Not right.',
        });
      }
      clearFailures(address);
      res.setHeader('Set-Cookie', gateCookie(issueToken(), { secure: isSecure(req) }));
      return res.redirect(303, safeNext(req.body?.next));
    }

    if (tokenValid(held)) return next();

    // An API call from an already-open tab must not be answered with a login
    // page: the frontend would try to parse HTML as JSON and show a parse error
    // instead of telling the person their session at the door ran out.
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Passcode required.', code: 'GATE_LOCKED' });
    }

    return serveGate(res, { next: safeNext(req.originalUrl) });
  };
}

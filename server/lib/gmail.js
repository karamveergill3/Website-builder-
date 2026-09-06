/**
 * Gmail OAuth2 + send, over plain fetch.
 *
 * This connects to the user's own Gmail account. There is no service account
 * and no domain-wide delegation: one person, one mailbox, one refresh token
 * stored locally in the SQLite file.
 *
 * Scopes are kept as tight as the job allows:
 *   gmail.send  — send a message, and nothing else. It cannot read the
 *                 mailbox, list messages, or touch drafts.
 *   openid,email — so the UI can show which account is connected. Without it
 *                 there is no way to confirm you authorised the right Gmail,
 *                 and gmail.send alone cannot read a profile.
 */
import { getSetting, setSetting, db } from '../db.js';

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
];

export class GmailError extends Error {
  constructor(message, { status = 502, code, retryable = false } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export const clientConfigured = () =>
  Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);

function creds() {
  if (!clientConfigured()) {
    throw new GmailError(
      'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are not set. See docs/PHASE3-GMAIL.md.',
      { status: 503, code: 'NOT_CONFIGURED' }
    );
  }
  return {
    client_id: process.env.GMAIL_CLIENT_ID.trim(),
    client_secret: process.env.GMAIL_CLIENT_SECRET.trim(),
  };
}

export const redirectUri = (req) => {
  const configured = process.env.GMAIL_REDIRECT_URI?.trim();
  if (configured) return configured;
  const host = req?.get?.('host') ?? `localhost:${process.env.PORT ?? 3000}`;
  return `http://${host}/api/gmail/callback`;
};

/* ------------------------------------------------------------ token store */

export const isConnected = () => Boolean(getSetting('gmail_refresh_token'));
export const connectedEmail = () => getSetting('gmail_email');

export function disconnect() {
  for (const k of ['gmail_refresh_token', 'gmail_access_token', 'gmail_token_expiry', 'gmail_email']) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(k);
  }
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const desc = body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
    if (body?.error === 'invalid_grant') {
      throw new GmailError(
        `Google rejected the stored refresh token (${desc}). This usually means access was ` +
        'revoked, the password changed, or the OAuth consent screen is still in "Testing" ' +
        'and the token expired. Reconnect your Gmail account.',
        { status: 401, code: 'REAUTH_NEEDED' }
      );
    }
    throw new GmailError(`Google OAuth error: ${desc}`, { status: 502, code: body?.error });
  }
  return body;
}

/* ------------------------------------------------------------- auth flow */

export function authUrl(redirect, state) {
  const p = new URLSearchParams({
    client_id: creds().client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',      // we need a refresh token
    prompt: 'consent',           // force one, even on re-authorisation
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export async function exchangeCode(code, redirect) {
  const { client_id, client_secret } = creds();
  const tok = await postForm(TOKEN_URL, {
    code, client_id, client_secret, redirect_uri: redirect,
    grant_type: 'authorization_code',
  });

  if (!tok.refresh_token) {
    throw new GmailError(
      'Google did not return a refresh token. Remove this app from your Google account ' +
      'permissions and connect again so the consent screen is shown afresh.',
      { status: 502, code: 'NO_REFRESH_TOKEN' }
    );
  }

  setSetting('gmail_refresh_token', tok.refresh_token);
  setSetting('gmail_access_token', tok.access_token);
  setSetting('gmail_token_expiry', String(Date.now() + (tok.expires_in ?? 3600) * 1000));

  const email = await fetchEmail(tok.access_token);
  if (email) setSetting('gmail_email', email);
  return { email };
}

async function fetchEmail(accessToken) {
  try {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    return (await res.json()).email ?? null;
  } catch {
    return null;
  }
}

/** A valid access token, refreshed if the stored one is near expiry. */
export async function accessToken() {
  const refresh = getSetting('gmail_refresh_token');
  if (!refresh) {
    throw new GmailError('Gmail is not connected yet.', { status: 401, code: 'NOT_CONNECTED' });
  }

  const cached = getSetting('gmail_access_token');
  const expiry = Number(getSetting('gmail_token_expiry', '0'));
  // 60s of slack so a token cannot expire mid-request.
  if (cached && expiry > Date.now() + 60_000) return cached;

  const { client_id, client_secret } = creds();
  const tok = await postForm(TOKEN_URL, {
    client_id, client_secret, refresh_token: refresh, grant_type: 'refresh_token',
  });
  setSetting('gmail_access_token', tok.access_token);
  setSetting('gmail_token_expiry', String(Date.now() + (tok.expires_in ?? 3600) * 1000));
  return tok.access_token;
}

export async function revoke() {
  const token = getSetting('gmail_refresh_token');
  if (token) {
    try { await postForm(REVOKE_URL, { token }); } catch { /* revoke best-effort */ }
  }
  disconnect();
}

/* --------------------------------------------------------- message build */

const base64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 2047 encode a header value only when it needs it. */
function encodeHeader(value) {
  const v = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(v)
    ? v
    : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** Strip CR/LF so a crafted value cannot inject extra headers. */
const headerSafe = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * Build an RFC 5322 message, base64url encoded for the Gmail API.
 * `listUnsubscribe` should be a bare email address; it becomes a
 * List-Unsubscribe mailto, which is what mail clients surface as an
 * unsubscribe link.
 */
export function buildRawMessage({ to, from, fromName, subject, body, listUnsubscribe, replyTo }) {
  const headers = [
    `To: ${headerSafe(to)}`,
    ...(from ? [`From: ${fromName ? `${encodeHeader(headerSafe(fromName))} <${headerSafe(from)}>` : headerSafe(from)}`] : []),
    ...(replyTo ? [`Reply-To: ${headerSafe(replyTo)}`] : []),
    `Subject: ${encodeHeader(headerSafe(subject))}`,
    ...(listUnsubscribe
      ? [`List-Unsubscribe: <mailto:${headerSafe(listUnsubscribe)}?subject=unsubscribe>`]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const encodedBody = Buffer.from(String(body ?? ''), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

  return base64url(`${headers.join('\r\n')}\r\n\r\n${encodedBody}`);
}

/* ------------------------------------------------------------------ send */

/** Send one message. Returns the Gmail message id, which is the proof of send. */
export async function sendRaw(raw) {
  const token = await accessToken();
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });

  const body = await res.json().catch(() => null);
  if (res.ok) return { id: body?.id ?? null, threadId: body?.threadId ?? null };

  const message = body?.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 429 || /rateLimitExceeded|userRateLimitExceeded/i.test(message)) {
    throw new GmailError(`Gmail rate limit hit: ${message}`, {
      status: 429, code: 'RATE_LIMITED', retryable: true,
    });
  }
  if (res.status === 403 && /Daily Limit|quota/i.test(message)) {
    throw new GmailError(
      `Gmail daily sending limit reached: ${message}. Wait 24 hours before sending more.`,
      { status: 429, code: 'DAILY_LIMIT' }
    );
  }
  if (res.status === 401) {
    throw new GmailError('Gmail rejected the access token — reconnect your account.', {
      status: 401, code: 'REAUTH_NEEDED',
    });
  }
  throw new GmailError(`Gmail refused the message: ${message}`, { status: 502 });
}

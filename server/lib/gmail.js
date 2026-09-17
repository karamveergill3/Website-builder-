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
 *   gmail.readonly — OPTIONAL and off by default. Only requested when the
 *                 user turns reply-reading on, because it grants sight of
 *                 the whole mailbox and that is not a default worth taking.
 *                 See READ_SCOPE below.
 */
import { getSetting, setSetting, db } from '../db.js';

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * `gmail.readonly` is a RESTRICTED scope. For a single-user personal tool
 * you stay in OAuth "testing" mode with your own address as the only test
 * user — no verification, no cost, no review. It is only publishing the app
 * that pulls in Google's assessment process.
 *
 * It is a real widening of what this process can see: with it, the tool can
 * read your whole mailbox, not just send. Everything here reads narrowly —
 * `listReplies` filters to messages from addresses already on a lead — but
 * the grant itself is broad, which is why it is opt-in through a setting
 * rather than requested by default.
 */
export const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export const readEnabled = () => getSetting('gmail_read_replies', '0') === '1';

export function scopes({ read = readEnabled() } = {}) {
  return [
    'https://www.googleapis.com/auth/gmail.send',
    ...(read ? [READ_SCOPE] : []),
    'openid',
    'email',
  ];
}

/** Kept for the existing call sites and tests. */
export const SCOPES = scopes({ read: false });

/** Did the account actually grant read access when it connected? */
export const hasReadScope = () =>
  (getSetting('gmail_granted_scopes', '') ?? '').includes(READ_SCOPE);

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
  for (const k of ['gmail_refresh_token', 'gmail_access_token', 'gmail_token_expiry',
                   'gmail_email', 'gmail_granted_scopes']) {
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

export function authUrl(redirect, state, { read = readEnabled() } = {}) {
  const p = new URLSearchParams({
    client_id: creds().client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: scopes({ read }).join(' '),
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

  // Record what Google ACTUALLY granted, not what we asked for. A user can
  // untick a scope on the consent screen, and reply-reading has to check
  // what it really has rather than assume the request succeeded.
  setSetting('gmail_granted_scopes', tok.scope ?? '');

  const email = await fetchEmail(tok.access_token);
  if (email) setSetting('gmail_email', email);
  return { email, scopes: tok.scope ?? '', read: String(tok.scope ?? '').includes(READ_SCOPE) };
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
  return /^[\x20-\x7E]*$/.test(v)
    ? v
    : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** Strip CR/LF so a crafted value cannot inject extra headers. */
const headerSafe = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * A display name containing an RFC 5322 special -- a comma most often, as in
 * "Smith, Jones & Co" -- must be a quoted-string, or the comma reads as an
 * address separator and the header is malformed.
 */
function displayName(name) {
  const safe = headerSafe(name);
  if (!safe) return '';
  const encoded = encodeHeader(safe);
  // An RFC 2047 encoded-word is already a valid atom sequence.
  if (encoded !== safe) return encoded;
  if (!/[()<>@,;:\\".[\]]/.test(safe)) return safe;
  return `"${safe.replace(/([\\"])/g, '\\$1')}"`;
}

/**
 * Build an RFC 5322 message, base64url encoded for the Gmail API.
 * `listUnsubscribe` should be a bare email address; it becomes a
 * List-Unsubscribe mailto, which is what mail clients surface as an
 * unsubscribe link.
 */
export function buildRawMessage({ to, from, fromName, subject, body, listUnsubscribe, replyTo }) {
  const headers = [
    `To: ${headerSafe(to)}`,
    ...(from
      ? [`From: ${displayName(fromName) ? `${displayName(fromName)} <${headerSafe(from)}>` : headerSafe(from)}`]
      : []),
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
  // Google's machine-readable reason lives in error.errors[].reason; the
  // human message is localised and must not be pattern-matched.
  const reasons = (body?.error?.errors ?? []).map((e) => e?.reason).filter(Boolean);
  const has = (...names) => names.some((n) => reasons.includes(n));

  if (has('dailyLimitExceeded')) {
    throw new GmailError(
      `Gmail daily sending limit reached: ${message}. Wait 24 hours before sending more.`,
      { status: 429, code: 'DAILY_LIMIT' }
    );
  }
  if (res.status === 429 || has('rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded')) {
    throw new GmailError(`Gmail rate limit hit: ${message}`, {
      status: 429, code: 'RATE_LIMITED', retryable: true,
    });
  }
  // Fall back to the message only when Google sent no reason at all.
  if (res.status === 403 && reasons.length === 0) {
    if (/daily limit/i.test(message)) {
      throw new GmailError(
        `Gmail daily sending limit reached: ${message}. Wait 24 hours before sending more.`,
        { status: 429, code: 'DAILY_LIMIT' }
      );
    }
    if (/rate|quota/i.test(message)) {
      throw new GmailError(`Gmail rate limit hit: ${message}`, {
        status: 429, code: 'RATE_LIMITED', retryable: true,
      });
    }
  }
  if (res.status === 401) {
    throw new GmailError('Gmail rejected the access token — reconnect your account.', {
      status: 401, code: 'REAUTH_NEEDED',
    });
  }
  throw new GmailError(`Gmail refused the message: ${message}`, { status: 502 });
}

/* --------------------------------------------------------- reading replies */

const MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

/**
 * Gmail's base64url is not Node's base64: it swaps two characters and drops
 * the padding. Decoding without translating produces silent corruption
 * rather than an error, so it must be done explicitly.
 */
export function decodeBody(data) {
  if (!data) return '';
  const b64 = String(data).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
}

/**
 * Walk a Gmail payload tree and pull out the best text we can.
 *
 * Preference is text/plain, because a reply's plain part is the words the
 * person typed. text/html is the fallback and is stripped down rather than
 * rendered — we only ever want the text for extraction, never for display.
 */
export function extractText(payload) {
  if (!payload) return '';

  const parts = [];
  (function walk(node) {
    if (!node) return;
    if (node.body?.data) parts.push({ mime: node.mimeType ?? '', text: decodeBody(node.body.data) });
    for (const child of node.parts ?? []) walk(child);
  })(payload);

  const plain = parts.find((p) => p.mime === 'text/plain');
  if (plain?.text?.trim()) return plain.text;

  const html = parts.find((p) => p.mime === 'text/html');
  if (html?.text) return htmlToText(html.text);

  return parts.map((p) => p.text).join('\n').trim();
}

/** Enough HTML stripping to read a reply. Not a renderer. */
export function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const header = (payload, name) =>
  (payload?.headers ?? []).find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

/** The bare address out of `Dave Smith <dave@example.com>`. */
export function bareAddress(v) {
  const s = String(v ?? '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

async function gmailGet(url) {
  const token = await accessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.ok) return res.json();

  const body = await res.json().catch(() => null);
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 401) {
    throw new GmailError('Gmail rejected the access token — reconnect your account.', {
      status: 401, code: 'REAUTH_NEEDED',
    });
  }
  if (res.status === 403) {
    throw new GmailError(
      `Gmail refused the read: ${message}. If you connected before turning reply-reading ` +
      'on, reconnect the account so the read permission is granted.',
      { status: 403, code: 'NO_READ_SCOPE' }
    );
  }
  if (res.status === 429) {
    throw new GmailError(`Gmail rate limit hit: ${message}`, {
      status: 429, code: 'RATE_LIMITED', retryable: true,
    });
  }
  throw new GmailError(`Gmail read failed: ${message}`, { status: 502 });
}

/**
 * Message ids matching a Gmail search query.
 *
 * The caller builds the query narrowly — this is a broad grant and we do not
 * want to pull mail that has nothing to do with a lead.
 */
export async function listMessages(query, { max = 25 } = {}) {
  const p = new URLSearchParams({ q: query, maxResults: String(Math.min(max, 100)) });
  const data = await gmailGet(`${MESSAGES_URL}?${p}`);
  return (data.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId }));
}

/** One message, normalised to the fields a reply needs. */
export async function getMessage(id) {
  const data = await gmailGet(`${MESSAGES_URL}/${encodeURIComponent(id)}?format=full`);
  const p = data.payload;
  return {
    id: data.id,
    threadId: data.threadId,
    from: header(p, 'From'),
    from_address: bareAddress(header(p, 'From')),
    to: header(p, 'To'),
    subject: header(p, 'Subject'),
    date: header(p, 'Date'),
    received_at: data.internalDate
      ? new Date(Number(data.internalDate)).toISOString()
      : new Date().toISOString(),
    snippet: data.snippet ?? '',
    body: extractText(p),
    labels: data.labelIds ?? [],
  };
}

/**
 * Build a Gmail query that finds replies from a set of addresses.
 *
 * Scoped deliberately: only inbox mail, only from addresses we already hold
 * on a lead, and only since a date. Gmail caps query length, so callers
 * batch large address lists.
 */
export function replyQuery(addresses, { sinceDays = 30 } = {}) {
  const from = addresses
    .map((a) => String(a).trim().toLowerCase())
    .filter(Boolean)
    .map((a) => `from:${a}`)
    .join(' OR ');
  if (!from) return null;
  return `in:inbox newer_than:${Math.max(1, Math.min(365, sinceDays))}d (${from})`;
}

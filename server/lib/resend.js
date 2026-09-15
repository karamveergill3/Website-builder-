/**
 * Resend email API — plain fetch, zero npm dependencies.
 *
 * Resend is a transactional email service with a generous free tier
 * (100 emails/day, 3 000/month).  It uses domain-level verification (DKIM)
 * so every team member can send from their own @yourdomain.com address
 * without per-person OAuth.
 *
 * When RESEND_API_KEY is set in .env the send pipeline uses this instead of
 * the Gmail OAuth path, with no other config change needed.
 *
 * https://resend.com/docs/api-reference/emails/send-email
 */

const API_URL = 'https://api.resend.com/emails';

export class ResendError extends Error {
  constructor(message, { status = 502, code, retryable = false } = {}) {
    super(message);
    this.name = 'ResendError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** True when a Resend API key is present in the environment. */
export const configured = () => Boolean(process.env.RESEND_API_KEY?.trim());

/**
 * Send one email via Resend's REST API.
 *
 * @param {object} opts
 * @param {string} opts.from  - RFC 5322 sender: "Name <addr>" or bare addr
 * @param {string} opts.to    - recipient email address
 * @param {string} opts.subject
 * @param {string} opts.text  - plain-text body
 * @param {string} [opts.replyTo] - optional Reply-To address
 * @returns {Promise<{ id: string }>} Resend message id (the proof of send)
 */
export async function sendEmail({ from, to, subject, text, replyTo }) {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) {
    throw new ResendError(
      'RESEND_API_KEY is not set.  Add it to your .env file.',
      { status: 503, code: 'NOT_CONFIGURED' },
    );
  }

  const body = { from, to: [to], subject, text };
  if (replyTo) body.reply_to = [replyTo];

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (res.ok) return { id: data?.id ?? null };

  const message = data?.message ?? `HTTP ${res.status}`;

  if (res.status === 429) {
    throw new ResendError(`Resend rate limit: ${message}`, {
      status: 429, code: 'RATE_LIMITED', retryable: true,
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new ResendError(
      `Resend auth error: ${message}.  Check your RESEND_API_KEY.`,
      { status: 401, code: 'AUTH_ERROR' },
    );
  }
  if (res.status === 422) {
    // Domain not verified, bad from-address, missing fields, etc.
    throw new ResendError(
      `Resend rejected the email: ${message}`,
      { status: 422, code: 'REJECTED' },
    );
  }

  throw new ResendError(`Resend error: ${message}`, { status: 502 });
}

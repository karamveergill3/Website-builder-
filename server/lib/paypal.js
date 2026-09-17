/**
 * PayPal Orders — take a real payment for an invoice.
 *
 * The client opens their invoice link, taps "Pay now", and is sent to PayPal
 * where they can pay in full or choose Pay in 3 (PayPal's own monthly plan).
 * Either way PayPal pays the business in full; the instalments are between the
 * client and PayPal. On return we CAPTURE the order and, only if PayPal says
 * COMPLETED and the amount matches the invoice to the penny, mark it paid.
 *
 * No SDK — the REST API over fetch, the same way Companies House, Places and
 * Gmail are called, so the three-dependency rule holds. Credentials live in
 * the environment (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV), not
 * the database and never the code. With none set, `configured()` is false and
 * the invoice falls back to the manual PayPal link + bank details.
 */
const LIVE = 'https://api-m.paypal.com';
const SANDBOX = 'https://api-m.sandbox.paypal.com';

export class PayPalError extends Error {
  constructor(message, { status = 502, code } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.code = code;
  }
}

function creds() {
  const client_id = process.env.PAYPAL_CLIENT_ID?.trim();
  const secret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!client_id || !secret) {
    throw new PayPalError('PayPal is not connected. Set PAYPAL_CLIENT_ID and '
      + 'PAYPAL_CLIENT_SECRET in .env.', { status: 400, code: 'NOT_CONFIGURED' });
  }
  return { client_id, secret };
}

/** Live unless PAYPAL_ENV is explicitly "sandbox". */
export function apiBase() {
  return String(process.env.PAYPAL_ENV ?? '').trim().toLowerCase() === 'sandbox' ? SANDBOX : LIVE;
}

export const configured = () =>
  Boolean(process.env.PAYPAL_CLIENT_ID?.trim() && process.env.PAYPAL_CLIENT_SECRET?.trim());

/* ----------------------------------------------------------------- token */

let cached = { token: null, expiry: 0 };

/** A bearer token, refreshed a minute before it expires. */
export async function accessToken() {
  if (cached.token && cached.expiry > Date.now() + 60_000) return cached.token;
  const { client_id, secret } = creds();
  const basic = Buffer.from(`${client_id}:${secret}`).toString('base64');
  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new PayPalError(
      `PayPal rejected the credentials (${body?.error ?? res.status}). Check `
      + 'PAYPAL_CLIENT_ID/SECRET and that PAYPAL_ENV matches where they came from.',
      { status: res.status === 401 ? 401 : 502, code: 'AUTH' }
    );
  }
  // Benign if two requests race here: both just fetch a token and the last
  // write wins. There is nothing to corrupt — it is a cache, not a balance.
  // eslint-disable-next-line require-atomic-updates
  cached = { token: body.access_token, expiry: Date.now() + (body.expires_in ?? 3000) * 1000 };
  return cached.token;
}

/** Only for tests: forget the cached token. */
export function _resetToken() { cached = { token: null, expiry: 0 }; }

/* ----------------------------------------------------------------- orders */

const value = (pence) => (Math.round(Number(pence) || 0) / 100).toFixed(2);

async function call(path, { method = 'POST', body } = {}) {
  const token = await accessToken();
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = json?.details?.[0]?.description ?? json?.message ?? `HTTP ${res.status}`;
    throw new PayPalError(`PayPal: ${detail}`, { status: 502, code: json?.name });
  }
  return json;
}

/**
 * Create an order for an invoice's full total. Returns the order id and the
 * URL to send the client to. The amount comes from the stored invoice, never
 * from anything the client sends.
 */
export async function createOrder(invoice, { returnUrl, cancelUrl }) {
  const order = await call('/v2/checkout/orders', {
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: invoice.number,
        description: `Invoice ${invoice.number}`.slice(0, 127),
        amount: { currency_code: invoice.currency || 'GBP', value: value(invoice.amount_due_pence ?? invoice.total_pence) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            brand_name: (process.env.BIZ_TRADING_NAME ?? 'Invoice').slice(0, 127),
          },
        },
      },
    },
  });
  // With payment_source.paypal the redirect link is rel:"payer-action";
  // the classic flow calls it "approve". Accept either.
  const link = (order.links ?? []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!link) throw new PayPalError('PayPal did not return an approval link.', { code: 'NO_LINK' });
  return { id: order.id, approveUrl: link.href };
}

/**
 * Capture a previously-approved order. Returns { paid, amount_pence, capture_id }.
 * `paid` is true only when PayPal reports COMPLETED — the caller still checks
 * the amount against the invoice before recording payment.
 */
export async function captureOrder(orderId) {
  const res = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { body: {} });
  const capture = res?.purchase_units?.[0]?.payments?.captures?.[0];
  const amount = capture?.amount?.value;
  return {
    paid: res?.status === 'COMPLETED' && capture?.status === 'COMPLETED',
    amount_pence: amount != null ? Math.round(Number(amount) * 100) : null,
    currency: capture?.amount?.currency_code ?? null,
    capture_id: capture?.id ?? null,
    status: res?.status ?? null,
  };
}

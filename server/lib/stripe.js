/**
 * Stripe Checkout — take a card, Klarna or Clearpay payment for an invoice.
 *
 * The client opens their invoice link, taps "Pay by card / Klarna / Clearpay",
 * and is sent to Stripe's hosted Checkout page. Which methods appear there
 * (Visa/Mastercard/Amex, Klarna Pay in 3, Clearpay Pay in 4, Apple/Google Pay)
 * is controlled entirely in the Stripe Dashboard, so the owner turns methods on
 * and off without a code change. On return we look the session up and, only if
 * Stripe reports it PAID and the amount matches the invoice to the penny, mark
 * it paid. Whatever the method, Keylo is paid in full up front.
 *
 * No SDK — the REST API over fetch, the same way PayPal, Companies House,
 * Places and Gmail are called, so the three-dependency rule holds. The secret
 * key lives in the environment (STRIPE_SECRET_KEY), never the database and
 * never the code. Test vs live is decided by the key itself (sk_test_ vs
 * sk_live_), so there is no separate environment switch to get wrong. With no
 * key set, `configured()` is false and the invoice simply doesn't show the
 * Stripe option.
 */
const API = 'https://api.stripe.com';

export class StripeError extends Error {
  constructor(message, { status = 502, code } = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
  }
}

function secret() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new StripeError('Stripe is not connected. Set STRIPE_SECRET_KEY in .env.',
      { status: 400, code: 'NOT_CONFIGURED' });
  }
  return key;
}

export const configured = () => Boolean(process.env.STRIPE_SECRET_KEY?.trim());

/** A live key starts sk_live_; anything else (sk_test_) is test mode. */
export const isTestMode = () =>
  !String(process.env.STRIPE_SECRET_KEY ?? '').trim().startsWith('sk_live_');

/* ------------------------------------------------------------------- call */

async function call(path, { method = 'POST', form } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret()}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? form.toString() : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = json?.error?.message ?? `HTTP ${res.status}`;
    throw new StripeError(`Stripe: ${detail}`, {
      status: res.status === 401 ? 401 : 502,
      code: json?.error?.code,
    });
  }
  return json;
}

/* --------------------------------------------------------------- checkout */

/**
 * Create a hosted Checkout session for an invoice's full total. Returns the
 * session id and the URL to send the client to. The amount comes from the
 * stored invoice, in integer pence, never from anything the client sends.
 * payment_method_types is deliberately omitted so Stripe offers whatever the
 * Dashboard has enabled (card, Klarna, Clearpay, wallets).
 */
export async function createCheckoutSession(invoice, { successUrl, cancelUrl }) {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', successUrl);
  form.set('cancel_url', cancelUrl);
  form.set('client_reference_id', invoice.number);
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', String(invoice.currency || 'GBP').toLowerCase());
  form.set('line_items[0][price_data][unit_amount]', String(Math.round(Number(invoice.amount_due_pence ?? invoice.total_pence) || 0)));
  form.set('line_items[0][price_data][product_data][name]', `Invoice ${invoice.number}`.slice(0, 250));

  const session = await call('/v1/checkout/sessions', { form });
  if (!session?.url) throw new StripeError('Stripe did not return a checkout URL.', { code: 'NO_URL' });
  return { id: session.id, url: session.url };
}

/**
 * Look a session up on return. Returns { paid, amount_pence, currency,
 * payment_ref, status }. `paid` is true only when Stripe reports the session
 * paid — the caller still checks the amount against the invoice before
 * recording payment.
 */
export async function retrieveSession(id) {
  const s = await call(`/v1/checkout/sessions/${encodeURIComponent(id)}`, { method: 'GET' });
  return {
    paid: s?.payment_status === 'paid',
    amount_pence: s?.amount_total != null ? Math.round(Number(s.amount_total)) : null,
    currency: s?.currency ? String(s.currency).toUpperCase() : null,
    payment_ref: (typeof s?.payment_intent === 'string' ? s.payment_intent : s?.payment_intent?.id) ?? null,
    status: s?.status ?? null,
  };
}

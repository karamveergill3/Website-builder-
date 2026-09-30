/**
 * GoCardless Direct Debit — automatic monthly collection for maintenance plans.
 *
 * The owner sets a maintenance plan up for Direct Debit; the hub creates a
 * GoCardless "billing request flow" and hands back an authorisation link to
 * send the client. The client fills in their bank details on GoCardless's own
 * secure page (we never see or store them), and on their return the hub
 * fulfils the mandate and creates a monthly subscription for the plan amount.
 * From then on GoCardless collects every month on its own and pays out to the
 * business bank account — no invoice to raise, no link to chase.
 *
 * No SDK — the REST API over fetch, like PayPal and Stripe, so the three-
 * dependency rule holds. The access token lives in the environment
 * (GOCARDLESS_ACCESS_TOKEN), never the database or the code. Sandbox vs live is
 * decided by the token itself (sandbox_… vs live_…), so there is no separate
 * switch. With no token set, `configured()` is false and the Direct Debit
 * option simply doesn't appear.
 */
const LIVE = 'https://api.gocardless.com';
const SANDBOX = 'https://api-sandbox.gocardless.com';
const GC_VERSION = '2015-07-06';

export class GoCardlessError extends Error {
  constructor(message, { status = 502, code } = {}) {
    super(message);
    this.name = 'GoCardlessError';
    this.status = status;
    this.code = code;
  }
}

function token() {
  const t = process.env.GOCARDLESS_ACCESS_TOKEN?.trim();
  if (!t) {
    throw new GoCardlessError('Direct Debit is not connected. Set GOCARDLESS_ACCESS_TOKEN in .env.',
      { status: 400, code: 'NOT_CONFIGURED' });
  }
  return t;
}

export const configured = () => Boolean(process.env.GOCARDLESS_ACCESS_TOKEN?.trim());

/** A live token starts live_; anything else (sandbox_…) is the sandbox. */
export function apiBase() {
  return String(process.env.GOCARDLESS_ACCESS_TOKEN ?? '').trim().startsWith('live_') ? LIVE : SANDBOX;
}

async function call(path, { method = 'POST', body, idempotencyKey } = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'GoCardless-Version': GC_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error;
    const detail = err?.message ?? `HTTP ${res.status}`;
    throw new GoCardlessError(`GoCardless: ${detail}`, {
      status: res.status === 401 ? 401 : 502,
      code: err?.type,
    });
  }
  return json;
}

/* ---------------------------------------------------------- mandate setup */

/**
 * Start a mandate authorisation for a maintenance plan. Returns the billing
 * request id (to remember against the plan) and the authorisation_url to send
 * the client to. The client authorises on GoCardless; on return we finish up.
 */
export async function createMandateFlow({ returnUrl, exitUrl, name } = {}) {
  const brq = await call('/billing_requests', {
    body: { billing_requests: { mandate_request: { currency: 'GBP', scheme: 'bacs' } } },
  });
  const brqId = brq?.billing_requests?.id;
  if (!brqId) throw new GoCardlessError('GoCardless did not return a billing request.', { code: 'NO_BRQ' });

  const flow = await call('/billing_request_flows', {
    body: {
      billing_request_flows: {
        redirect_uri: returnUrl,
        exit_uri: exitUrl,
        ...(name ? { prefilled_customer: { company_name: name } } : {}),
        links: { billing_request: brqId },
      },
    },
  });
  const url = flow?.billing_request_flows?.authorisation_url;
  if (!url) throw new GoCardlessError('GoCardless did not return an authorisation link.', { code: 'NO_URL' });
  return { billingRequestId: brqId, authorisationUrl: url };
}

/** The mandate id once a billing request is fulfilled (null if not yet). */
export async function mandateFor(billingRequestId) {
  const brq = await call(`/billing_requests/${encodeURIComponent(billingRequestId)}`, { method: 'GET' });
  const b = brq?.billing_requests;
  if (!b) return { status: null, mandateId: null };
  // Fulfil it if the client finished the flow but it hasn't auto-fulfilled.
  if (b.status !== 'fulfilled' && b.status !== 'cancelled') {
    try {
      const done = await call(`/billing_requests/${encodeURIComponent(billingRequestId)}/actions/fulfil`, { body: {} });
      return { status: done?.billing_requests?.status ?? b.status,
        mandateId: done?.billing_requests?.links?.mandate_request_mandate ?? null };
    } catch { /* not ready yet; fall through with what we have */ }
  }
  return { status: b.status, mandateId: b.links?.mandate_request_mandate ?? null };
}

/**
 * Create the monthly subscription on a mandate. `idempotencyKey` (the plan's
 * token) makes a repeated return safe: GoCardless returns the same
 * subscription rather than creating a second.
 */
export async function createSubscription({ mandateId, pence, name, dayOfMonth, idempotencyKey } = {}) {
  const day = Math.min(28, Math.max(1, Math.round(Number(dayOfMonth) || 1))); // 1..28, always valid
  const sub = await call('/subscriptions', {
    idempotencyKey: idempotencyKey ? `sub-${idempotencyKey}` : undefined,
    body: {
      subscriptions: {
        amount: Math.round(Number(pence) || 0), // GoCardless amount is in pence
        currency: 'GBP',
        interval_unit: 'monthly',
        day_of_month: String(day),
        name: (name || 'Website maintenance').slice(0, 100),
        links: { mandate: mandateId },
      },
    },
  });
  const id = sub?.subscriptions?.id;
  if (!id) throw new GoCardlessError('GoCardless did not create the subscription.', { code: 'NO_SUB' });
  return { subscriptionId: id };
}

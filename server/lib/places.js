/**
 * Google Places API (New) client, tuned for one job: finding UK businesses
 * that have no website, as cheaply as the API allows.
 *
 * Cost discipline, in order of importance:
 *
 * 1. Field masks are mandatory on the New API and are what you are billed on.
 *    We request exactly five fields and never photos, reviews or opening hours.
 * 2. `websiteUri` can be requested directly on Text Search, which means one
 *    billed call per *page of up to 20 places* instead of one per place. That
 *    is the default strategy and it is roughly an order of magnitude cheaper
 *    than Text Search + N x Place Details. See docs/PHASE2-PLACES.md.
 * 3. Any place ID already in place_cache or on a lead is never looked up
 *    again, so a repeated sweep of the same town costs almost nothing.
 *
 * Pricing and per-field SKU tiers are Google's to change; the figures used by
 * the cost estimator live in one place (PRICING below) and are dated.
 */

const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';

/**
 * The only fields this tool needs. Text Search field masks are prefixed with
 * `places.`; Place Details masks are not.
 */
export const WANTED_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'nationalPhoneNumber',
  'websiteUri',
];

export const TEXT_SEARCH_MASK = [
  ...WANTED_FIELDS.map((f) => `places.${f}`),
  'nextPageToken',
].join(',');

export const DETAILS_MASK = WANTED_FIELDS.join(',');

export const PRICING_SOURCE =
  'https://developers.google.com/maps/documentation/places/web-service/usage-and-billing';

/**
 * Starting figures for the cost estimator, in USD per 1,000 requests.
 *
 * THESE ARE NOT VERIFIED. They could not be read from Google's own pages when
 * this was built, and Google reprices Maps Platform periodically. The estimate
 * therefore reports itself as unverified until you open PRICING_SOURCE, check
 * the current numbers, and confirm them under Settings -> Places pricing.
 *
 * Requesting websiteUri and a phone number is what lifts a request out of the
 * cheapest tier, so these are the Pro-tier rates.
 */
export const PRICING_DEFAULTS = {
  currency: 'USD',
  text_search_per_1000: 35.0,
  place_details_per_1000: 20.0,
  free_calls_per_sku_per_month: 5000,
};

export class PlacesError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = 'PlacesError';
    this.status = status ?? 502;
    this.code = code;
    this.retryable = retryable;
  }
}

const apiKey = () => {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) {
    throw new PlacesError(
      'GOOGLE_MAPS_API_KEY is not set. Add it to .env — see docs/PHASE2-PLACES.md.',
      { status: 503, code: 'NO_API_KEY' }
    );
  }
  return key;
};

/**
 * Turn a Google error body into something actionable.
 *
 * Google's error envelope carries a machine-readable reason inside
 * `error.details`, as an ErrorInfo entry. The details array is not ordered
 * and does not always contain an ErrorInfo at all -- a 403 with no ErrorInfo
 * is specifically the "no API key was sent" case -- so this looks the entry up
 * by @type and never indexes details[0] or parses the human message.
 */
const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';

function interpret(status, body) {
  const err = body?.error;
  const message = err?.message ?? `Places API returned ${status}`;
  const reason = (err?.details ?? []).find((d) => d?.['@type'] === ERROR_INFO)?.reason ?? null;

  const of = (msg, code, opts = {}) => new PlacesError(msg, { code, ...opts });

  switch (reason) {
    case 'API_KEY_INVALID':
      return of(`Google rejected the API key: ${message}`, 'KEY_INVALID', { status: 503 });
    case 'SERVICE_DISABLED':
      return of('Places API (New) is not enabled on this Google Cloud project. ' +
                'Enable it in the console, then try again.', 'API_NOT_ENABLED', { status: 503 });
    case 'BILLING_DISABLED':
      return of('The Google Cloud project has no active billing account. ' +
                'Places API (New) will not answer until billing is switched on.',
                'BILLING_DISABLED', { status: 503 });
    case 'API_KEY_SERVICE_BLOCKED':
      return of('This API key is restricted and its allowed list does not include ' +
                'Places API (New). Add it under the key\'s API restrictions.',
                'KEY_SERVICE_BLOCKED', { status: 503 });
    case 'API_KEY_IP_ADDRESS_BLOCKED':
      return of('This API key has an IP restriction that does not include this machine\'s ' +
                'outbound address.', 'KEY_IP_BLOCKED', { status: 503 });
    case 'API_KEY_HTTP_REFERRER_BLOCKED':
      return of('This API key has an HTTP referrer restriction, which only works for browser ' +
                'requests. A server-side key needs an IP restriction or none.',
                'KEY_REFERRER_BLOCKED', { status: 503 });
    case 'RATE_LIMIT_EXCEEDED':
      return of(`Rate limited by Google: ${message}`, 'RATE_LIMITED',
                { status: 429, retryable: true });
    case 'RESOURCE_QUOTA_EXCEEDED':
      // Backing off will not help: the allocation itself is spent.
      return of(`Google Places quota exhausted: ${message}`, 'QUOTA_EXHAUSTED', { status: 429 });
    default:
      break;
  }

  // A 403 carrying no ErrorInfo is the "no API key sent at all" case.
  if (status === 403 && !reason) {
    return of('No API key reached Google. Check GOOGLE_MAPS_API_KEY is set and the server ' +
              'was restarted after setting it.', 'NO_API_KEY', { status: 503 });
  }
  if (status === 400 && /field mask/i.test(message)) {
    return of(`Invalid field mask: ${message}`, 'BAD_FIELD_MASK', { status: 500 });
  }
  if (status === 429) {
    return of(`Rate limited: ${message}`, 'RATE_LIMITED', { status: 429, retryable: true });
  }
  if (status >= 500) {
    return of(`Google Places is having trouble: ${message}`, 'UPSTREAM',
              { status: 502, retryable: true });
  }
  return of(message, reason ?? 'UNKNOWN', { status: 502 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST/GET with one retry-with-backoff for transient failures. */
async function call(url, { method = 'POST', mask, body, signal }) {
  // Resolve the key up front: a missing one is a configuration error, not
  // something worth three network retries.
  const key = apiKey();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(500 * 2 ** attempt);
    let res;
    try {
      res = await fetch(url, {
        method,
        signal,
        headers: {
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': mask,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = new PlacesError(`Could not reach Google Places: ${err.message}`, {
        status: 502, code: 'NETWORK', retryable: true,
      });
      continue;
    }

    if (res.ok) return res.json();

    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    const err = interpret(res.status, payload);
    if (!err.retryable) throw err;
    lastErr = err;
  }
  throw lastErr;
}

/**
 * One page of Text Search results. Requesting websiteUri here is what lets us
 * decide "has a website?" without a per-place Details call.
 */
export async function textSearch(textQuery, {
  regionCode = 'GB', pageToken, pageSize = 20, signal,
} = {}) {
  const data = await call(TEXT_SEARCH_URL, {
    mask: TEXT_SEARCH_MASK,
    signal,
    body: {
      textQuery,
      regionCode,
      pageSize: Math.min(pageSize, 20),
      ...(pageToken ? { pageToken } : {}),
    },
  });
  return { places: data.places ?? [], nextPageToken: data.nextPageToken ?? null };
}

/**
 * Full details for one place. Only needed as a fallback -- see the module
 * comment. Note the mask has no `places.` prefix here.
 */
export async function placeDetails(placeId, { signal } = {}) {
  return call(`${DETAILS_URL}/${encodeURIComponent(placeId)}`, {
    method: 'GET', mask: DETAILS_MASK, signal,
  });
}

/** Normalise a Places response object into the shape place_cache stores. */
export function normalise(place) {
  const website = typeof place.websiteUri === 'string' ? place.websiteUri.trim() : '';
  return {
    place_id: place.id,
    display_name: place.displayName?.text ?? place.displayName ?? null,
    address: place.formattedAddress ?? null,
    phone: place.nationalPhoneNumber ?? null,
    website_uri: website || null,
    // A place with no website simply omits websiteUri from the response.
    has_website: website ? 1 : 0,
  };
}

/** Split a pasted list of towns into clean area names. */
export function parseAreas(input) {
  return [...new Set(
    String(input ?? '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  )];
}

/** The text query sent to Google for one category/area pair. */
export const buildQuery = (category, area) =>
  area ? `${category} in ${area}` : String(category);

/**
 * Rough cost of a sweep, for the UI's "before you press go" estimate.
 * Text Search bills per request (a page of up to 20 places), not per place.
 *
 * `rates` comes from settings so the figures can be corrected without a code
 * change; `verified_on` is null until the user has actually checked them.
 */
export function estimateCost({ areas, pagesPerArea = 1, rates = {} }) {
  const perThousand = Number(rates.text_search_per_1000 ?? PRICING_DEFAULTS.text_search_per_1000);
  const freeCalls = Number(rates.free_calls_per_sku_per_month ?? PRICING_DEFAULTS.free_calls_per_sku_per_month);
  // No areas means one sweep of the bare category, so the floor is 1.
  const requests = Math.max(areas, 1) * Math.max(pagesPerArea, 1);

  return {
    requests,
    approx_usd: Number(((requests / 1000) * perThousand).toFixed(4)),
    per_1000_usd: perThousand,
    free_calls_per_month: freeCalls,
    verified_on: rates.verified_on ?? null,
    pricing_source: PRICING_SOURCE,
  };
}

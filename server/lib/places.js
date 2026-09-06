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

/**
 * Prices in USD per 1,000 requests, and the tier each field mask lands in.
 * VERIFY AGAINST https://developers.google.com/maps/documentation/places/web-service/usage-and-billing
 * before relying on the estimate -- Google reprices this periodically.
 */
export const PRICING = {
  checked_on: '2026-09-06',
  currency: 'USD',
  // Requesting websiteUri / phone numbers pulls a request into the Pro tier.
  text_search_pro_per_1000: 35.0,
  place_details_pro_per_1000: 20.0,
  free_calls_per_sku_per_month: 5000,
  source: 'https://developers.google.com/maps/documentation/places/web-service/usage-and-billing',
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

/** Turn a Google error body into something actionable rather than a 502. */
function interpret(status, body) {
  const message = body?.error?.message ?? `Places API returned ${status}`;
  const reason = body?.error?.details?.[0]?.reason ?? body?.error?.status;

  if (status === 400 && /field mask/i.test(message)) {
    return new PlacesError(`Invalid field mask: ${message}`, { status: 500, code: 'BAD_FIELD_MASK' });
  }
  if (status === 403 && /not been used|disabled|SERVICE_DISABLED/i.test(message + reason)) {
    return new PlacesError(
      'Places API (New) is not enabled on this Google Cloud project. Enable it in the console, then retry.',
      { status: 503, code: 'API_NOT_ENABLED' }
    );
  }
  if (status === 403 || status === 401) {
    return new PlacesError(
      `Google rejected the API key: ${message}. Check the key is correct, that billing is on, and that its API restriction includes "Places API (New)".`,
      { status: 503, code: 'KEY_REJECTED' }
    );
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message + reason)) {
    return new PlacesError(`Rate limited or out of quota: ${message}`, {
      status: 429, code: 'RATE_LIMITED', retryable: true,
    });
  }
  if (status >= 500) {
    return new PlacesError(`Google Places is having trouble: ${message}`, {
      status: 502, code: 'UPSTREAM', retryable: true,
    });
  }
  return new PlacesError(message, { status: 502, code: reason ?? 'UNKNOWN' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST/GET with one retry-with-backoff for transient failures. */
async function call(url, { method = 'POST', mask, body, signal }) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(500 * 2 ** attempt);
    let res;
    try {
      res = await fetch(url, {
        method,
        signal,
        headers: {
          'X-Goog-Api-Key': apiKey(),
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
 */
export function estimateCost({ areas, pagesPerArea = 1 }) {
  const requests = Math.max(areas, 1) * Math.max(pagesPerArea, 1);
  return {
    requests,
    approx_usd: Number(((requests / 1000) * PRICING.text_search_pro_per_1000).toFixed(4)),
    per_1000_usd: PRICING.text_search_pro_per_1000,
    free_calls_per_month: PRICING.free_calls_per_sku_per_month,
    pricing_checked: PRICING.checked_on,
    pricing_source: PRICING.source,
  };
}

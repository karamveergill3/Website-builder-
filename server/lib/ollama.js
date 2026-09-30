/**
 * Ollama client — a local language model, on this machine, over plain HTTP.
 *
 * WHY THIS DOES NOT BREAK THE NO-AI PROMISE
 *
 * The promise was never "no language models" in the abstract; it was that
 * running this tool must not consume anyone's paid AI account. Ollama runs
 * entirely on your own hardware:
 *
 *   - no API key, no account, no bill, no rate limit
 *   - nothing leaves the machine — a prospect's reply is never uploaded
 *   - zero npm dependencies: this file is `fetch` to 127.0.0.1
 *
 * The guard is the host allow-list below. Only loopback is permitted; a
 * hosted endpoint is refused before a request is made, and test/no-ai.test.js
 * enforces the same rule over the whole source tree.
 *
 * If Ollama is not installed or not running, every call here fails softly
 * and the caller falls back to the deterministic parser. The tool must keep
 * working on a machine that has never heard of Ollama.
 *
 * Setup, for the record:
 *   curl -fsSL https://ollama.com/install.sh | sh     (or the .dmg on macOS)
 *   ollama pull llama3.2                              (~2 GB)
 *   ollama serve                                      (usually automatic)
 */

const DEFAULT_HOST = '127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.2';
const TIMEOUT_MS = 120_000;

/* eslint-disable require-atomic-updates */ // `availability` is a single-process memo

/** Only loopback. A remote host is a configuration error, not a fallback. */
const LOOPBACK = /^(127\.(\d+)\.(\d+)\.(\d+)|localhost|\[::1\]|::1)(:\d+)?$/i;

export class OllamaError extends Error {
  constructor(message, { code = 'OLLAMA', status = 503 } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
    this.status = status;
  }
}

function host() {
  const h = (process.env.OLLAMA_HOST ?? DEFAULT_HOST).trim().replace(/^https?:\/\//, '');
  const bare = h.replace(/\/.*$/, '');
  if (!LOOPBACK.test(bare)) {
    throw new OllamaError(
      `OLLAMA_HOST must be a loopback address — got "${bare}". This tool only ever ` +
      'talks to a model running on this machine, so nothing is billed and no ' +
      'prospect data leaves the box.',
      { code: 'NOT_LOOPBACK', status: 500 }
    );
  }
  return bare;
}

export const model = () => (process.env.OLLAMA_MODEL ?? DEFAULT_MODEL).trim();

/** Base URL, validated. Throws if configured to point off-machine. */
export const baseUrl = () => `http://${host()}`;

/**
 * Is a local model actually available right now? Cheap, and cached briefly
 * so a page render does not probe repeatedly.
 */
let availability = { at: 0, ok: false, detail: null };
const AVAILABILITY_TTL_MS = 30_000;

export async function available({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - availability.at < AVAILABILITY_TTL_MS) return availability;

  // A non-loopback OLLAMA_HOST is a configuration error, not an outage.
  // Report it as such rather than as "not running".
  let url;
  try {
    url = baseUrl();
  } catch (err) {
    availability = { at: now, ok: false, detail: err.message, misconfigured: true };
    return availability;
  }

  let result;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    try {
      const res = await fetch(`${url}/api/tags`, { signal: ac.signal });
      if (!res.ok) {
        result = { ok: false, detail: `Ollama answered ${res.status}` };
      } else {
        const data = await res.json();
        const names = (data.models ?? []).map((m) => m.name);
        const want = model();
        const has = names.some((n) => n === want || n.startsWith(`${want}:`));
        result = has
          ? { ok: true, detail: null, models: names }
          : {
              ok: false,
              models: names,
              detail: `Ollama is running but "${want}" is not pulled. ` +
                      `Run: ollama pull ${want}`,
            };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    result = {
      ok: false,
      detail: err.name === 'AbortError'
        ? 'Ollama did not answer within 2s'
        : `Ollama is not reachable at ${url} — is it running?`,
    };
  }

  availability = { at: now, ...result };
  return availability;
}

/**
 * Ask the local model for JSON matching a shape, and parse it defensively.
 *
 * Ollama's `format: 'json'` constrains generation to valid JSON, but says
 * nothing about the SHAPE — so the caller always passes a `coerce` function
 * that maps whatever came back onto the fields it actually needs, dropping
 * anything unexpected. A small local model will occasionally invent a key
 * or return a string where a list was asked for; coercion is not optional.
 *
 * Returns { ok, data, raw, error }. Never throws for a model failure —
 * only for a misconfiguration (a non-loopback host).
 */
export async function extractJson({ system, prompt, coerce, timeoutMs = TIMEOUT_MS }) {
  const url = `${baseUrl()}/api/generate`; // throws early if misconfigured

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model(),
        prompt,
        system,
        format: 'json',
        stream: false,
        options: {
          // Low temperature: this is extraction, not writing. We want the
          // same answer every time for the same reply.
          temperature: 0.1,
          num_predict: 800,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        error: `Ollama returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      };
    }

    const payload = await res.json();
    const raw = payload.response ?? '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // format:'json' should prevent this, but older Ollama builds and some
      // models still wrap the object in prose or a fenced block.
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return { ok: false, raw, error: 'Model did not return JSON' };
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return { ok: false, raw, error: 'Model returned malformed JSON' };
      }
    }

    return { ok: true, raw, data: coerce ? coerce(parsed) : parsed };
  } catch (err) {
    if (err instanceof OllamaError) throw err;
    return {
      ok: false,
      error: err.name === 'AbortError'
        ? `Local model timed out after ${Math.round(timeoutMs / 1000)}s`
        : `Could not reach the local model: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------- coercion */

/** Force a value to a trimmed string, or null. */
export const asText = (v) => {
  if (v == null) return null;
  const s = String(Array.isArray(v) ? v.join(', ') : v).trim();
  return s === '' ? null : s;
};

/**
 * Force a value to an array of clean strings. Models return lists as arrays,
 * comma strings, newline strings, or objects with a `items` key — all of
 * which are handled here rather than at every call site.
 */
export function asList(v, { max = 20 } = {}) {
  if (v == null) return [];
  let items;
  if (Array.isArray(v)) items = v;
  else if (typeof v === 'object') items = Object.values(v).flat();
  else items = String(v).split(/[\n,;•·]|(?:\s+-\s+)/);

  return [...new Set(
    items
      .map((x) => (x == null ? '' : String(typeof x === 'object' ? (x.name ?? x.value ?? '') : x)))
      .map((s) => s.replace(/^[\s\-*\d.)]+/, '').trim())
      .filter((s) => s.length > 1 && s.length <= 80)
  )].slice(0, max);
}

/** Force a value to a boolean, accepting the many ways a model says yes. */
export function asBool(v, fallback = false) {
  if (v == null) return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'has', 'available'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'none', 'not yet', 'unknown'].includes(s)) return false;
  return fallback;
}

/** Force a value onto one of a fixed set of options, else null. */
export function asOneOf(v, allowed, fallback = null) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return fallback;
  const hit = allowed.find((a) => a === s);
  if (hit) return hit;
  // A model asked for "call" may answer "phone call" or "calling".
  const loose = allowed.find((a) => s.includes(a) || a.includes(s));
  return loose ?? fallback;
}

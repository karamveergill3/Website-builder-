/** Small helpers shared by the route modules. */

/** An error carrying an HTTP status, thrown by route handlers. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);

/** Wrap an async handler so rejections reach the error middleware. */
export const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export const nowIso = () => new Date().toISOString();

/** Trim a string field; '' and undefined both become null. */
export function str(value) {
  if (value == null) return null;
  const t = String(value).trim();
  return t === '' ? null : t;
}

/** Required trimmed string. */
export function requiredStr(value, field) {
  const v = str(value);
  if (v === null) throw badRequest(`${field} is required`);
  return v;
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function int(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Deliberately permissive email check. This is a personal tool: the goal is to
 * catch fat-finger mistakes before a send, not to police RFC 5322.
 */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
export const looksLikeEmail = (v) => typeof v === 'string' && EMAIL_RE.test(v.trim());

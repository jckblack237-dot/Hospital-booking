import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyz';

export function id(prefix) {
  let out = '';
  const bytes = crypto.randomBytes(12);
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

export function secret(prefix = 'whsec') {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

/** RFC 9457 problem details, thrown and caught by the error middleware. */
export class HttpError extends Error {
  constructor(status, type, title, detail, extra = {}) {
    super(detail || title);
    this.status = status;
    this.type = type;
    this.title = title;
    this.detail = detail;
    this.extra = extra;
  }
  static badRequest(detail, extra) {
    return new HttpError(400, 'invalid_request', 'Invalid request', detail, extra);
  }
  static unauthorized(detail = 'Missing or invalid credentials') {
    return new HttpError(401, 'unauthorized', 'Unauthorized', detail);
  }
  static forbidden(detail = 'Not permitted') {
    return new HttpError(403, 'forbidden', 'Forbidden', detail);
  }
  static notFound(what = 'Resource') {
    return new HttpError(404, 'not_found', `${what} not found`, `${what} not found`);
  }
  static conflict(type, detail, extra) {
    return new HttpError(409, type, 'Conflict', detail, extra);
  }
  static unprocessable(detail, extra) {
    return new HttpError(422, 'unprocessable', 'Unprocessable', detail, extra);
  }
}

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function hmacSignature(secretValue, timestampSeconds, body) {
  const mac = crypto.createHmac('sha256', secretValue);
  mac.update(`${timestampSeconds}.${body}`);
  return mac.digest('hex');
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function json(value) {
  return value == null ? null : JSON.stringify(value);
}

export function parse(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- validation
// Tiny, explicit validators: a stray keystroke in a "minutes" prompt must come
// back as a 400 naming the field, never as a NaN bound into SQLite and a 500.

export function num(value, name, { min = -Infinity, max = Infinity, int = false, fallback } = {}) {
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback;
    throw HttpError.badRequest(`${name} is required`, { field: name });
  }
  const n = Number(value);
  if (!Number.isFinite(n) || (int && !Number.isInteger(n)) || n < min || n > max) {
    const range = max === Infinity ? `at least ${min}` : `between ${min} and ${max}`;
    throw HttpError.badRequest(`${name} must be ${int ? 'a whole number' : 'a number'} ${range}`, { field: name });
  }
  return n;
}

export function oneOf(value, name, allowed, fallback) {
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback;
    throw HttpError.badRequest(`${name} is required`, { field: name });
  }
  if (!allowed.includes(value)) {
    throw HttpError.badRequest(`${name} must be one of: ${allowed.join(', ')}`, { field: name });
  }
  return value;
}

export function text(value, name, { max = 200, required = false, fallback = null } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (!s) {
    if (required) throw HttpError.badRequest(`${name} is required`, { field: name });
    return fallback;
  }
  if (s.length > max) throw HttpError.badRequest(`${name} must be ${max} characters or fewer`, { field: name });
  return s;
}

/**
 * Canonical phone: '+960 XXX XXXX' for Maldivian numbers, '+<digits>' for
 * anything foreign. Null when it cannot be a phone number at all. One stored
 * shape is what lets a receptionist find "7000031" typed without spaces.
 */
export function normalisePhone(raw) {
  let digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  const plus = digits.startsWith('+');
  digits = digits.replace(/\D/g, '');
  if (!plus && digits.length === 7) digits = `960${digits}`;
  if (digits.startsWith('960') && digits.length === 10) return `+960 ${digits.slice(3, 6)} ${digits.slice(6)}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

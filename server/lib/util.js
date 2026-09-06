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

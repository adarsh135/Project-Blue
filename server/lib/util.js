import crypto from 'node:crypto';

export const now = () => new Date().toISOString();

export const id = (prefix = '') =>
  (prefix ? `${prefix}_` : '') + crypto.randomBytes(12).toString('base64url');

export const uuid = () => crypto.randomUUID();

/** Normalise an email for storage / lookup. */
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));

export const truncate = (s, n = 200) =>
  String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? '');

export function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Constant-time string compare that tolerates length differences. */
export function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  const len = Math.max(ab.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ab.copy(pa);
  bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && ab.length === bb.length;
}

export const escapeHtml = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Very small logger with consistent formatting. */
export function log(scope, ...args) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${scope.padEnd(12)}`, ...args);
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

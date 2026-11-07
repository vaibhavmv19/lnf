'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readRaw(req, limit = 2_500_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'That upload is too large. Please use smaller photos.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const raw = await readRaw(req, limit);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) bits.push('HttpOnly');
  bits.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure) bits.push('Secure');
  return bits.join('; ');
}

function sendFile(req, res, filePath, options = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': options.cache || 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function randomId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function createLimiter() {
  const buckets = new Map();
  return function limit(key, max, windowMs) {
    const now = Date.now();
    const list = (buckets.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (list.length >= max) {
      buckets.set(key, list);
      throw new HttpError(429, 'Too many attempts. Please try again in a little while.');
    }
    list.push(now);
    buckets.set(key, list);
    if (buckets.size > 4000) buckets.clear();
  };
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 160 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value);
}

function cleanText(value, max = 240) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanMultiline(value, max = 2000) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().slice(0, max);
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function daysAgoIso(days) {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString();
}

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

module.exports = {
  HttpError,
  MIME,
  sendJson,
  readRaw,
  readJson,
  parseCookies,
  serializeCookie,
  sendFile,
  randomId,
  clamp,
  slugify,
  createLimiter,
  isValidEmail,
  cleanText,
  cleanMultiline,
  isIsoDate,
  daysAgoIso,
  dateOnly,
};

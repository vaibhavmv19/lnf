'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env support so Google sign-in can be configured without a dependency.
function loadDotEnv() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

loadDotEnv();

const store = require('./server/store');
const { PUBLIC_DIR, getDb } = store;
const { sendFile, sendJson } = require('./server/util');
const { handleApi } = require('./server/api');

const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || '0.0.0.0';

const PAGES = {
  '/': 'index.html',
  '/explore': 'explore.html',
  '/lost': 'lost.html',
  '/found': 'found.html',
  '/saved': 'saved.html',
  '/post': 'post.html',
  '/matches': 'matches.html',
  '/messages': 'messages.html',
  '/notifications': 'notifications.html',
  '/settings': 'settings.html',
  '/leaderboard': 'leaderboard.html',
  '/admin': 'admin.html',
  '/login': 'auth.html',
  '/signup': 'auth.html',
  '/auth': 'auth.html',
  '/404': '404.html',
};

const DYNAMIC_PAGES = [
  [/^\/item\/[a-zA-Z0-9_-]+\/?$/, 'item.html'],
  [/^\/messages\/[a-zA-Z0-9_-]+\/?$/, 'conversation.html'],
  [/^\/profile\/[a-zA-Z0-9_.-]+\/?$/, 'profile.html'],
  [/^\/collect\/[a-zA-Z0-9_.-]+\/?$/, 'collect.html'],
];

const STATIC_PREFIXES = ['/css/', '/js/', '/uploads/', '/assets/'];

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function sendPage(res, file, status = 200) {
  const target = path.join(PUBLIC_DIR, file);
  try {
    const html = fs.readFileSync(target);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-cache',
    });
    res.end(html);
  } catch (error) {
    console.error('[pages]', target, error.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page template missing.');
  }
}

function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!target.startsWith(PUBLIC_DIR)) return null;
  return target;
}

function seedIfEmpty() {
  try {
    const db = getDb();
    if (db.users.length && db.listings.length) return;
    const seed = require('./server/seed');
    if (typeof seed.seed === 'function') {
      seed.seed({ force: false });
      console.log('[seed] demo data created');
    }
  } catch (error) {
    console.error('[seed]', error.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, POST, PATCH, DELETE, HEAD, OPTIONS' });
    res.end();
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (handled) return;
    }

    const pathname = url.pathname;

    if (pathname === '/favicon.svg' || pathname === '/favicon.ico') {
      const file = path.join(PUBLIC_DIR, 'favicon.svg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end();
        return;
      }
      sendFile(req, res, file, { cache: 'public, max-age=86400' });
      return;
    }

    if (STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      const target = resolveStatic(pathname);
      if (!target) {
        sendJson(res, 403, { error: 'Forbidden.' });
        return;
      }
      const cache = pathname.startsWith('/uploads/') ? 'public, max-age=604800' : 'no-cache';
      sendFile(req, res, target, { cache });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }

    const cleanPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
    if (PAGES[cleanPath]) {
      sendPage(res, PAGES[cleanPath]);
      return;
    }
    for (const [pattern, file] of DYNAMIC_PAGES) {
      if (pattern.test(cleanPath)) {
        sendPage(res, file);
        return;
      }
    }

    if (cleanPath === '/health') {
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
      return;
    }

    sendPage(res, '404.html', 404);
  } catch (error) {
    console.error('[server]', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
    else res.end();
  }
});

async function shutdown() {
  try {
    await store.flush();
  } catch {
    /* best effort */
  }
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

let readyPromise = null;
async function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await store.init();
      seedIfEmpty();
    })().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

// Vercel / serverless entry: initialise on first request, then delegate.
async function handler(req, res) {
  try {
    await ensureReady();
  } catch (error) {
    console.error('[init]', error);
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Service is starting up. Please retry.' }));
    }
    return;
  }
  return server.listeners('request')[0](req, res);
}

async function start() {
  await ensureReady();
  server.listen(PORT, HOST, () => {
    console.log(`Lost N Found running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[start]', error);
    process.exit(1);
  });
}

module.exports = handler;
module.exports.server = server;
module.exports.handler = handler;

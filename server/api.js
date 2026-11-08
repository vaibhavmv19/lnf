'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { getDb, save, UPLOAD_DIR } = require('./store');
const {
  currentUser,
  requireUser,
  requireAdmin,
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
  publicUser,
  findOrCreateGoogleUser,
} = require('./auth');
const {
  HttpError,
  readJson,
  sendJson,
  randomId,
  clamp,
  cleanText,
  cleanMultiline,
  isValidEmail,
  isIsoDate,
  createLimiter,
} = require('./util');
const { scorePair, confidenceLabel, confidenceTier, THRESHOLDS } = require('./matching');
const { CATEGORY_GLYPH } = require('./svgart');
const collection = require('./collection');
const { qrSvg } = require('./qr');
const {
  verifyGoogleCredential,
  buildAuthUrl,
  exchangeCode,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_DOMAIN,
} = require('./google-auth');

const CATEGORIES = Object.keys(CATEGORY_GLYPH);
const CAMPUS_NAME = process.env.CAMPUS_NAME || 'RVU Mysore';
const REPORT_REASONS = [
  'Possible scam or fraud',
  'Inappropriate or unsafe content',
  'Spam or duplicate listing',
  'Harassment or abusive messages',
  'Item listed in the wrong category',
  'Something else',
];
const COLORS = [
  'black', 'white', 'grey', 'silver', 'blue', 'navy', 'teal', 'green', 'olive',
  'yellow', 'gold', 'orange', 'red', 'maroon', 'pink', 'purple', 'brown', 'beige', 'clear',
];

const limitAuth = createLimiter();
const limitPost = createLimiter();
const limitMessage = createLimiter();
const limitReport = createLimiter();

/* ------------------------------------------------------------------ helpers */

function touch() {
  save();
}

function ip(req) {
  return (req.socket && req.socket.remoteAddress) || 'local';
}

function originOf(req) {
  const configured = configuredOrigin();
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return proto + '://' + String(host).split(',')[0].trim();
}

function findListing(id) {
  return getDb().listings.find((listing) => listing.id === id) || null;
}

function findByUsername(username) {
  const needle = String(username || '').toLowerCase();
  return getDb().users.find((user) => user.username.toLowerCase() === needle) || null;
}

function notify(userId, type, title, body, referenceId) {
  if (!userId) return;
  const db = getDb();
  db.notifications.unshift({
    id: randomId('n_'),
    userId,
    type,
    title,
    body,
    referenceId: referenceId || null,
    isRead: false,
    createdAt: new Date().toISOString(),
  });
  if (db.notifications.length > 500) db.notifications.length = 500;
}

function unreadCount(userId) {
  return getDb().notifications.filter((item) => item.userId === userId && !item.isRead).length;
}

function achievementsFor(user) {
  const db = getDb();
  const posts = db.listings.filter((listing) => listing.userId === user.id).length;
  const returns = user.successfulReturns || 0;
  const list = [];
  if (posts >= 1) list.push({ id: 'first-post', label: 'First report', description: 'Shared a first lost or found listing.' });
  if (posts >= 5) list.push({ id: 'five-posts', label: 'Regular reporter', description: 'Five listings shared with the community.' });
  if (returns >= 1) list.push({ id: 'first-return', label: 'First reunion', description: 'Helped return something to its owner.' });
  if (returns >= 3) list.push({ id: 'three-returns', label: 'Trusted finder', description: 'Three verified reunions and counting.' });
  if ((user.reputation || 0) >= 50) list.push({ id: 'reputation', label: 'Community pillar', description: 'Recognised for helpful, careful behaviour.' });
  return list;
}

function collectionRecord(listing, viewer) {
  const c = listing.collection;
  if (!c || !c.confirmedAt) return null;
  const db = getDb();
  const collector = db.users.find((user) => user.id === c.collectorId) || null;
  const visible = Boolean(
    viewer && (viewer.id === c.collectorId || viewer.id === listing.userId || viewer.role === 'admin'),
  );
  return {
    confirmedAt: c.confirmedAt,
    verified: Boolean(c.confirmedById),
    collector: visible && collector ? { username: collector.username, fullName: collector.fullName } : null,
    visible,
  };
}

function listingDto(listing, viewer) {
  const db = getDb();
  const owner = db.users.find((user) => user.id === listing.userId) || null;
  const isOwner = Boolean(viewer && viewer.id === listing.userId);
  const canEdit = Boolean(viewer && (isOwner || viewer.role === 'admin'));
  const dto = {
    id: listing.id,
    type: listing.type,
    title: listing.title,
    description: listing.description,
    category: listing.category,
    brand: listing.brand || '',
    color: listing.color || '',
    city: listing.city,
    area: listing.area || '',
    incidentDate: listing.incidentDate,
    status: listing.status,
    reward: listing.reward || 0,
    createdAt: listing.createdAt,
    returnedAt: listing.returnedAt || null,
    images: Array.isArray(listing.images) ? listing.images : [],
    image: (listing.images || [])[0] || null,
    owner: owner
      ? {
          username: owner.username,
          fullName: owner.fullName,
          city: owner.city || '',
          avatarUrl: owner.avatarUrl || null,
          reputation: owner.reputation || 0,
          successfulReturns: owner.successfulReturns || 0,
        }
      : null,
    isOwner,
    saved: Boolean(viewer && db.saved.some((entry) => entry.userId === viewer.id && entry.listingId === listing.id)),
    claimCount: (listing.claims || []).length,
    canEdit,
    hasPrivateDetail: Boolean(listing.privateDetail),
    collected: Boolean(listing.collection && listing.collection.confirmedAt),
    canCollect: collection.canCollect(listing, viewer),
    collection: collectionRecord(listing, viewer),
  };
  if (canEdit) dto.privateDetail = listing.privateDetail || '';
  return dto;
}

function listingSearchText(listing) {
  return [listing.title, listing.description, listing.brand, listing.color, listing.city, listing.area, listing.category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function queryListings(params, viewer) {
  const db = getDb();
  const q = cleanText(params.get('q') || '', 120).toLowerCase();
  const type = params.get('type') || '';
  const category = params.get('category') || '';
  const city = cleanText(params.get('city') || '', 80).toLowerCase();
  const owner = (params.get('owner') || '').toLowerCase();
  const status = params.get('status') || '';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const sort = params.get('sort') || 'recent';
  const saved = params.get('saved') === '1';
  const mine = params.get('mine') === '1';

  let items = db.listings.slice();

  if (!status) items = items.filter((listing) => listing.status !== 'removed');
  else items = items.filter((listing) => listing.status === status);
  if (type) items = items.filter((listing) => listing.type === type);
  if (category) items = items.filter((listing) => listing.category === category);
  if (city) items = items.filter((listing) => String(listing.city || '').toLowerCase().includes(city));
  if (from && isIsoDate(from)) items = items.filter((listing) => listing.incidentDate >= from);
  if (to && isIsoDate(to)) items = items.filter((listing) => listing.incidentDate <= to);
  if (owner) {
    const user = findByUsername(owner);
    items = items.filter((listing) => user && listing.userId === user.id);
  }
  if (mine) {
    if (!viewer) throw new HttpError(401, 'Please sign in to see your listings.');
    items = items.filter((listing) => listing.userId === viewer.id);
  }
  if (saved) {
    if (!viewer) throw new HttpError(401, 'Please sign in to see saved items.');
    const ids = new Set(db.saved.filter((entry) => entry.userId === viewer.id).map((entry) => entry.listingId));
    items = items.filter((listing) => ids.has(listing.id));
  }
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    items = items.filter((listing) => {
      const text = listingSearchText(listing);
      return tokens.every((token) => text.includes(token));
    });
  }

  if (sort === 'oldest') items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  else if (sort === 'returned') {
    items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'returned' ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  } else if (sort === 'relevant' && q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    const weight = (listing) => {
      const title = String(listing.title || '').toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (title.includes(token)) score += 3;
        if (String(listing.category || '').toLowerCase().includes(token)) score += 2;
        if (String(listing.city || '').toLowerCase().includes(token)) score += 2;
        if (String(listing.description || '').toLowerCase().includes(token)) score += 1;
      }
      if (listing.status === 'active') score += 1;
      return score;
    };
    items.sort((a, b) => weight(b) - weight(a) || b.createdAt.localeCompare(a.createdAt));
  } else {
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const total = items.length;
  const offset = clamp(params.get('offset') || 0, 0, 5000);
  const limit = clamp(params.get('limit') || 24, 1, 48);
  const page = items.slice(offset, offset + limit);
  return { items: page.map((listing) => listingDto(listing, viewer)), total, hasMore: offset + page.length < total };
}

function confidenceFor(score) {
  return { label: confidenceLabel(score), tier: confidenceTier(score) };
}

function matchDto(match, viewer) {
  const db = getDb();
  const lost = db.listings.find((listing) => listing.id === match.lostListingId);
  const found = db.listings.find((listing) => listing.id === match.foundListingId);
  if (!lost || !found) return null;
  return {
    id: match.id,
    score: match.similarityScore,
    parts: match.parts,
    status: match.status,
    createdAt: match.createdAt,
    ...confidenceFor(match.similarityScore),
    lost: listingDto(lost, viewer),
    found: listingDto(found, viewer),
    isParticipant: Boolean(viewer && (lost.userId === viewer.id || found.userId === viewer.id)),
  };
}

function upsertMatch(lost, found) {
  const db = getDb();
  const existing = db.matches.find(
    (match) =>
      (match.lostListingId === lost.id && match.foundListingId === found.id) ||
      (match.lostListingId === found.id && match.foundListingId === lost.id),
  );
  const { total, parts } = scorePair(lost, found);
  if (total < THRESHOLDS.suggest) {
    if (existing && existing.status === 'suggested' && existing.similarityScore < THRESHOLDS.suggest) {
      db.matches = db.matches.filter((match) => match.id !== existing.id);
    }
    return null;
  }
  if (existing) {
    existing.similarityScore = total;
    existing.parts = parts;
    return { match: existing, created: false };
  }
  const match = {
    id: randomId('m_'),
    lostListingId: lost.id,
    foundListingId: found.id,
    similarityScore: total,
    parts,
    status: 'suggested',
    createdAt: new Date().toISOString(),
  };
  db.matches.push(match);
  return { match, created: true };
}

function runMatchingFor(listing) {
  const db = getDb();
  const results = [];
  for (const other of db.listings) {
    if (other.id === listing.id) continue;
    if (other.status === 'removed' || listing.status === 'removed') continue;
    if (other.type === listing.type) continue;
    const lost = listing.type === 'lost' ? listing : other;
    const found = listing.type === 'found' ? listing : other;
    const outcome = upsertMatch(lost, found);
    if (!outcome) continue;
    results.push(outcome);
    if (outcome.created && outcome.match.similarityScore >= THRESHOLDS.notify) {
      const { label } = confidenceFor(outcome.match.similarityScore);
      for (const ownerId of [lost.userId, found.userId]) {
        if (ownerId === listing.userId) continue;
        notify(
          ownerId,
          'match',
          `${label} for “${other.title}”`,
          `A ${other.type} listing in ${other.city} looks similar. Verify a private detail before arranging a handover.`,
          outcome.match.id,
        );
      }
    }
  }
  return results;
}

function saveDataImage(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'One of the photos could not be read.');
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(raw.trim());
  if (!match) throw new HttpError(400, 'Photos must be JPEG, PNG or WebP images.');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < 400) throw new HttpError(400, 'That photo looks empty. Try another one.');
  if (buffer.length > 2_600_000) throw new HttpError(413, 'Each photo must be under 2.5 MB.');
  const kind = match[1] === 'jpg' ? 'jpeg' : match[1];
  const valid =
    (kind === 'jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (kind === 'png' && buffer.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) ||
    (kind === 'webp' && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP');
  if (!valid) throw new HttpError(400, 'That file is not a valid image.');
  const ext = kind === 'jpeg' ? 'jpg' : kind;
  const name = `${randomId()}.${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return `/uploads/${name}`;
}

function signatureOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 48) return null;
  const values = raw.map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return null;
  return values.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000);
}

function requireListing(id) {
  const listing = findListing(id);
  if (!listing || listing.status === 'removed') throw new HttpError(404, 'That listing could not be found.');
  return listing;
}

function canManage(listing, viewer) {
  return Boolean(viewer && (listing.userId === viewer.id || viewer.role === 'admin'));
}

/* -------------------------------------------------------------------- routes */

const routes = [];
function route(method, pattern, handler, options = {}) {
  routes.push({ method, pattern, handler, limit: options.limit });
}

/* auth */

// Values copied from .env.example must count as "not configured": sending the
// literal placeholder to Google only yields a 401 invalid_client page, which
// looks like an app bug instead of a missing-credentials problem.
function looksLikePlaceholder(value) {
  const v = String(value || '').trim().toLowerCase();
  return !v || v.includes('your-client-id') || v.includes('your-client-secret') || v === 'changeme';
}

const GOOGLE_CONFIGURED =
  !looksLikePlaceholder(GOOGLE_CLIENT_ID) && !looksLikePlaceholder(GOOGLE_CLIENT_SECRET);

route('GET', /^\/api\/auth\/config\/?$/, async () => ({
  googleClientId: GOOGLE_CONFIGURED ? GOOGLE_CLIENT_ID : null,
  googleDomain: GOOGLE_DOMAIN,
  googleEnabled: GOOGLE_CONFIGURED,
}));

const OAUTH_STATES = new Map();

function safeNextPath(value) {
  const target = String(value || '');
  return /^\/(?!\/)/.test(target) ? target : '/';
}

// The redirect URI has to match the one used when redeeming the code, so it is
// derived from the request host (loopback only, never a spoofed Host header).
function configuredOrigin() {
  const raw = String(process.env.APP_ORIGIN || process.env.PUBLIC_URL || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function appOrigin(req) {
  const configured = configuredOrigin();
  if (configured) return configured;
  const host = String((req && (req.headers['x-forwarded-host'] || req.headers.host)) || '');
  if (/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i.test(host.split(',')[0].trim())) {
    return `http://${host.split(',')[0].trim()}`;
  }
  if (host) {
    const proto = String((req.headers['x-forwarded-proto'] || 'https')).split(',')[0].trim() || 'https';
    return proto + '://' + host.split(',')[0].trim();
  }
  return 'http://localhost:3000';
}

// Backwards-compatible name used elsewhere in this file.
function loopbackOrigin(req) { return appOrigin(req); }

route('GET', /^\/api\/auth\/google\/start\/?$/, async ({ req, res, url, viewer }) => {
  limitAuth(`google-start:${ip(req)}`, 40, 10 * 60 * 1000);
  const next = safeNextPath(url.searchParams.get('next'));
  const redirect = (location) => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  };

  if (!GOOGLE_CONFIGURED) {
    return redirect('/auth?error=' + encodeURIComponent('Google sign-in is not configured on this copy.'));
  }
  if (viewer) return redirect(next);

  const now = Date.now();
  for (const [key, entry] of OAUTH_STATES) {
    if (entry.expires < now) OAUTH_STATES.delete(key);
  }
  const state = crypto.randomBytes(16).toString('hex');
  OAUTH_STATES.set(state, { next, expires: now + 10 * 60 * 1000 });

  const redirectUri = loopbackOrigin(req) + '/api/auth/google/callback';
  return redirect(buildAuthUrl(state, redirectUri));
});

route('GET', /^\/api\/auth\/google\/callback\/?$/, async ({ req, res, url }) => {
  const redirect = (location) => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  };
  const fail = (message) => redirect('/auth?error=' + encodeURIComponent(message));

  const state = url.searchParams.get('state') || '';
  const entry = OAUTH_STATES.get(state);
  OAUTH_STATES.delete(state);
  if (!entry || entry.expires < Date.now()) return fail('That sign-in link expired. Please try again.');
  if (url.searchParams.get('error')) return fail('Google sign-in was cancelled.');

  const code = url.searchParams.get('code') || '';
  if (!code) return fail('Google did not return an authorisation code.');

  try {
    const redirectUri = loopbackOrigin(req) + '/api/auth/google/callback';
    const idToken = await exchangeCode(code, redirectUri);
    const profile = await verifyGoogleCredential(idToken);
    const user = findOrCreateGoogleUser(profile);
    createSession(res, user.id);
  } catch (error) {
    return fail(error.message || 'That Google account cannot sign in here.');
  }

  return redirect(entry.next);
});

route('POST', /^\/api\/auth\/logout\/?$/, async ({ req, res }) => {
  destroySession(req, res);
  return { ok: true };
});

route('GET', /^\/api\/auth\/me\/?$/, async ({ req, viewer }) => {
  if (!viewer) return { user: null, unread: 0, savedIds: [], achievements: [] };
  const db = getDb();
  return {
    user: publicUser(viewer, viewer),
    unread: unreadCount(viewer.id),
    savedIds: db.saved.filter((entry) => entry.userId === viewer.id).map((entry) => entry.listingId),
    achievements: achievementsFor(viewer),
  };
});

/* meta + stats */

route('GET', /^\/api\/meta\/?$/, async () => {
  const db = getDb();
  const counts = new Map();
  for (const listing of db.listings) {
    if (listing.status === 'removed') continue;
    counts.set(listing.category, (counts.get(listing.category) || 0) + 1);
  }
  const cities = [...new Set(db.listings.map((listing) => listing.city).filter(Boolean))].sort();
  return {
    categories: CATEGORIES.map((name) => ({ name, count: counts.get(name) || 0 })),
    cities,
    colors: COLORS,
    reportReasons: REPORT_REASONS,
    thresholds: THRESHOLDS,
  };
});

route('GET', /^\/api\/stats\/?$/, async () => {
  const db = getDb();
  const active = db.listings.filter((listing) => listing.status !== 'removed');
  return {
    listings: active.length,
    lost: active.filter((listing) => listing.type === 'lost').length,
    found: active.filter((listing) => listing.type === 'found').length,
    reunited: active.filter((listing) => listing.status === 'returned').length,
    members: db.users.length,
    cities: new Set(active.map((listing) => listing.city)).size,
    matches: db.matches.length,
  };
});

/* listings */

route('GET', /^\/api\/listings\/?$/, async ({ url, viewer }) => queryListings(url.searchParams, viewer));

route('GET', /^\/api\/listings\/(?<id>[^/]+)\/?$/, async ({ params, viewer }) => {
  const listing = requireListing(params.id);
  const db = getDb();
  const related = db.listings
    .filter(
      (entry) =>
        entry.id !== listing.id &&
        entry.status === 'active' &&
        entry.category === listing.category &&
        entry.type === listing.type,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4)
    .map((entry) => listingDto(entry, viewer));

  let myMatch = null;
  if (viewer) {
    const candidates = db.matches
      .filter(
        (match) =>
          (match.lostListingId === listing.id || match.foundListingId === listing.id) && match.status !== 'dismissed',
      )
      .sort((a, b) => b.similarityScore - a.similarityScore);
    for (const match of candidates) {
      const otherId = match.lostListingId === listing.id ? match.foundListingId : match.lostListingId;
      const other = db.listings.find((entry) => entry.id === otherId);
      if (!other) continue;
      if (other.userId !== viewer.id && listing.userId !== viewer.id) continue;
      myMatch = matchDto(match, viewer);
      break;
    }
  }

  return { item: listingDto(listing, viewer), related, match: myMatch };
});

route('POST', /^\/api\/listings\/?$/, async ({ req, viewer, body }) => {
  const user = requireUser(req);
  limitPost(`post:${user.id}`, 25, 60 * 60 * 1000);

  const type = body.type === 'found' ? 'found' : 'lost';
  const title = cleanText(body.title, 120);
  const description = cleanMultiline(body.description, 2000);
  const category = CATEGORIES.includes(body.category) ? body.category : 'Other';
  const city = cleanText(body.city, 80) || CAMPUS_NAME;
  const area = cleanText(body.location, 120) || cleanText(body.area, 120);
  const brand = cleanText(body.brand, 60);
  const color = cleanText(body.color, 40);
  const incidentDate = isIsoDate(body.incidentDate) ? body.incidentDate : new Date().toISOString().slice(0, 10);
  const reward = clamp(body.reward || 0, 0, 100000);
  const privateDetail = cleanMultiline(body.privateDetail, 500);

  if (title.length < 4) throw new HttpError(400, 'Give the item a short, clear title.');
  if (description.length < 12) throw new HttpError(400, 'Add a little more description so people can recognise it.');
  if (!area) throw new HttpError(400, 'Where on campus was it lost or found?');
  if (privateDetail.length < 6) {
    throw new HttpError(400, 'Add one private detail that only the owner would know.');
  }

  const rawImages = Array.isArray(body.images) ? body.images.slice(0, 5) : [];
  const images = rawImages.map((image) => ({
    url: saveDataImage(image && image.data),
    aspect: clamp(image && image.aspect ? image.aspect : 0.8, 0.4, 1.9),
  }));
  if (!images.length) throw new HttpError(400, 'Add at least one photo so people can recognise the item.');

  const signature = signatureOf(body.signature) || signatureOf(rawImages[0] && rawImages[0].signature);

  const listing = {
    id: randomId('l_'),
    userId: user.id,
    type,
    title,
    description,
    category,
    brand,
    color,
    city,
    area,
    incidentDate,
    status: 'active',
    reward: Math.round(reward),
    privateDetail,
    images,
    imageSignature: signature,
    claims: [],
    createdAt: new Date().toISOString(),
  };
  getDb().listings.unshift(listing);
  touch();

  const results = runMatchingFor(listing);
  touch();
  return { item: listingDto(listing, viewer), matches: results.filter((entry) => entry.created).length };
});

route('PATCH', /^\/api\/listings\/(?<id>[^/]+)\/?$/, async ({ req, params, viewer, body }) => {
  const user = requireUser(req);
  const listing = requireListing(params.id);
  if (!canManage(listing, viewer)) throw new HttpError(403, 'You can only edit your own listings.');

  if (body.title !== undefined) {
    const title = cleanText(body.title, 120);
    if (title.length < 4) throw new HttpError(400, 'Give the item a short, clear title.');
    listing.title = title;
  }
  if (body.description !== undefined) {
    const description = cleanMultiline(body.description, 2000);
    if (description.length < 12) throw new HttpError(400, 'Add a little more description.');
    listing.description = description;
  }
  if (body.category !== undefined && CATEGORIES.includes(body.category)) listing.category = body.category;
  if (body.city !== undefined) listing.city = cleanText(body.city, 80) || listing.city;
  if (body.area !== undefined) listing.area = cleanText(body.area, 120);
  if (body.location !== undefined) listing.area = cleanText(body.location, 120);
  if (body.brand !== undefined) listing.brand = cleanText(body.brand, 60);
  if (body.color !== undefined) listing.color = cleanText(body.color, 40);
  if (body.incidentDate !== undefined && isIsoDate(body.incidentDate)) listing.incidentDate = body.incidentDate;
  if (body.reward !== undefined) listing.reward = Math.round(clamp(body.reward, 0, 100000));
  if (body.privateDetail !== undefined && cleanMultiline(body.privateDetail, 500).length >= 6) {
    listing.privateDetail = cleanMultiline(body.privateDetail, 500);
  }
  if (body.status === 'active' || body.status === 'returned') listing.status = body.status;
  if (Array.isArray(body.images) && body.images.length) {
    listing.images = body.images
      .slice(0, 5)
      .map((image) => {
        if (image && image.data) return { url: saveDataImage(image.data), aspect: clamp(image.aspect || 0.8, 0.4, 1.9) };
        const url = String((image && image.url) || '');
        if (!url.startsWith('/uploads/')) return null;
        return { url, aspect: clamp(image.aspect || 0.8, 0.4, 1.9) };
      })
      .filter(Boolean);
    if (!listing.images.length) throw new HttpError(400, 'Add at least one photo so people can recognise the item.');
    const signature = signatureOf(body.signature) || signatureOf(body.images[0] && body.images[0].signature);
    if (signature) listing.imageSignature = signature;
  }

  touch();
  const results = runMatchingFor(listing);
  touch();
  return { item: listingDto(listing, viewer), matches: results.length };
});

route('DELETE', /^\/api\/listings\/(?<id>[^/]+)\/?$/, async ({ req, params, viewer }) => {
  requireUser(req);
  const listing = requireListing(params.id);
  if (!canManage(listing, viewer)) throw new HttpError(403, 'You can only remove your own listings.');
  listing.status = 'removed';
  listing.removedAt = new Date().toISOString();
  getDb().matches = getDb().matches.filter(
    (match) => match.lostListingId !== listing.id && match.foundListingId !== listing.id,
  );
  touch();
  return { ok: true };
});

route('POST', /^\/api\/listings\/(?<id>[^/]+)\/claim\/?$/, async ({ req, params, viewer, body }) => {
  const user = requireUser(req);
  const listing = requireListing(params.id);
  if (listing.userId === user.id) throw new HttpError(400, 'This is your own listing.');
  const message = cleanMultiline(body.message, 600);
  if (message.length < 10) throw new HttpError(400, 'Describe a detail that helps verify this is yours.');

  listing.claims = listing.claims || [];
  if (listing.claims.some((claim) => claim.userId === user.id)) {
    throw new HttpError(409, 'You already sent a claim for this item.');
  }
  listing.claims.push({ userId: user.id, message, createdAt: new Date().toISOString() });
  notify(
    listing.userId,
    'claim',
    `Claim on “${listing.title}”`,
    `${user.fullName} says this might be theirs. Review the claim and verify a private detail before handover.`,
    listing.id,
  );
  touch();
  return { ok: true, claimCount: listing.claims.length };
});

route('POST', /^\/api\/listings\/(?<id>[^/]+)\/resolve\/?$/, async ({ req, params, viewer, body }) => {
  requireUser(req);
  const listing = requireListing(params.id);
  if (!canManage(listing, viewer)) throw new HttpError(403, 'Only the person who posted this can confirm a return.');
  if (listing.status === 'returned') return { item: listingDto(listing, viewer) };

  listing.status = 'returned';
  listing.returnedAt = new Date().toISOString();
  listing.returnNote = cleanText(body.note, 300);

  const db = getDb();
  const owner = db.users.find((entry) => entry.id === listing.userId);
  if (owner) {
    owner.successfulReturns = (owner.successfulReturns || 0) + (listing.type === 'found' ? 1 : 0);
    owner.reputation = (owner.reputation || 0) + 10;
  }
  for (const claim of listing.claims || []) {
    notify(claim.userId, 'returned', `“${listing.title}” was marked returned`, 'Thanks for helping. If this was your item, we are glad it is home.', listing.id);
  }
  notify(listing.userId, 'returned', `“${listing.title}” is home`, 'Thanks for closing the loop. Your reputation grew by 10 points.', listing.id);
  touch();
  return { item: listingDto(listing, viewer) };
});

/* collection passes: the QR shown when an item is handed over */

route('POST', /^\/api\/listings\/(?<id>[^/]+)\/collection-pass\/?$/, async ({ req, params, viewer }) => {
  const user = requireUser(req);
  limitPost(`pass:${user.id}`, 20, 60 * 60 * 1000);
  const listing = requireListing(params.id);
  if (listing.collection && listing.collection.confirmedAt) {
    throw new HttpError(409, 'The handover for this item has already been confirmed.');
  }
  if (listing.status === 'returned') throw new HttpError(409, 'This item is already marked as returned.');
  if (!collection.canCollect(listing, user)) {
    throw new HttpError(
      403,
      listing.type === 'found'
        ? 'The person collecting this item shows the QR. You are holding it, so open their code instead.'
        : 'Only the person who lost this item can show a collection QR.',
    );
  }

  const { pass, token } = collection.issuePass(listing, user);
  touch();
  return {
    item: listingDto(listing, viewer),
    pass: {
      token,
      expiresAt: pass.expiresAt,
      url: originOf(req) + '/collect/' + token,
    },
  };
});

route('GET', /^\/api\/collection\/(?<token>[^/]+)\/?$/, async ({ req, params, viewer }) => {
  const pass = collection.findPass(params.token);
  if (!pass) throw new HttpError(404, 'That collection code is not valid.');
  const db = getDb();
  const listing = db.listings.find((entry) => entry.id === pass.listingId);
  if (!listing || listing.status === 'removed') throw new HttpError(404, 'That listing is no longer available.');
  const collector = db.users.find((entry) => entry.id === pass.collectorId) || null;
  const status = collection.passStatus(pass);
  const permitted = collection.canConfirm(pass, listing, viewer);
  const isCollector = Boolean(viewer && viewer.id === pass.collectorId);
  const identityVisible = Boolean(
    viewer && (isCollector || permitted || viewer.id === listing.userId || viewer.role === 'admin'),
  );
  if (status === 'pending' && permitted && !pass.verifiedAt) {
    pass.verifiedAt = new Date().toISOString();
    touch();
  }

  const record = listing.collection;
  return {
    pass: {
      status,
      issuedAt: pass.issuedAt,
      expiresAt: pass.expiresAt,
      confirmedAt: pass.confirmedAt || null,
    },
    listing: {
      id: listing.id,
      title: listing.title,
      type: listing.type,
      status: listing.status,
      city: listing.city,
      area: listing.area || '',
      image: (listing.images || [])[0] || null,
    },
    collector: collector
      ? {
          username: collector.username,
          fullName: collector.fullName,
          avatarUrl: collector.avatarUrl || null,
          city: collector.city || '',
          reputation: collector.reputation || 0,
          successfulReturns: collector.successfulReturns || 0,
          email: identityVisible ? collector.email : null,
          accountVerified: Boolean(pass.verifiedAt),
        }
      : null,
    viewer: { signedIn: Boolean(viewer), isCollector, canConfirm: permitted },
    record:
      record && record.confirmedAt
        ? {
            confirmedAt: record.confirmedAt,
            collectorName: identityVisible && collector ? collector.fullName : null,
            points: pass.pointsAwarded || 0,
          }
        : null,
  };
});

route('POST', /^\/api\/collection\/(?<token>[^/]+)\/confirm\/?$/, async ({ req, params, viewer }) => {
  const user = requireUser(req);
  const pass = collection.findPass(params.token);
  if (!pass) throw new HttpError(404, 'That collection code is not valid.');

  const db = getDb();
  const listing = db.listings.find((entry) => entry.id === pass.listingId);
  if (!listing || listing.status === 'removed') throw new HttpError(404, 'That listing is no longer available.');

  const status = collection.passStatus(pass);
  if (status === 'confirmed') throw new HttpError(409, 'This handover was already confirmed.');
  if (status === 'expired') {
    throw new HttpError(409, 'That collection code has expired. Ask the collector to show a fresh one.');
  }
  if (!collection.canConfirm(pass, listing, viewer)) {
    throw new HttpError(403, 'Only the person handing over the item can confirm this handover.');
  }

  const now = new Date().toISOString();
  pass.status = 'confirmed';
  pass.confirmedAt = now;
  pass.confirmedById = user.id;
  pass.verifiedAt = pass.verifiedAt || now;
  pass.pointsAwarded = 10;

  listing.collection = {
    passId: pass.id,
    collectorId: pass.collectorId,
    confirmedById: user.id,
    confirmedAt: now,
  };
  listing.status = 'returned';
  listing.returnedAt = now;

  for (const other of db.passes || []) {
    if (other.listingId === listing.id && other.id !== pass.id && other.status === 'pending') {
      other.status = 'revoked';
      other.revokedAt = now;
    }
  }

  const helper = db.users.find((entry) => entry.id === user.id);
  if (helper) {
    helper.reputation = (helper.reputation || 0) + 10;
    helper.successfulReturns = (helper.successfulReturns || 0) + 1;
  }

  notify(
    pass.collectorId,
    'returned',
    `Handover confirmed for “${listing.title}”`,
    `${user.fullName} confirmed the handover. The listing is marked collected.`,
    listing.id,
  );
  notify(
    user.id,
    'returned',
    'Verified handover recorded',
    `Thanks for handing over “${listing.title}”. +10 points and one verified return.`,
    listing.id,
  );
  touch();
  return { item: listingDto(listing, viewer), points: 10, record: collectionRecord(listing, viewer) };
});

route('GET', /^\/api\/collection\/(?<token>[^/]+)\/qr\.svg$/, async ({ req, res, params }) => {
  const pass = collection.findPass(params.token);
  if (!pass) throw new HttpError(404, 'That collection code is not valid.');
  const svg = qrSvg(originOf(req) + '/collect/' + params.token, { size: 360 });
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(svg),
    'Cache-Control': 'no-store',
  });
  res.end(svg);
});

/* matches */

route('GET', /^\/api\/matches\/?$/, async ({ req, url, viewer }) => {
  requireUser(req);
  const db = getDb();
  const listingId = url.searchParams.get('listingId');
  const status = url.searchParams.get('status');

  let items = db.matches.slice();
  if (listingId) {
    const listing = requireListing(listingId);
    if (!canManage(listing, viewer)) throw new HttpError(403, 'You can only see matches for your own listings.');
    items = items.filter((match) => match.lostListingId === listing.id || match.foundListingId === listing.id);
  } else {
    const mine = new Set(db.listings.filter((listing) => listing.userId === viewer.id).map((listing) => listing.id));
    items = items.filter((match) => mine.has(match.lostListingId) || mine.has(match.foundListingId));
  }
  if (status) items = items.filter((match) => match.status === status);
  items.sort((a, b) => b.similarityScore - a.similarityScore);

  return {
    items: items.slice(0, 40).map((match) => matchDto(match, viewer)).filter(Boolean),
    total: items.length,
  };
});

route('POST', /^\/api\/matches\/run\/?$/, async ({ req, viewer }) => {
  requireUser(req);
  const db = getDb();
  const mine = db.listings.filter((listing) => listing.userId === viewer.id && listing.status === 'active');
  let created = 0;
  for (const listing of mine) {
    created += runMatchingFor(listing).filter((entry) => entry.created).length;
  }
  touch();
  return { created, checked: mine.length };
});

route('PATCH', /^\/api\/matches\/(?<id>[^/]+)\/?$/, async ({ req, params, viewer, body }) => {
  requireUser(req);
  const db = getDb();
  const match = db.matches.find((entry) => entry.id === params.id);
  if (!match) throw new HttpError(404, 'That suggestion no longer exists.');
  const lost = db.listings.find((entry) => entry.id === match.lostListingId);
  const found = db.listings.find((entry) => entry.id === match.foundListingId);
  if (!lost || !found) throw new HttpError(404, 'That suggestion no longer exists.');
  if (lost.userId !== viewer.id && found.userId !== viewer.id) {
    throw new HttpError(403, 'That suggestion belongs to another member.');
  }
  const status = body.status;
  if (!['suggested', 'confirmed', 'dismissed'].includes(status)) throw new HttpError(400, 'Unknown suggestion status.');
  match.status = status;
  match.updatedAt = new Date().toISOString();
  if (status === 'confirmed') {
    const otherOwnerId = lost.userId === viewer.id ? found.userId : lost.userId;
    notify(
      otherOwnerId,
      'match',
      `A possible match was flagged for “${lost.userId === viewer.id ? lost.title : found.title}”`,
      'The other member thinks this could be the same item. Verify a private detail in messages before meeting.',
      match.id,
    );
  }
  touch();
  return { item: matchDto(match, viewer) };
});

/* saved */

route('GET', /^\/api\/saved\/?$/, async ({ req, viewer }) => {
  requireUser(req);
  const db = getDb();
  const ids = new Set(db.saved.filter((entry) => entry.userId === viewer.id).map((entry) => entry.listingId));
  const items = db.listings
    .filter((listing) => ids.has(listing.id) && listing.status !== 'removed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items: items.map((listing) => listingDto(listing, viewer)), total: items.length };
});

route('POST', /^\/api\/saved\/?$/, async ({ req, viewer, body }) => {
  requireUser(req);
  const listing = requireListing(body.listingId);
  const db = getDb();
  if (!db.saved.some((entry) => entry.userId === viewer.id && entry.listingId === listing.id)) {
    db.saved.push({ userId: viewer.id, listingId: listing.id, createdAt: new Date().toISOString() });
    touch();
  }
  return { saved: true, total: db.saved.filter((entry) => entry.userId === viewer.id).length };
});

route('DELETE', /^\/api\/saved\/(?<id>[^/]+)\/?$/, async ({ req, params, viewer }) => {
  requireUser(req);
  const db = getDb();
  db.saved = db.saved.filter((entry) => !(entry.userId === viewer.id && entry.listingId === params.id));
  touch();
  return { saved: false };
});

/* conversations + messages */

function conversationDto(conversation, viewer) {
  const db = getDb();
  const listing = db.listings.find((entry) => entry.id === conversation.listingId) || null;
  const otherId = conversation.memberIds.find((id) => id !== viewer.id);
  const other = db.users.find((entry) => entry.id === otherId) || null;
  const messages = db.messages
    .filter((message) => message.conversationId === conversation.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = messages[messages.length - 1] || null;
  const unread = messages.filter((message) => message.senderId !== viewer.id && !message.readAt).length;
  return {
    id: conversation.id,
    listing: listing
      ? { id: listing.id, title: listing.title, type: listing.type, status: listing.status, image: (listing.images || [])[0] || null }
      : null,
    other: other
      ? { username: other.username, fullName: other.fullName, avatarUrl: other.avatarUrl || null, city: other.city || '' }
      : null,
    lastMessage: last ? { body: last.body, createdAt: last.createdAt, mine: last.senderId === viewer.id } : null,
    unread,
    updatedAt: conversation.updatedAt,
  };
}

route('GET', /^\/api\/messages\/?$/, async ({ req, viewer }) => {
  requireUser(req);
  const db = getDb();
  const items = db.conversations
    .filter((conversation) => conversation.memberIds.includes(viewer.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((conversation) => conversationDto(conversation, viewer));
  return { items, unread: items.reduce((total, item) => total + item.unread, 0) };
});

route('POST', /^\/api\/conversations\/?$/, async ({ req, viewer, body }) => {
  requireUser(req);
  const listing = requireListing(body.listingId);
  if (listing.userId === viewer.id) throw new HttpError(400, 'This is your own listing.');
  const db = getDb();
  const existing = db.conversations.find(
    (conversation) =>
      conversation.listingId === listing.id && conversation.memberIds.includes(viewer.id) && conversation.memberIds.includes(listing.userId),
  );
  const now = new Date().toISOString();
  let conversation = existing;
  if (!conversation) {
    conversation = {
      id: randomId('c_'),
      listingId: listing.id,
      memberIds: [viewer.id, listing.userId],
      createdAt: now,
      updatedAt: now,
    };
    db.conversations.push(conversation);
  }
  const text = cleanMultiline(body.body, 1200);
  if (text) {
    const message = {
      id: randomId('msg_'),
      conversationId: conversation.id,
      senderId: viewer.id,
      body: text,
      createdAt: now,
      readAt: null,
    };
    db.messages.push(message);
    conversation.updatedAt = now;
    notify(
      listing.userId,
      'message',
      `New message from ${viewer.fullName}`,
      text.slice(0, 140),
      conversation.id,
    );
  }
  touch();
  return { conversation: conversationDto(conversation, viewer) };
});

route('GET', /^\/api\/conversations\/(?<id>[^/]+)\/?$/, async ({ req, params, viewer }) => {
  requireUser(req);
  const db = getDb();
  const conversation = db.conversations.find((entry) => entry.id === params.id);
  if (!conversation) throw new HttpError(404, 'That conversation could not be found.');
  if (!conversation.memberIds.includes(viewer.id)) throw new HttpError(403, 'That conversation is not yours.');
  const now = new Date().toISOString();
  const messages = db.messages
    .filter((message) => message.conversationId === conversation.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((message) => {
      if (message.senderId !== viewer.id && !message.readAt) {
        message.readAt = now;
        return { id: message.id, body: message.body, createdAt: message.createdAt, mine: false, senderId: message.senderId };
      }
      return {
        id: message.id,
        body: message.body,
        createdAt: message.createdAt,
        mine: message.senderId === viewer.id,
        senderId: message.senderId,
      };
    });
  touch();
  const listing = db.listings.find((entry) => entry.id === conversation.listingId) || null;
  return {
    ...conversationDto(conversation, viewer),
    messages,
    listingDetail: listing ? listingDto(listing, viewer) : null,
  };
});

route('POST', /^\/api\/messages\/?$/, async ({ req, viewer, body }) => {
  requireUser(req);
  limitMessage(`msg:${viewer.id}`, 40, 5 * 60 * 1000);
  const db = getDb();
  const conversation = db.conversations.find((entry) => entry.id === body.conversationId);
  if (!conversation) throw new HttpError(404, 'That conversation could not be found.');
  if (!conversation.memberIds.includes(viewer.id)) throw new HttpError(403, 'That conversation is not yours.');
  const text = cleanMultiline(body.body, 1200);
  if (text.length < 1) throw new HttpError(400, 'Write a message first.');
  const now = new Date().toISOString();
  const message = {
    id: randomId('msg_'),
    conversationId: conversation.id,
    senderId: viewer.id,
    body: text,
    createdAt: now,
    readAt: null,
  };
  db.messages.push(message);
  conversation.updatedAt = now;
  const otherId = conversation.memberIds.find((id) => id !== viewer.id);
  notify(otherId, 'message', `New message from ${viewer.fullName}`, text.slice(0, 140), conversation.id);
  touch();
  return { item: { id: message.id, body: message.body, createdAt: message.createdAt, mine: true }, conversation: conversationDto(conversation, viewer) };
});

route('POST', /^\/api\/conversations\/(?<id>[^/]+)\/report\/?$/, async ({ req, params, viewer, body }) => {
  const user = requireUser(req);
  limitReport(`report:${user.id}`, 10, 60 * 60 * 1000);
  const conversation = getDb().conversations.find((entry) => entry.id === params.id);
  if (!conversation) throw new HttpError(404, 'That conversation could not be found.');
  if (!conversation.memberIds.includes(user.id)) throw new HttpError(403, 'That conversation is not yours.');
  const reason = REPORT_REASONS.includes(body.reason) ? body.reason : REPORT_REASONS[0];
  const details = cleanMultiline(body.details, 600);
  const report = {
    id: randomId('r_'),
    reporterId: user.id,
    conversationId: conversation.id,
    listingId: conversation.listingId,
    reason,
    details,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  getDb().reports.push(report);
  touch();
  return { ok: true, report: { id: report.id, status: report.status } };
});

/* notifications */

route('GET', /^\/api\/notifications\/?$/, async ({ req, viewer }) => {
  requireUser(req);
  const db = getDb();
  const items = db.notifications
    .filter((item) => item.userId === viewer.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 60);
  return { items, unread: items.filter((item) => !item.isRead).length };
});

route('POST', /^\/api\/notifications\/read\/?$/, async ({ req, viewer, body }) => {
  requireUser(req);
  const db = getDb();
  const ids = body.all ? null : Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : null;
  for (const item of db.notifications) {
    if (item.userId !== viewer.id) continue;
    if (!ids || ids.includes(item.id)) item.isRead = true;
  }
  touch();
  return { unread: unreadCount(viewer.id) };
});

/* users + leaderboard */

route('GET', /^\/api\/users\/(?<username>[^/]+)\/?$/, async ({ params, viewer }) => {
  const user = findByUsername(decodeURIComponent(params.username));
  if (!user) throw new HttpError(404, 'That member could not be found.');
  const db = getDb();
  const listings = db.listings
    .filter((listing) => listing.userId === user.id && listing.status !== 'removed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    user: publicUser(user, viewer),
    stats: {
      listings: listings.length,
      lost: listings.filter((listing) => listing.type === 'lost').length,
      found: listings.filter((listing) => listing.type === 'found').length,
      returned: listings.filter((listing) => listing.status === 'returned').length,
      saved: db.saved.filter((entry) => entry.userId === user.id).length,
    },
    achievements: achievementsFor(user),
    listings: listings.map((listing) => listingDto(listing, viewer)),
  };
});

route('GET', /^\/api\/leaderboard\/?$/, async ({ viewer }) => {
  const db = getDb();
  const ranked = db.users
    .map((user) => ({
      username: user.username,
      fullName: user.fullName,
      city: user.city || '',
      avatarUrl: user.avatarUrl || null,
      reputation: user.reputation || 0,
      successfulReturns: user.successfulReturns || 0,
      listings: db.listings.filter((listing) => listing.userId === user.id && listing.status !== 'removed').length,
      isMe: Boolean(viewer && viewer.id === user.id),
    }))
    .sort((a, b) => b.successfulReturns - a.successfulReturns || b.reputation - a.reputation || b.listings - a.listings)
    .slice(0, 12)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  return { items: ranked };
});

/* settings */

route('PATCH', /^\/api\/settings\/?$/, async ({ req, viewer, body }) => {
  const user = requireUser(req);
  if (body.fullName !== undefined) {
    const fullName = cleanText(body.fullName, 60);
    if (fullName.length < 2) throw new HttpError(400, 'Please keep your name at least 2 characters.');
    user.fullName = fullName;
  }
  if (body.city !== undefined) user.city = cleanText(body.city, 80);
  if (body.bio !== undefined) user.bio = cleanMultiline(body.bio, 400);
  if (body.prefs && typeof body.prefs === 'object') {
    user.prefs = {
      emailMatches: Boolean(body.prefs.emailMatches),
      emailMessages: Boolean(body.prefs.emailMessages),
      emailUpdates: Boolean(body.prefs.emailUpdates),
    };
  }
  touch();
  return { user: publicUser(user, user) };
});

route('POST', /^\/api\/settings\/password\/?$/, async ({ req, viewer, body }) => {
  const user = requireUser(req);
  if (!verifyPassword(String(body.currentPassword || ''), user.salt, user.hash)) {
    throw new HttpError(400, 'Your current password is not correct.');
  }
  const next = String(body.newPassword || '');
  if (next.length < 8) throw new HttpError(400, 'New passwords need at least 8 characters.');
  const { salt, hash } = hashPassword(next);
  user.salt = salt;
  user.hash = hash;
  touch();
  return { ok: true };
});

/* reports + admin */

route('POST', /^\/api\/reports\/?$/, async ({ req, body }) => {
  const user = requireUser(req);
  limitReport(`report:${user.id}`, 10, 60 * 60 * 1000);
  const listingId = body.listingId ? String(body.listingId) : null;
  if (listingId) requireListing(listingId);
  const reason = REPORT_REASONS.includes(body.reason) ? body.reason : REPORT_REASONS[5];
  const details = cleanMultiline(body.details, 800);
  const report = {
    id: randomId('r_'),
    reporterId: user.id,
    listingId,
    reason,
    details,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  getDb().reports.push(report);
  touch();
  return { ok: true, report: { id: report.id, status: report.status } };
});

route('GET', /^\/api\/admin\/overview\/?$/, async ({ req }) => {
  requireAdmin(req);
  const db = getDb();
  const reports = db.reports
    .slice()
    .sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 40)
    .map((report) => {
      const reporter = db.users.find((user) => user.id === report.reporterId);
      const listing = db.listings.find((entry) => entry.id === report.listingId) || null;
      return {
        id: report.id,
        reason: report.reason,
        details: report.details,
        status: report.status,
        createdAt: report.createdAt,
        reporter: reporter ? { username: reporter.username, fullName: reporter.fullName } : null,
        listing: listing ? { id: listing.id, title: listing.title, type: listing.type, status: listing.status } : null,
      };
    });
  const active = db.listings.filter((listing) => listing.status !== 'removed');
  return {
    reports,
    pending: reports.filter((report) => report.status === 'pending').length,
    stats: {
      listings: active.length,
      lost: active.filter((listing) => listing.type === 'lost').length,
      found: active.filter((listing) => listing.type === 'found').length,
      reunited: active.filter((listing) => listing.status === 'returned').length,
      members: db.users.length,
      conversations: db.conversations.length,
      messages: db.messages.length,
    },
    recent: active
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6)
      .map((listing) => listingDto(listing, null)),
    members: db.users.slice(0, 6).map((user) => publicUser(user, null)),
  };
});

route('PATCH', /^\/api\/admin\/reports\/(?<id>[^/]+)\/?$/, async ({ req, params, body }) => {
  requireAdmin(req);
  const report = getDb().reports.find((entry) => entry.id === params.id);
  if (!report) throw new HttpError(404, 'That report could not be found.');
  const status = body.status;
  if (!['pending', 'resolved', 'dismissed'].includes(status)) throw new HttpError(400, 'Unknown report status.');
  report.status = status;
  report.reviewedAt = new Date().toISOString();
  if (body.removeListing && report.listingId) {
    const listing = findListing(report.listingId);
    if (listing) listing.status = 'removed';
  }
  if (report.reporterId) {
    notify(report.reporterId, 'moderation', 'Your report was reviewed', 'Thanks for flagging it. Our moderators have taken a look.', report.id);
  }
  touch();
  return { ok: true, status };
});

/* ------------------------------------------------------------------ dispatch */

async function handleApi(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;

  let matched = null;
  let params = {};
  for (const candidate of routes) {
    if (candidate.method !== req.method) continue;
    const result = url.pathname.match(candidate.pattern);
    if (result) {
      matched = candidate;
      params = result.groups || {};
      break;
    }
  }

  if (!matched) {
    sendJson(res, 404, { error: 'Unknown API route.' });
    return true;
  }

  try {
    const viewer = currentUser(req);
    const hasBody = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT';
    const body = hasBody ? await readJson(req, matched.limit || 14_000_000) : {};
    const payload = await matched.handler({ req, res, url, params, viewer, body });
    if (payload !== undefined) sendJson(res, 200, payload);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message, details: error.details || null });
    } else {
      console.error('[api]', error);
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  }
  return true;
}

module.exports = { handleApi, CATEGORIES, REPORT_REASONS };

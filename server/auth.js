'use strict';

const crypto = require('node:crypto');
const { getDb, save } = require('./store');
const { HttpError, parseCookies, serializeCookie } = require('./util');

const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;
const COOKIE_NAME = 'lnf_sid';
const sessions = new Map();

// On a single long-lived server, sessions can live in this Map. Serverless hosts
// (Vercel, Lambda) run each request in a fresh instance, so a Map loses every
// session between requests. When SESSION_SECRET is set we instead issue signed,
// stateless session tokens that verify without server-side storage.
const SESSION_SECRET = String(process.env.SESSION_SECRET || process.env.APP_SECRET || '').trim();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const candidate = crypto.scryptSync(String(password), String(salt), 64);
    const expected = Buffer.from(String(hash), 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function signPayload(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function issueSessionToken(user) {
  const claims = {
    u: user.id,
    t: Date.now(),
    e: String(user.email || '').toLowerCase() || undefined,
    n: user.fullName || undefined,
    p: user.avatarUrl || undefined,
    un: user.username || undefined,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return 'v1.' + payload + '.' + signPayload(payload);
}

function readSessionToken(token) {
  if (!SESSION_SECRET) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const payload = parts[1];
  const signature = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(signPayload(payload), 'base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.u !== 'string' || !Number.isFinite(data.t)) return null;
    if (Date.now() - data.t > SESSION_TTL) return null;
    return {
      userId: data.u,
      createdAt: data.t,
      email: typeof data.e === 'string' ? data.e : '',
      fullName: typeof data.n === 'string' ? data.n : '',
      picture: typeof data.p === 'string' ? data.p : null,
      username: typeof data.un === 'string' ? data.un : '',
    };
  } catch {
    return null;
  }
}

// Node's http response only keeps one Set-Cookie value unless they are collected.
function setCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  const list = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  res.setHeader('Set-Cookie', [...list, value]);
}

function findOrCreateGoogleUser(profile) {
  const db = getDb();
  const email = String(profile.email || '').toLowerCase();
  const existing = db.users.find((user) => String(user.email || '').toLowerCase() === email);
  if (existing) {
    existing.googleSub = profile.sub;
    existing.lastSignInAt = new Date().toISOString();
    if (!existing.avatarUrl && profile.picture) existing.avatarUrl = profile.picture;
    save();
    return existing;
  }

  const local = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  const base = local.length >= 3 ? local : 'member';
  let username = base;
  let suffix = 0;
  while (db.users.some((user) => String(user.username || '').toLowerCase() === username.toLowerCase())) {
    suffix += 1;
    if (suffix > 999) {
      username = 'member' + crypto.randomBytes(3).toString('hex');
      break;
    }
    const tail = String(suffix);
    username = base.slice(0, Math.max(1, 20 - tail.length)) + tail;
  }

  const user = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    username,
    email,
    fullName: String(profile.name || '').trim() || username,
    avatarUrl: profile.picture || null,
    bio: '',
    city: '',
    role: 'member',
    googleSub: profile.sub,
    reputation: 0,
    successfulReturns: 0,
    createdAt: new Date().toISOString(),
    prefs: { emailMatches: true, emailMessages: true, emailUpdates: false },
  };
  db.users.push(user);
  save();
  return user;
}

function createSession(res, userId) {
  const account = getDb().users.find((user) => user.id === userId) || { id: userId };
  const sid = SESSION_SECRET ? issueSessionToken(account) : crypto.randomBytes(32).toString('hex');
  if (!SESSION_SECRET) sessions.set(sid, { userId, createdAt: Date.now() });
  setCookie(
    res,
    serializeCookie(COOKIE_NAME, sid, { maxAge: SESSION_TTL / 1000, httpOnly: true, sameSite: 'Lax' }),
  );
  return sid;
}

function destroySession(req, res) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (sid) sessions.delete(sid);
  setCookie(res, serializeCookie(COOKIE_NAME, '', { maxAge: 0, httpOnly: true, sameSite: 'Lax' }));
}

function currentUser(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return null;
  const session = sessions.get(sid) || readSessionToken(sid);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(sid);
    return null;
  }

  const db = getDb();
  let user = db.users.find((row) => row.id === session.userId) || null;
  if (!user && session.email) {
    user = db.users.find((row) => String(row.email || '').toLowerCase() === session.email) || null;
  }
  if (!user && session.email) {
    // Serverless instances each keep their own in-memory dataset, so the account
    // created during the callback may not exist here. The token is signed, so
    // rebuild the account from its claims instead of signing the user out.
    const local = session.username || session.email.split('@')[0].replace(/[^a-z0-9_]/g, '').slice(0, 20);
    let username = local.length >= 3 ? local : 'member';
    if (db.users.some((row) => String(row.username || '').toLowerCase() === username.toLowerCase())) {
      username = username.slice(0, 14) + crypto.randomBytes(3).toString('hex');
    }
    user = {
      id: session.userId,
      username,
      email: session.email,
      fullName: session.fullName || username,
      avatarUrl: session.picture || null,
      bio: '',
      city: '',
      role: 'member',
      reputation: 0,
      successfulReturns: 0,
      createdAt: new Date().toISOString(),
      prefs: { emailMatches: true, emailMessages: true, emailUpdates: false },
    };
    db.users.push(user);
    save();
  }
  return user;
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Please sign in to continue.');
  return user;
}

function requireAdmin(req) {
  const user = requireUser(req);
  if (user.role !== 'admin') throw new HttpError(403, 'This area is for moderators only.');
  return user;
}

function publicUser(user, viewer) {
  if (!user) return null;
  const isSelf = Boolean(viewer && viewer.id === user.id);
  const dto = {
    id: isSelf ? user.id : undefined,
    username: user.username,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl || null,
    bio: user.bio || '',
    city: user.city || '',
    role: user.role,
    reputation: user.reputation || 0,
    successfulReturns: user.successfulReturns || 0,
    createdAt: user.createdAt,
    isAdmin: user.role === 'admin',
    isMe: isSelf,
  };
  if (isSelf) {
    dto.email = user.email;
    dto.prefs = user.prefs || { emailMatches: true, emailMessages: true, emailUpdates: false };
  }
  return dto;
}

module.exports = {
  hashPassword,
  verifyPassword,
  findOrCreateGoogleUser,
  createSession,
  destroySession,
  currentUser,
  requireUser,
  requireAdmin,
  publicUser,
};

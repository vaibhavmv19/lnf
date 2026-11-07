'use strict';

const crypto = require('node:crypto');
const { getDb, save } = require('./store');
const { HttpError, parseCookies, serializeCookie } = require('./util');

const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;
const COOKIE_NAME = 'lnf_sid';
const sessions = new Map();

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
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { userId, createdAt: Date.now() });
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, sid, { maxAge: SESSION_TTL / 1000, httpOnly: true, sameSite: 'Lax' }),
  );
  return sid;
}

function destroySession(req, res) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', { maxAge: 0, httpOnly: true, sameSite: 'Lax' }));
}

function currentUser(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(sid);
    return null;
  }
  return getDb().users.find((user) => user.id === session.userId) || null;
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

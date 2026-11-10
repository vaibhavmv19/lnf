'use strict';

/**
 * Collection passes: the QR a collector shows at handover.
 *
 * A pass is tied to one listing and one collector, signed with an HMAC,
 * valid for ten minutes and usable exactly once. Only the hash of the
 * token is stored, so the datastore never holds a working link.
 */

const crypto = require('node:crypto');
const { getDb } = require('./store');
const { randomId } = require('./util');

const SECRET = crypto.randomBytes(32);
const PASS_TTL_MS = 10 * 60 * 1000;

function signature(passId) {
  return crypto.createHmac('sha256', SECRET).update(passId).digest('base64url').slice(0, 24);
}

function makeToken(passId) {
  return `${passId}.${signature(passId)}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function passIdFromToken(token) {
  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot < 2) return null;
  const id = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(signature(id));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return id;
}

function passes() {
  const db = getDb();
  if (!Array.isArray(db.passes)) db.passes = [];
  return db.passes;
}

function findPass(token) {
  const id = passIdFromToken(token);
  if (!id) return null;
  return passes().find((pass) => pass.id === id) || null;
}

function passStatus(pass) {
  if (pass.status === 'confirmed') return 'confirmed';
  if (pass.status !== 'pending') return pass.status;
  return Date.parse(pass.expiresAt) <= Date.now() ? 'expired' : 'pending';
}

function revokePending(listingId, exceptId) {
  const stamp = new Date().toISOString();
  for (const pass of passes()) {
    if (pass.listingId === listingId && pass.status === 'pending' && pass.id !== exceptId) {
      pass.status = 'revoked';
      pass.revokedAt = stamp;
    }
  }
}

/** Can this viewer ask for the pass, i.e. are they the person collecting? */
function canCollect(listing, viewer) {
  if (!viewer || !listing) return false;
  if (listing.status !== 'active') return false;
  if (listing.collection && listing.collection.confirmedAt) return false;
  // A found listing is handed over by its owner, so anyone else can collect it.
  // A lost listing is collected by its owner, and a finder hands it over.
  return listing.type === 'found' ? listing.userId !== viewer.id : listing.userId === viewer.id;
}

/** Only the person physically handing the item over may confirm. */
function canConfirm(pass, listing, viewer) {
  if (!viewer || !listing) return false;
  if (passStatus(pass) !== 'pending') return false;
  if (pass.collectorId === viewer.id) return false;
  if (listing.status !== 'active') return false;
  if (listing.collection && listing.collection.confirmedAt) return false;
  // The listing owner is holding the item and hands it over.
  if (listing.userId === viewer.id) return true;
  // A lost report belongs to the collector; the finder they have been
  // talking to is the counterparty who can confirm the handover.
  if (listing.userId !== pass.collectorId) return false;
  return getDb().conversations.some(
    (conversation) =>
      conversation.listingId === listing.id &&
      (conversation.memberIds || []).includes(viewer.id) &&
      (conversation.memberIds || []).includes(pass.collectorId),
  );
}

function issuePass(listing, collector) {
  const live = passes().find(
    (pass) =>
      pass.listingId === listing.id &&
      pass.collectorId === collector.id &&
      passStatus(pass) === 'pending',
  );

  let pass = live;
  if (!pass) {
    pass = {
      id: randomId('p_'),
      listingId: listing.id,
      collectorId: collector.id,
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      tokenHash: null,
      verifiedAt: null,
      confirmedAt: null,
      confirmedById: null,
      pointsAwarded: 0,
      status: 'pending',
    };
    passes().push(pass);
  }

  revokePending(listing.id, pass.id);
  pass.status = 'pending';
  pass.expiresAt = new Date(Date.now() + PASS_TTL_MS).toISOString();
  const token = makeToken(pass.id);
  pass.tokenHash = hashToken(token);
  return { pass, token };
}

module.exports = {
  PASS_TTL_MS,
  findPass,
  passStatus,
  canCollect,
  canConfirm,
  issuePass,
};

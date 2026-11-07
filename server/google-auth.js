'use strict';

/*
 * Google Sign-In (Identity Services) verification.
 *
 * The browser sends the ID token ("credential") that Google issued to this
 * client. We verify the RS256 signature against Google's published keys, then
 * check the issuer, audience, expiry and — most importantly for this app — the
 * `hd` claim, which is the only trustworthy statement that the account belongs
 * to the RVU workspace. The `hd` hint sent by the browser is only a UI filter
 * and can be removed by the user, so it is never trusted on its own.
 */

const crypto = require('node:crypto');
const { HttpError } = require('./util');

const JWKS_URL = process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CLOCK_SKEW_SECONDS = 60;

const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_DOMAIN = String(process.env.GOOGLE_ALLOWED_DOMAIN || 'mys.rvu.edu.in').trim().toLowerCase();
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

let jwksCache = { keys: [], expiresAt: 0 };

function base64urlToBuffer(value) {
  return Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJsonPart(part) {
  try {
    return JSON.parse(base64urlToBuffer(part).toString('utf8'));
  } catch {
    return null;
  }
}

async function fetchKeys(force = false) {
  if (!force && jwksCache.keys.length && Date.now() < jwksCache.expiresAt) {
    return jwksCache.keys;
  }
  let response;
  try {
    response = await fetch(JWKS_URL, { headers: { accept: 'application/json' } });
  } catch {
    throw new HttpError(503, 'Google sign-in is temporarily unavailable. Please try again.');
  }
  if (!response.ok) {
    throw new HttpError(503, 'Google sign-in is temporarily unavailable. Please try again.');
  }
  const body = await response.json().catch(() => ({}));
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const maxAge = Number((String(response.headers.get('cache-control') || '').match(/max-age=(\d+)/) || [])[1] || 3600);
  jwksCache = { keys, expiresAt: Date.now() + Math.max(60, maxAge) * 1000 };
  return keys;
}

async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) {
    throw new HttpError(503, 'Google sign-in is not configured yet.');
  }

  const parts = String(credential || '').split('.');
  if (parts.length !== 3) {
    throw new HttpError(400, 'That Google credential is not valid. Please try again.');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonPart(encodedHeader);
  const payload = decodeJsonPart(encodedPayload);
  if (!header || !payload || header.alg !== 'RS256' || !header.kid) {
    throw new HttpError(400, 'That Google credential is not valid. Please try again.');
  }

  let keys = await fetchKeys();
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    keys = await fetchKeys(true);
    jwk = keys.find((key) => key.kid === header.kid);
  }
  if (!jwk) {
    throw new HttpError(401, 'Google could not verify this sign-in. Please try again.');
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new HttpError(401, 'Google could not verify this sign-in. Please try again.');
  }

  const signatureOk = crypto.verify(
    'RSA-SHA256',
    Buffer.from(encodedHeader + '.' + encodedPayload, 'utf8'),
    publicKey,
    base64urlToBuffer(encodedSignature),
  );
  if (!signatureOk) {
    throw new HttpError(401, 'Google could not verify this sign-in. Please try again.');
  }

  if (!ISSUERS.has(payload.iss)) {
    throw new HttpError(401, 'That sign-in did not come from Google.');
  }

  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(GOOGLE_CLIENT_ID)) {
    throw new HttpError(401, 'That sign-in was issued for a different application.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - CLOCK_SKEW_SECONDS) {
    throw new HttpError(401, 'That sign-in has expired. Please try again.');
  }
  if (typeof payload.iat === 'number' && payload.iat > now + CLOCK_SKEW_SECONDS * 5) {
    throw new HttpError(401, 'That sign-in has a timestamp from the future.');
  }
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new HttpError(403, 'Your Google email address is not verified.');
  }
  if (!payload.sub) {
    throw new HttpError(401, 'That sign-in is missing the Google account id.');
  }

  const email = String(payload.email || '').toLowerCase();
  if (!email.endsWith('@' + GOOGLE_DOMAIN)) {
    throw new HttpError(403, 'Only @' + GOOGLE_DOMAIN + ' accounts can sign in.');
  }
  if (String(payload.hd || '').toLowerCase() !== GOOGLE_DOMAIN) {
    throw new HttpError(403, 'Only accounts managed by @' + GOOGLE_DOMAIN + ' can sign in.');
  }

  return {
    sub: payload.sub,
    email,
    name: String(payload.name || '').trim(),
    picture: payload.picture || null,
    domain: GOOGLE_DOMAIN,
  };
}

function buildAuthUrl(state, redirectUri) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    hd: GOOGLE_DOMAIN,
    prompt: 'select_account',
    access_type: 'online',
    state,
  });
  return AUTH_URL + '?' + params.toString();
}

// Redeems the authorisation code for an ID token. The ID token is then passed
// through the same verification as a browser-supplied credential.
async function exchangeCode(code, redirectUri) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new HttpError(503, 'Google sign-in is not configured yet.');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!payload || payload.error) {
    throw new HttpError(401, 'Google rejected that sign-in. Please start again.');
  }
  if (!payload.id_token) {
    throw new HttpError(401, 'Google did not return an identity token for that account.');
  }
  return payload.id_token;
}

module.exports = {
  verifyGoogleCredential,
  buildAuthUrl,
  exchangeCode,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_DOMAIN,
  JWKS_URL,
};

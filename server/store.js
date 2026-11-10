'use strict';

/*
 * Lost N Found data store — AWS-enabled version.
 *
 * The API layer is synchronous: handlers call getDb(), mutate records in place,
 * then call save(). So the dataset is held in memory.
 *
 * Persistence has three layers:
 *   1. Amazon RDS Postgres, used when RDS_DATABASE_URL is set. Every collection
 *      gets its own table and every record its own row, so two serverless
 *      instances can never overwrite each other's work the way a single JSON
 *      snapshot would. flush() writes only the records that changed, and
 *      sync() pulls other instances' changes back in before a request is served.
 *   2. data/db.json on disk, for local runs and long-lived servers.
 *   3. Memory only, when the filesystem is read-only and RDS is absent.
 *
 * Photos go to the Amazon S3 bucket (public read) so uploaded images survive a
 * redeploy.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const SEED_IMAGE_DIR = path.join(UPLOAD_DIR, 'seed');

const RDS_DATABASE_URL = String(process.env.RDS_DATABASE_URL || '').trim();
const RDS_PASSWORD = String(process.env.RDS_PASSWORD || '').trim();
const TABLE_PREFIX = String(process.env.RDS_TABLE_PREFIX || 'lnf_').trim();
const PHOTO_BUCKET = String(process.env.S3_BUCKET || 'lnf-photos').trim();
const S3_REGION = String(process.env.S3_REGION || 'us-east-1').trim();

const COLLECTIONS = [
  'users',
  'listings',
  'saved',
  'matches',
  'conversations',
  'messages',
  'notifications',
  'reports',
  'passes',
];

const META_TABLE = `${TABLE_PREFIX}meta`;
const tableFor = (name) => TABLE_PREFIX + name;

/* How often one instance re-reads the database before serving a request. */
const PULL_INTERVAL_MS = 1500;

let db = null;
let remoteEnabled = false;
let diskEnabled = true;
let flushTimer = null;
let initPromise = null;
let baseline = null;
let lastPullAt = 0;
let lastSaveAt = 0;
let pullInFlight = null;

function blankDb() {
  return {
    users: [],
    listings: [],
    saved: [],
    matches: [],
    conversations: [],
    messages: [],
    notifications: [],
    reports: [],
    passes: [],
    meta: {},
  };
}

function ensureDirs() {
  if (!diskEnabled) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(SEED_IMAGE_DIR, { recursive: true });
  } catch (error) {
    diskEnabled = false;
    console.warn('[store] filesystem is not writable:', error.message);
  }
}

function readLocal() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return Object.assign(blankDb(), parsed);
  } catch {
    return blankDb();
  }
}

function writeLocal() {
  if (!db || !diskEnabled) return false;
  try {
    ensureDirs();
    if (!diskEnabled) return false;
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
    return true;
  } catch (error) {
    diskEnabled = false;
    console.warn('[store] local writes disabled:', error.message);
    return false;
  }
}

/* Every record needs a stable row id. Most records carry one; a saved item is
   identified by the pair of ids that make the relationship unique. */
function keyOf(collection, item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id === 'string' && item.id) return item.id;
  if (collection === 'saved') {
    const userId = String(item.userId || '');
    const listingId = String(item.listingId || '');
    if (userId && listingId) return `${userId}:${listingId}`;
  }
  return null;
}

function indexOf(source) {
  const out = {};
  for (const name of COLLECTIONS) {
    const rows = new Map();
    for (const item of source[name] || []) {
      const key = keyOf(name, item);
      if (key && !rows.has(key)) rows.set(key, JSON.stringify(item));
    }
    out[name] = rows;
  }
  return out;
}

function adopt(next) {
  for (const name of COLLECTIONS) {
    if (!Array.isArray(db[name])) db[name] = [];
    const rows = next[name] || [];
    db[name].splice(0, db[name].length, ...rows);
  }
  db.meta = next.meta || {};
}

/* ---------------------------- Amazon RDS ---------------------------- */

/**
 * Create a pg Pool connected to the RDS instance.  Cached so we only connect
 * once per process lifetime.
 */
let pgPool = null;

async function initPgPool() {
  if (pgPool) return pgPool;
  if (!RDS_DATABASE_URL) {
    console.log('[store] RDS not configured; local data only');
    return null;
  }
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: RDS_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await pgPool.connect();
    console.log('[store] connected to Amazon RDS');
    return pgPool;
  } catch (error) {
    console.warn('[store] RDS unavailable, using local data:', error.message);
    pgPool = null;
    return null;
  }
}

async function queryRds(sql, params = []) {
  const pool = await initPgPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (error) {
    console.warn('[store] RDS query failed:', error.message);
    return null;
  }
}

/* Pull all collection rows from RDS. */
async function pullAllFromRDS() {
  const next = blankDb();
  const rowsMap = {};

  for (const name of COLLECTIONS) {
    const table = tableFor(name);
    const rows = await queryRds(`SELECT id, data FROM ${table} ORDER BY id ASC`);
    if (rows && rows.length) {
      rowsMap[name] = rows.map((row) => row.data).filter((r) => r && typeof r === 'object');
    }
  }

  /* Meta table */
  const metaRows = await queryRds(`SELECT data FROM ${META_TABLE} WHERE id = 'meta'`);
  if (metaRows && metaRows.length && metaRows[0] && typeof metaRows[0].data === 'object') {
    rowsMap.meta = metaRows[0].data;
  }

  return rowsMap;
}

/* Upsert a batch of rows into an RDS table. */
async function upsertRowsRds(table, rows, previous) {
  const upserts = [];
  for (const [id, json] of rows) {
    if (previous.get(id) === json) continue;
    upserts.push({ id, data: JSON.parse(json), updated_at: new Date().toISOString() });
  }
  const deletes = Array.from(previous.keys()).filter((id) => !rows.has(id));

  if (upserts.length > 0) {
    const batchSize = 200;
    for (let i = 0; i < upserts.length; i += batchSize) {
      const chunk = upserts.slice(i, i + batchSize);
      const values = chunk.map((c) => [`${c.id}`, `JSON.stringify(c.data)`, `c.updated_at`]);
      // Build a single multi-row INSERT ... ON CONFLICT query
      const columnList = '(id, data, updated_at)';
      const valuePlaceholders = chunk.map((_, i) => `(${i * 3 + 1}, ${i * 3 + 2}, ${i * 3 + 3})`).join(', ');
      // Simpler approach: iterate individually
      for (const item of chunk) {
        await poolQuery(
          `INSERT INTO ${table} (id, data, updated_at) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
          [item.id, JSON.stringify(item.data), item.updated_at]
        );
      }
    }
  }

  for (let i = 0; i < deletes.length; i += 200) {
    const chunk = deletes.slice(i, i + 200);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    if (idList) {
      await poolQuery(`DELETE FROM ${table} WHERE id IN (${idList})`);
    }
  }

  return upserts.length + deletes.length;
}

/* Write meta row to RDS. */
async function writeMetaRds(meta) {
  await poolQuery(
    `INSERT INTO ${META_TABLE} (id, data, updated_at) VALUES ('meta', $1, $2)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(meta || {}), new Date().toISOString()]
  );
}

/* ---------------------------- Amazon S3 ---------------------------- */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let s3Client = null;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({ region: S3_REGION });
  }
  return s3Client;
}

/* Upload a photo to Amazon S3 and return its public URL, or fall back to disk. */
async function putPhoto(buffer, ext, contentType) {
  if (!buffer) return null;

  const client = getS3Client();

  if (!client) {
    /* S3 not configured – fall back to local disk. */
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
      return `/uploads/${name}`;
    } catch (error) {
      console.warn('[uploads] cannot write to disk, inlining photo:', error.message);
      return null;
    }
  }

  const day = new Date().toISOString().slice(0, 10);
  const name = `${day}/${crypto.randomBytes(12).toString('hex')}.${ext}`;

  const putCommand = new PutObjectCommand({
    Bucket: PHOTO_BUCKET,
    Key: name,
    Body: buffer,
    ContentType: contentType || 'image/jpeg',
    CacheControl: 'max-age=31536000',
    ACL: 'public-read',
  });

  try {
    await client.send(putCommand);
    const getCommand = new GetObjectCommand({ Bucket: PHOTO_BUCKET, Key: name });
    const url = await getSignedUrl(client, getCommand, { expiresIn: 31536000 });
    return url;
  } catch (error) {
    console.warn('[uploads] S3 upload failed, using disk fallback:', error.message);
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
      return `/uploads/${name}`;
    } catch (diskError) {
      console.warn('[uploads] cannot write to disk: ', diskError.message);
      return null;
    }
  }
}

/* ---------------------------- Shared query helper ---------------------------- */

let pool = null;

/* Unified query helper that uses the pg pool when available. */
async function poolQuery(sql, params = []) {
  if (pool) {
    try {
      const { rows } = await pool.query(sql, params);
      return rows;
    } catch (e) {
      console.warn('[store] poolQuery error, retrying direct:', e.message);
    }
  }
  /* fallback: create a one-off Pool */
  try {
    const { Pool } = require('pg');
    const p = new Pool({ connectionString: RDS_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const { rows } = await p.query(sql, params);
    await p.end();
    return rows;
  } catch (e) {
    console.warn('[store] direct query failed:', e.message);
    return null;
  }
}

/* ---------------------------- Persistence orchestration ---------------------------- */

async function pullAll() {
  const fresh = await pullAllFromRDS();
  adopt(fresh);
  baseline = indexOf(db);
  return db;
}

/* Upsert + delete a collection using the RDS helper. */
async function writeCollection(name, rows, previous) {
  const table = tableFor(name);
  await upsertRowsRds(table, rows, previous || new Map());
}

/* Write meta to RDS. */
async function writeMeta(meta) {
  await writeMetaRds(meta);
}

/* Upload photos to S3 (called from api.js). */
async function flushRemoteNow() {
  if (!remoteEnabled || !db) return true;
  const next = indexOf(db);
  const previous = baseline || indexOf(blankDb());
  try {
    for (const name of COLLECTIONS) {
      await writeCollection(name, next[name], previous[name] || new Map());
    }
    await writeMeta(db.meta);
    baseline = next;
    return true;
  } catch (error) {
    console.warn('[store] RDS write failed:', error.message);
    return false;
  }
}

/* Push everything from local memory up to RDS. */
async function pushEverything(source) {
  const index = indexOf(source);
  for (const name of COLLECTIONS) {
    await writeCollection(name, index[name], new Map());
  }
  await writeMeta(source.meta);
}

/* Schedule a flush after a delay. */
function scheduleFlush(delay = 350) {
  if (!remoteEnabled) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushRemoteNow();
  }, delay);
  if (flushTimer.unref) flushTimer.unref();
}

/* ---------------------------- Lifecycle ---------------------------- */

async function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    ensureDirs();
    db = readLocal();
    baseline = indexOf(db);

    if (!RDS_DATABASE_URL) {
      console.log('[store] RDS not configured; local data only');
      return db;
    }

    try {
      const fresh = await pullAllFromRDS();
      adopt(fresh);
      baseline = indexOf(db);
      remoteEnabled = true;
      writeLocal();
      console.log('[store] loaded state from Amazon RDS');
    } catch (error) {
      console.warn('[store] RDS unavailable, using local data:', error.message);
      remoteEnabled = false;
    }

    return db;
  })();

  return initPromise;
}

function getDb() {
  if (!db) db = readLocal();
  return db;
}

function save() {
  if (!db) return;
  lastSaveAt = Date.now();
  writeLocal();
  scheduleFlush();
}

function reset() {
  db = blankDb();
  save();
  return db;
}

async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!remoteEnabled) return false;
  let ok = await flushRemoteNow();
  if (!ok) ok = await flushRemoteNow();
  return ok;
}

/* ---------------------------- Module exports ---------------------------- */
function status() {
  return {
    remote: remoteEnabled,
    disk: diskEnabled,
    bucket: remoteEnabled ? PHOTO_BUCKET : null,
    tables: COLLECTIONS.map(tableFor).concat(META_TABLE),
    dbType: remoteEnabled ? 'Amazon RDS' : 'local',
  };
}

module.exports = {
  ROOT,
  DATA_DIR,
  DB_FILE,
  PUBLIC_DIR,
  UPLOAD_DIR,
  SEED_IMAGE_DIR,
  COLLECTIONS,
  init,
  getDb,
  save,
  reset,
  flush,
  sync: pullAll,
  blankDb,
  putPhoto,
  status,
  isRemote: () => remoteEnabled,
};
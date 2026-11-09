'use strict';

/*
 * Lost N Found data store.
 *
 * The API layer is synchronous: handlers call getDb(), mutate records in place,
 * then call save(). So the dataset is held in memory.
 *
 * Persistence has three layers:
 *   1. Supabase Postgres, used when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 *      are set. Every collection gets its own table and every record its own
 *      row, so two serverless instances can never overwrite each other's work
 *      the way a single JSON snapshot would. flush() writes only the records
 *      that changed, and sync() pulls other instances' changes back in before a
 *      request is served.
 *   2. data/db.json on disk, for local runs and long-lived servers.
 *   3. Memory only, when the filesystem is read-only and Supabase is absent.
 *
 * Photos go to the Supabase Storage bucket SUPABASE_PHOTO_BUCKET (public read)
 * so uploaded images survive a redeploy.
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

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '',
).trim();
const TABLE_PREFIX = String(process.env.SUPABASE_TABLE_PREFIX || 'lnf_').trim();
const PHOTO_BUCKET = String(process.env.SUPABASE_PHOTO_BUCKET || 'lnf-photos').trim();

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
let supabase = null;
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

/* ------------------------------------------------------------------ Supabase */

async function selectRows(table) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from(table)
      .select('id,data')
      .order('id', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

async function pullAll() {
  const next = blankDb();
  for (const name of COLLECTIONS) {
    const rows = await selectRows(tableFor(name));
    next[name] = rows.map((row) => row.data).filter((row) => row && typeof row === 'object');
  }
  try {
    const { data, error } = await supabase
      .from(META_TABLE)
      .select('data')
      .eq('id', 'meta')
      .maybeSingle();
    if (error) throw error;
    if (data && data.data && typeof data.data === 'object') next.meta = data.data;
  } catch (error) {
    console.warn('[store] meta read failed:', error.message);
  }
  return next;
}

async function writeCollection(name, rows, previous) {
  const table = tableFor(name);
  const upserts = [];
  for (const [id, json] of rows) {
    if (previous.get(id) === json) continue;
    upserts.push({ id, data: JSON.parse(json), updated_at: new Date().toISOString() });
  }
  const deletes = Array.from(previous.keys()).filter((id) => !rows.has(id));

  for (let index = 0; index < upserts.length; index += 200) {
    const chunk = upserts.slice(index, index + 200);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'id' });
    if (error) throw error;
  }
  for (let index = 0; index < deletes.length; index += 200) {
    const chunk = deletes.slice(index, index + 200);
    const { error } = await supabase.from(table).delete().in('id', chunk);
    if (error) throw error;
  }
  return upserts.length + deletes.length;
}

async function writeMeta(meta) {
  const { error } = await supabase
    .from(META_TABLE)
    .upsert({ id: 'meta', data: meta || {}, updated_at: new Date().toISOString() });
  if (error) throw error;
}

async function flushRemoteNow() {
  if (!remoteEnabled || !supabase || !db) return true;
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
    console.warn('[store] Supabase write failed:', error.message);
    return false;
  }
}

async function pushEverything(source) {
  const index = indexOf(source);
  for (const name of COLLECTIONS) {
    await writeCollection(name, index[name], new Map());
  }
  await writeMeta(source.meta);
}

function scheduleFlush(delay = 350) {
  if (!remoteEnabled) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushRemoteNow();
  }, delay);
  if (flushTimer.unref) flushTimer.unref();
}

/* Pull other instances' writes in before serving a request. Throttled, and
   skipped right after a local write so a fresh mutation is never yanked away. */
async function sync() {
  if (!remoteEnabled || !supabase || !db) return db;
  if (pullInFlight) return pullInFlight;
  const now = Date.now();
  if (now - lastPullAt < PULL_INTERVAL_MS) return db;
  if (now - lastSaveAt < 250) return db;
  lastPullAt = now;

  pullInFlight = (async () => {
    await flushRemoteNow();
    const fresh = await pullAll();
    adopt(fresh);
    baseline = indexOf(db);
  })()
    .catch((error) => {
      console.warn('[store] refresh failed:', error.message);
    })
    .finally(() => {
      pullInFlight = null;
    });

  return pullInFlight;
}

async function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    ensureDirs();
    db = readLocal();
    baseline = indexOf(db);

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.log('[store] Supabase not configured; local data only');
      return db;
    }

    try {
      const { createClient } = require('@supabase/supabase-js');
      supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      let remote;
      try {
        remote = await pullAll();
      } catch (error) {
        if (/does not exist|schema cache|42P01/i.test(error.message || '')) {
          console.warn(
            '[store] Supabase tables are missing. Run supabase_schema.sql in the Supabase SQL editor.',
          );
        }
        throw error;
      }

      const remoteEmpty = COLLECTIONS.every((name) => !remote[name].length);
      const localEmpty = COLLECTIONS.every((name) => !(db[name] || []).length);

      if (remoteEmpty && !localEmpty) {
        await pushEverything(db);
        console.log('[store] uploaded local data to Supabase');
      } else if (!remoteEmpty) {
        adopt(remote);
        console.log('[store] loaded state from Supabase');
      }

      baseline = indexOf(db);
      remoteEnabled = true;
      writeLocal();
    } catch (error) {
      console.warn('[store] Supabase unavailable, using local data:', error.message);
      remoteEnabled = false;
      supabase = null;
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

/* Upload a photo to Supabase Storage and return its public URL, or null when
   storage is not configured. Falls back to the caller's local write. */
async function putPhoto(buffer, ext, contentType) {
  if (!remoteEnabled || !supabase || !buffer) return null;
  const day = new Date().toISOString().slice(0, 10);
  const name = `${day}/${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const bucket = supabase.storage.from(PHOTO_BUCKET);
  const { error } = await bucket.upload(name, buffer, {
    contentType: contentType || 'image/jpeg',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw error;
  const { data } = bucket.getPublicUrl(name);
  return data && data.publicUrl ? data.publicUrl : null;
}

function status() {
  return {
    remote: remoteEnabled,
    disk: diskEnabled,
    bucket: remoteEnabled ? PHOTO_BUCKET : null,
    tables: COLLECTIONS.map(tableFor).concat(META_TABLE),
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
  sync,
  blankDb,
  putPhoto,
  status,
  isRemote: () => remoteEnabled,
};

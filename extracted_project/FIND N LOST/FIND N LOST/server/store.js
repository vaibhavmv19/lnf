'use strict';

/*
 * Lost N Found data store.
 *
 * The API layer is synchronous: handlers call getDb() and mutate objects in
 * place, then call save(). So the whole dataset is held in memory and written
 * out atomically.
 *
 * Persistence has two backends:
 *   1. data/db.json on disk (always written, and the fallback).
 *   2. A Supabase Postgres row holding the same JSON snapshot, used when
 *      SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set. init() loads the
 *      remote snapshot on boot (remote wins), and save() flushes back to it.
 *
 * The Supabase key must be the service role key and must stay server-side.
 * It is never sent to the browser.
 */

const fs = require('node:fs');
const path = require('node:path');

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
const SUPABASE_TABLE = String(process.env.SUPABASE_STATE_TABLE || 'app_state').trim();
const SUPABASE_ROW = String(process.env.SUPABASE_STATE_KEY || 'db').trim();

let db = null;
let supabase = null;
let remoteEnabled = false;
let flushTimer = null;
let initPromise = null;

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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SEED_IMAGE_DIR, { recursive: true });
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
  if (!db) return false;
  try {
    ensureDirs();
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
    return true;
  } catch (error) {
    console.warn('[store] local write failed:', error.message);
    return false;
  }
}

async function flushRemote() {
  if (!remoteEnabled || !supabase || !db) return;
  const snapshot = db;
  try {
    const { error } = await supabase
      .from(SUPABASE_TABLE)
      .upsert({ id: SUPABASE_ROW, data: snapshot, updated_at: new Date().toISOString() });
    if (error) throw error;
  } catch (error) {
    console.warn('[store] Supabase write failed (kept locally):', error.message);
  }
}

function scheduleFlush() {
  if (!remoteEnabled) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushRemote();
  }, 800);
  if (flushTimer.unref) flushTimer.unref();
}

// Load state once. Safe to call repeatedly; later calls reuse the same promise.
function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    ensureDirs();
    db = readLocal();

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.log('[store] Supabase not configured; using data/db.json');
      return db;
    }

    try {
      const { createClient } = require('@supabase/supabase-js');
      const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data, error } = await client
        .from(SUPABASE_TABLE)
        .select('data')
        .eq('id', SUPABASE_ROW)
        .maybeSingle();

      if (error) throw error;

      if (data && data.data && typeof data.data === 'object') {
        db = Object.assign(blankDb(), data.data);
        writeLocal();
        console.log('[store] loaded state from Supabase');
      } else {
        const { error: writeError } = await client
          .from(SUPABASE_TABLE)
          .upsert({ id: SUPABASE_ROW, data: db, updated_at: new Date().toISOString() });
        if (writeError) throw writeError;
        console.log('[store] uploaded initial state to Supabase');
      }

      supabase = client;
      remoteEnabled = true;
    } catch (error) {
      console.warn('[store] Supabase unavailable, falling back to local data:', error.message);
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
  await flushRemote();
}

module.exports = {
  ROOT,
  DATA_DIR,
  DB_FILE,
  PUBLIC_DIR,
  UPLOAD_DIR,
  SEED_IMAGE_DIR,
  init,
  getDb,
  save,
  reset,
  flush,
  blankDb,
  isRemote: () => remoteEnabled,
};

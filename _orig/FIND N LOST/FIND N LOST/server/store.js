'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const SEED_IMAGE_DIR = path.join(UPLOAD_DIR, 'seed');

let db = null;

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

function getDb() {
  if (db) return db;
  ensureDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = Object.assign(blankDb(), parsed);
  } catch {
    db = blankDb();
  }
  return db;
}

function save() {
  if (!db) return;
  ensureDirs();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function reset() {
  db = blankDb();
  save();
  return db;
}

module.exports = {
  ROOT,
  DATA_DIR,
  DB_FILE,
  PUBLIC_DIR,
  UPLOAD_DIR,
  SEED_IMAGE_DIR,
  getDb,
  save,
  reset,
  blankDb,
};

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shops (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  shop_id    INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rentals (
  id             INTEGER PRIMARY KEY,
  shop_id        INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  public_token   TEXT NOT NULL UNIQUE,
  asset          TEXT NOT NULL,
  customer_name  TEXT NOT NULL,
  customer_phone TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'new',  -- new | out | returned
  created_at     TEXT NOT NULL
);

-- An inspection is immutable once inserted: it is written together with its seal.
CREATE TABLE IF NOT EXISTS inspections (
  id               INTEGER PRIMARY KEY,
  rental_id        INTEGER NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,              -- pickup | return
  reading          TEXT NOT NULL DEFAULT '',   -- odometer / fuel / engine hours
  notes            TEXT NOT NULL DEFAULT '',
  staff_sig_sha    TEXT NOT NULL,
  customer_sig_sha TEXT NOT NULL,
  sealed_at        TEXT NOT NULL,
  payload          TEXT NOT NULL,              -- the exact JSON that was hashed
  seal_hash        TEXT NOT NULL,
  UNIQUE (rental_id, kind)
);

CREATE TABLE IF NOT EXISTS photos (
  id            INTEGER PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  slot          TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  ext           TEXT NOT NULL,
  size          INTEGER NOT NULL
);

-- Append-only hash chain over every seal on this server, so a record cannot be
-- silently rewritten or back-dated without breaking every later entry.
CREATE TABLE IF NOT EXISTS ledger (
  id            INTEGER PRIMARY KEY,
  inspection_id INTEGER NOT NULL UNIQUE REFERENCES inspections(id),
  seal_hash     TEXT NOT NULL,
  prev_hash     TEXT NOT NULL,
  entry_hash    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

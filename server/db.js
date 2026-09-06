import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const DB_PATH = process.env.DB_PATH
  ? resolve(ROOT, process.env.DB_PATH)
  : resolve(ROOT, 'data', 'prospect-book.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Migrations are append-only. Each entry runs once, in order, inside a
 * transaction, and is recorded in schema_migrations. Never edit a migration
 * that has already shipped — add a new one.
 */
const MIGRATIONS = [
  {
    name: '001_initial',
    up: `
      CREATE TABLE leads (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name     TEXT    NOT NULL,
        category          TEXT,
        location          TEXT,
        phone             TEXT,
        email             TEXT,
        google_place_id   TEXT    UNIQUE,
        status            TEXT    NOT NULL DEFAULT 'new'
                                  CHECK (status IN ('new','sent','replied','won','lost')),
        notes             TEXT,
        source            TEXT,
        opted_out         INTEGER NOT NULL DEFAULT 0 CHECK (opted_out IN (0,1)),
        created_at        TEXT    NOT NULL,
        last_contacted_at TEXT
      );
      CREATE INDEX idx_leads_status  ON leads(status);
      CREATE INDEX idx_leads_created ON leads(created_at DESC);

      CREATE TABLE templates (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        subject    TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE email_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id          INTEGER REFERENCES leads(id)     ON DELETE SET NULL,
        template_id      INTEGER REFERENCES templates(id) ON DELETE SET NULL,
        lead_name        TEXT    NOT NULL,
        to_email         TEXT    NOT NULL,
        subject_snapshot TEXT    NOT NULL,
        body_snapshot    TEXT    NOT NULL,
        sent_at          TEXT    NOT NULL,
        channel          TEXT    NOT NULL DEFAULT 'mailto'
                                 CHECK (channel IN ('mailto','copy','gmail')),
        provider_message_id TEXT
      );
      CREATE INDEX idx_email_log_lead ON email_log(lead_id);
      CREATE INDEX idx_email_log_sent ON email_log(sent_at DESC);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    name: '002_place_cache',
    up: `
      -- Every Google place_id we have ever resolved, so a place is never
      -- billed for twice -- including places rejected for having a website.
      CREATE TABLE place_cache (
        place_id      TEXT PRIMARY KEY,
        display_name  TEXT,
        address       TEXT,
        phone         TEXT,
        website_uri   TEXT,
        has_website   INTEGER NOT NULL CHECK (has_website IN (0,1)),
        imported      INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0,1)),
        first_seen_at TEXT NOT NULL,
        query_text    TEXT
      );
      CREATE INDEX idx_place_cache_seen ON place_cache(first_seen_at DESC);
    `,
  },
  {
    name: '003_search_runs',
    up: `
      -- One row per "search for leads" sweep, for cost tracking.
      CREATE TABLE search_runs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        category          TEXT NOT NULL,
        areas             TEXT NOT NULL,
        started_at        TEXT NOT NULL,
        finished_at       TEXT,
        text_search_calls INTEGER NOT NULL DEFAULT 0,
        places_returned   INTEGER NOT NULL DEFAULT 0,
        places_new        INTEGER NOT NULL DEFAULT 0,
        candidates_found  INTEGER NOT NULL DEFAULT 0,
        error             TEXT
      );
    `,
  },
  {
    name: '004_send_queue',
    up: `
      -- Phase 3: emails staged for review before a single explicit confirmation.
      CREATE TABLE send_queue (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        template_id  INTEGER REFERENCES templates(id) ON DELETE SET NULL,
        to_email     TEXT    NOT NULL,
        subject      TEXT    NOT NULL,
        body         TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','sent','failed','skipped')),
        error        TEXT,
        created_at   TEXT    NOT NULL,
        sent_at      TEXT
      );
      CREATE INDEX idx_send_queue_status ON send_queue(status);
    `,
  },
];

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        m.name,
        new Date().toISOString()
      );
    })();
    console.log(`[db] applied migration ${m.name}`);
  }
}

migrate();

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

export function getSettings() {
  return Object.fromEntries(
    db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])
  );
}

export { DB_PATH };

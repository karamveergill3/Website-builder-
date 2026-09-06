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
  {
    name: '005_run_places',
    up: `
      -- Which places each sweep surfaced, so a review list can show "found by
      -- this run" without re-querying (and re-paying for) Google.
      CREATE TABLE run_places (
        run_id   INTEGER NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
        place_id TEXT    NOT NULL REFERENCES place_cache(place_id) ON DELETE CASCADE,
        area     TEXT,
        PRIMARY KEY (run_id, place_id)
      );
    `,
  },
  {
    name: '006_place_cache_refreshed',
    up: `
      -- Google's terms cap how long most Places content may be cached; only
      -- the place ID may be kept indefinitely. This column drives the purge
      -- in server/lib/places.js.
      ALTER TABLE place_cache ADD COLUMN refreshed_at TEXT;
      UPDATE place_cache SET refreshed_at = first_seen_at;
    `,
  },
  {
    name: '007_pecr_entity_and_suppression',
    up: `
      -- PECR reg 22 turns on the recipient's LEGAL FORM, not on whether the
      -- address looks like a business one. Corporate subscribers (Ltd, PLC,
      -- LLP, Scottish partnerships, CICs, public bodies) may be cold-emailed
      -- without consent; sole traders and ordinary partnerships may not.
      -- Everything starts 'unknown' and is blocked until positively classified.
      ALTER TABLE leads ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE leads ADD COLUMN company_number TEXT;
      ALTER TABLE leads ADD COLUMN entity_note TEXT;

      -- The ICO's position on opt-out is suppress, do not delete: a deleted
      -- record just gets re-scraped and re-mailed. This list outlives the lead.
      CREATE TABLE suppression_list (
        email         TEXT PRIMARY KEY,
        business_name TEXT,
        reason        TEXT NOT NULL,
        added_at      TEXT NOT NULL
      );
    `,
  },
  {
    name: '008_places_content_not_persisted',
    up: `
      -- Google Maps Platform ToS 3.2.3(a)(iii) names "copy and save business
      -- names, addresses" as a prohibited example of scraping, and 3.2.3(b)
      -- forbids caching Maps Content except where the Service Specific Terms
      -- allow it. The only durable permission is for the place ID itself
      -- (SST A.3); lat/lng gets 30 days (SST 14.3) and we do not request it.
      --
      -- So place_cache keeps IDs and the derived has-a-website flag, and
      -- nothing that came out of the listing. Candidate names, addresses and
      -- phone numbers live in memory for the length of a review session only.
      CREATE TABLE place_cache_new (
        place_id      TEXT PRIMARY KEY,
        has_website   INTEGER NOT NULL CHECK (has_website IN (0,1)),
        imported      INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0,1)),
        first_seen_at TEXT NOT NULL,
        refreshed_at  TEXT,
        query_text    TEXT
      );
      INSERT INTO place_cache_new (place_id, has_website, imported, first_seen_at, refreshed_at, query_text)
        SELECT place_id, has_website, imported, first_seen_at, refreshed_at, query_text FROM place_cache;
      DROP TABLE place_cache;
      ALTER TABLE place_cache_new RENAME TO place_cache;
      CREATE INDEX idx_place_cache_seen ON place_cache(first_seen_at DESC);

      -- Track which lead fields came from a Places listing, so the retention
      -- panel can say exactly what is affected and purge only that.
      ALTER TABLE leads ADD COLUMN details_source TEXT;
      ALTER TABLE leads ADD COLUMN details_imported_at TEXT;
      UPDATE leads SET details_source = 'google_places', details_imported_at = created_at
        WHERE source = 'Google Places';
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

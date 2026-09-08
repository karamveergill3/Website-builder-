import Database from 'better-sqlite3';
import { STARTERS, missingStarters } from './lib/starters.js';
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
/**
 * Collapse lead rows that are the same company, then make new ones impossible.
 *
 * Duplicates get in through three doors: a Places import and a register import
 * of one business key on different identifiers (place id vs company number),
 * `applyMatch` stamps a number onto a lead without checking another lead holds
 * it, and two hunt processes can pass the same SELECT before either INSERTs.
 * None of that is intentional, so merging is safe in a way that merging user
 * records usually is not.
 *
 * The oldest row wins, because it carries the history. Everything the newer
 * rows know is moved onto it rather than dropped: child rows are repointed,
 * notes are appended, and any field the winner left blank is filled from a
 * loser. Only then is the loser deleted.
 */
function mergeDuplicateCompanies() {
  const dupes = db.prepare(
    `SELECT company_number FROM leads
      WHERE company_number IS NOT NULL
      GROUP BY company_number HAVING COUNT(*) > 1`
  ).all();

  // Child tables that carry a lead_id. contact_signals and contact_finds have
  // uniqueness within a lead, so a repoint can collide; those are moved with
  // OR IGNORE and the leftovers dropped with the loser.
  const CHILDREN = [
    ['email_log', false], ['send_queue', false], ['outreach_events', false],
    ['replies', false], ['briefs', false], ['mockups', false],
    ['contact_signals', true], ['contact_finds', true],
  ];
  // Fields worth rescuing from a row that is about to go.
  const FILLABLE = [
    'email', 'phone', 'company_number', 'registered_name', 'registered_address',
    'company_status', 'company_type', 'incorporated_on', 'sic_codes',
    'entity_type', 'entity_note', 'category', 'location', 'google_place_id',
    'has_website', 'website_evidence', 'website_checked_at', 'checked_at',
  ];

  let merged = 0;
  for (const { company_number: number } of dupes) {
    const rows = db.prepare(
      `SELECT * FROM leads WHERE company_number = ?
        ORDER BY COALESCE(created_at, '') ASC, id ASC`
    ).all(number);
    const [winner, ...losers] = rows;
    if (!winner || !losers.length) continue;

    for (const loser of losers) {
      for (const [table, mayCollide] of CHILDREN) {
        db.prepare(
          `UPDATE ${mayCollide ? 'OR IGNORE ' : ''}${table} SET lead_id = ? WHERE lead_id = ?`
        ).run(winner.id, loser.id);
      }

      const patch = {};
      for (const field of FILLABLE) {
        if ((winner[field] === null || winner[field] === '') && loser[field] != null) {
          patch[field] = loser[field];
          winner[field] = loser[field];
        }
      }
      // An opt-out on either row binds the merged row: the safe direction.
      if (loser.opted_out === 1 && winner.opted_out !== 1) patch.opted_out = 1;
      // The earliest contact and the latest both matter; keep the latest,
      // since every repeat check asks "how recently".
      if (loser.last_contacted_at
          && (!winner.last_contacted_at || loser.last_contacted_at > winner.last_contacted_at)) {
        patch.last_contacted_at = loser.last_contacted_at;
      }
      const note = String(loser.notes ?? '').trim();
      if (note && !String(winner.notes ?? '').includes(note)) {
        patch.notes = [String(winner.notes ?? '').trim(), note].filter(Boolean).join('\n\n');
        winner.notes = patch.notes;
      }
      const keys = Object.keys(patch);
      if (keys.length) {
        db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
          .run({ ...patch, id: winner.id });
      }

      db.prepare('DELETE FROM leads WHERE id = ?').run(loser.id);
      merged += 1;
    }
  }
  if (merged) console.log(`[db] merged ${merged} duplicate lead row(s) into their originals`);

  // Now that the column is clean, make a second row for one company a
  // storage-layer error rather than something each call site must remember
  // to check. Partial, because most leads legitimately have no number yet.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_company_number
       ON leads (company_number) WHERE company_number IS NOT NULL`
  );
}

/**
 * Finish the ledger backfill for the rows SQL alone cannot key.
 *
 * A lead with no company number — every Places import, and anything typed in
 * by hand — is identified by a normalised name plus town. That normaliser
 * lives in lib/companies-house.js, which imports this module, so it cannot be
 * imported back here without a cycle. It is mirrored below instead, and
 * test/recontact.test.js fails if the two ever disagree.
 */
const LEDGER_NOISE = new Set([
  'ltd', 'limited', 'llp', 'plc', 'cic', 'co', 'company', 'the', 'and', 'uk',
]);
function ledgerNormaliseName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEDGER_NOISE.has(w))
    .join(' ')
    .trim();
}

/**
 * Put the shipped messages in the box.
 *
 * There was a button for this and it went unpressed, so a live install ran a
 * hunt, filed sixty companies and then offered an empty template list on
 * every screen that needed one. Wording is not an optional extra: without it
 * the Reach dialog can only say "no templates yet" and the whole day's work
 * stops there. Matched on name, so a starter already present — or edited and
 * kept under the same name — is left exactly as it is.
 */
function seedStarterTemplates() {
  const have = db.prepare('SELECT name FROM templates').all().map((r) => r.name);
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO templates (name, subject, body, channel, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  let n = 0;
  for (const t of missingStarters(have)) {
    n += insert.run(t.name, t.subject, t.body, t.channel, now, now).changes;
  }
  if (n) console.log(`[db] seeded ${n} of ${STARTERS.length} starter templates`);
}

function backfillLedgerNameKeys() {
  const nameKey = (name, town) => {
    const n = ledgerNormaliseName(name);
    return n ? `nm:${n}|${ledgerNormaliseName(town)}` : null;
  };

  // Fill name_key on everything already in the ledger, including the rows the
  // SQL half just inserted, so the number path and the name path meet.
  const setKey = db.prepare('UPDATE company_ledger SET name_key = ? WHERE company_key = ?');
  for (const row of db.prepare(
    'SELECT company_key, business_name, location FROM company_ledger WHERE name_key IS NULL'
  ).all()) {
    const nk = nameKey(row.business_name, row.location);
    if (nk) setKey.run(nk, row.company_key);
  }

  // Then the leads that have no company number at all.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO company_ledger
       (company_key, company_number, business_name, location,
        found_at, contacted_at, last_channel, times_contacted, name_key)
     VALUES (@key, NULL, @name, @town, @found, @contacted, @channel, @times, @key)`
  );
  let n = 0;
  for (const lead of db.prepare(
    `SELECT business_name, location, created_at, last_contacted_at FROM leads
      WHERE company_number IS NULL OR TRIM(company_number) = ''`
  ).all()) {
    const key = nameKey(lead.business_name, lead.location);
    if (!key) continue;
    const info = insert.run({
      key,
      name: lead.business_name,
      town: lead.location,
      found: lead.created_at ?? lead.last_contacted_at ?? new Date().toISOString(),
      contacted: lead.last_contacted_at ?? null,
      channel: lead.last_contacted_at ? 'before the ledger' : null,
      times: lead.last_contacted_at ? 1 : 0,
    });
    n += info.changes;
  }
  const total = db.prepare('SELECT COUNT(*) c FROM company_ledger').get().c;
  console.log(`[db] company ledger backfilled: ${total} companies (${n} by name)`);
}

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
      -- run_places references place_cache ON DELETE CASCADE, so dropping the
      -- old place_cache would take every run_places row with it. Rebuild the
      -- child out of the way first, then the parent, then restore.
      CREATE TABLE run_places_backup AS SELECT * FROM run_places;
      DROP TABLE run_places;

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

      CREATE TABLE run_places (
        run_id   INTEGER NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
        place_id TEXT    NOT NULL REFERENCES place_cache(place_id) ON DELETE CASCADE,
        area     TEXT,
        PRIMARY KEY (run_id, place_id)
      );
      INSERT INTO run_places (run_id, place_id, area)
        SELECT run_id, place_id, area FROM run_places_backup
         WHERE place_id IN (SELECT place_id FROM place_cache);
      DROP TABLE run_places_backup;

      -- Track which lead fields came from a Places listing, so the retention
      -- panel can say exactly what is affected and purge only that.
      ALTER TABLE leads ADD COLUMN details_source TEXT;
      ALTER TABLE leads ADD COLUMN details_imported_at TEXT;
      UPDATE leads SET details_source = 'google_places', details_imported_at = created_at
        WHERE source = 'Google Places';
    `,
  },
  {
    name: '009_companies_house',
    up: `
      -- Companies House data is Open Government Licence: unlike Places
      -- content, it may be stored indefinitely. So the durable half of a
      -- lead record comes from here.
      ALTER TABLE leads ADD COLUMN registered_name    TEXT;
      ALTER TABLE leads ADD COLUMN registered_address TEXT;
      ALTER TABLE leads ADD COLUMN company_status     TEXT;
      ALTER TABLE leads ADD COLUMN company_type       TEXT;
      ALTER TABLE leads ADD COLUMN incorporated_on    TEXT;
      ALTER TABLE leads ADD COLUMN sic_codes          TEXT;
      ALTER TABLE leads ADD COLUMN checked_at         TEXT;
    `,
  },
  {
    name: '010_website_check',
    up: `
      -- Whether a lead has a website, established by a single Places lookup.
      -- Only the derived answer is stored, never the listing content.
      ALTER TABLE leads ADD COLUMN has_website        INTEGER;
      ALTER TABLE leads ADD COLUMN website_checked_at TEXT;
    `,
  },
  {
    name: '011_daily_hunt',
    up: `
      -- One row per trade x town the hunt works through, with a cursor so
      -- each day picks up where the last left off instead of re-reading the
      -- same first page of the register.
      CREATE TABLE hunt_targets (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        trade        TEXT    NOT NULL,
        sic_codes    TEXT    NOT NULL,
        area         TEXT,
        cursor       INTEGER NOT NULL DEFAULT 0,
        exhausted_at TEXT,
        last_run_at  TEXT,
        found_total  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL,
        UNIQUE (trade, area)
      );

      CREATE TABLE hunt_runs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at        TEXT NOT NULL,
        finished_at       TEXT,
        trigger           TEXT NOT NULL,
        target            INTEGER NOT NULL,
        found             INTEGER NOT NULL DEFAULT 0,
        companies_seen    INTEGER NOT NULL DEFAULT 0,
        already_known     INTEGER NOT NULL DEFAULT 0,
        had_website       INTEGER NOT NULL DEFAULT 0,
        places_requests   INTEGER NOT NULL DEFAULT 0,
        register_requests INTEGER NOT NULL DEFAULT 0,
        areas_covered     TEXT,
        error             TEXT
      );
      CREATE INDEX idx_hunt_runs_started ON hunt_runs(started_at DESC);

      -- How we came to believe a lead has no website.
      ALTER TABLE leads ADD COLUMN website_evidence TEXT;
    `,
  },
  {
    name: '012_multichannel_outreach',
    up: `
      -- Every discovered fragment of contact info: an email, a phone, a
      -- Facebook page, a WhatsApp number. One row per unique (lead, kind,
      -- value). Source and confidence are kept so the UI can show provenance
      -- and the user can decide what to trust.
      CREATE TABLE contact_signals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        kind            TEXT    NOT NULL
                                CHECK (kind IN ('email','phone','whatsapp','website','facebook','other')),
        value           TEXT    NOT NULL,
        source          TEXT    NOT NULL,
        confidence      INTEGER NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
        note            TEXT,
        first_seen_at   TEXT    NOT NULL,
        last_seen_at    TEXT    NOT NULL,
        promoted_at     TEXT,
        UNIQUE (lead_id, kind, value)
      );
      CREATE INDEX idx_signals_lead ON contact_signals(lead_id);
      CREATE INDEX idx_signals_kind ON contact_signals(kind);

      -- One row per discovery pass, so we know when a lead was last hunted
      -- and can rate-limit the outbound scraping without hammering sites.
      CREATE TABLE contact_finds (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        started_at   TEXT    NOT NULL,
        finished_at  TEXT,
        signals      INTEGER NOT NULL DEFAULT 0,
        error        TEXT,
        sources      TEXT
      );
      CREATE INDEX idx_finds_lead ON contact_finds(lead_id, started_at DESC);

      -- Every WhatsApp / SMS / call handoff we prepared. The user still taps
      -- send on their own phone, so \"prepared_at\" is what the tool did and
      -- \"confirmed_sent_at\" is what the user later marks as actually sent.
      CREATE TABLE outreach_events (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id           INTEGER REFERENCES leads(id)     ON DELETE SET NULL,
        template_id       INTEGER REFERENCES templates(id) ON DELETE SET NULL,
        lead_name         TEXT    NOT NULL,
        channel           TEXT    NOT NULL
                                  CHECK (channel IN ('whatsapp','sms','call')),
        recipient         TEXT    NOT NULL,
        body_snapshot     TEXT,
        prepared_at       TEXT    NOT NULL,
        confirmed_sent_at TEXT
      );
      CREATE INDEX idx_outreach_lead ON outreach_events(lead_id);
      CREATE INDEX idx_outreach_prep ON outreach_events(prepared_at DESC);

      -- Templates get a channel. Existing rows keep the default 'email'
      -- so nothing already saved has to change.
      ALTER TABLE templates ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'
        CHECK (channel IN ('email','whatsapp','sms'));
    `,
  },
  {
    name: '013_replies_briefs_mockups',
    up: `
      -- Every inbound message we have matched to a lead. Body is stored in
      -- full because the brief is derived from it and we want to be able to
      -- re-derive when the extractor improves.
      CREATE TABLE replies (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id        INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        channel        TEXT    NOT NULL DEFAULT 'email'
                               CHECK (channel IN ('email','whatsapp','sms','manual')),
        provider_id    TEXT    UNIQUE,
        thread_id      TEXT,
        from_address   TEXT,
        subject        TEXT,
        body           TEXT    NOT NULL,
        received_at    TEXT    NOT NULL,
        fetched_at     TEXT    NOT NULL,
        read_at        TEXT
      );
      CREATE INDEX idx_replies_lead ON replies(lead_id, received_at DESC);
      CREATE INDEX idx_replies_recv ON replies(received_at DESC);

      -- The structured brief pulled out of a reply. One per reply; a later
      -- re-extraction replaces it. 'source' records whether the rules alone
      -- produced it or the local model was involved, so the UI can show how
      -- much to trust it.
      CREATE TABLE briefs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        reply_id       INTEGER NOT NULL UNIQUE REFERENCES replies(id) ON DELETE CASCADE,
        lead_id        INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        services       TEXT,
        primary_cta    TEXT,
        areas          TEXT,
        has_logo       INTEGER NOT NULL DEFAULT 0 CHECK (has_logo IN (0,1)),
        has_photos     INTEGER NOT NULL DEFAULT 0 CHECK (has_photos IN (0,1)),
        brand_colours  TEXT,
        tone           TEXT,
        notes          TEXT,
        source         TEXT    NOT NULL DEFAULT 'rules',
        confidence     INTEGER NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
        edited_by_user INTEGER NOT NULL DEFAULT 0 CHECK (edited_by_user IN (0,1)),
        created_at     TEXT    NOT NULL,
        updated_at     TEXT    NOT NULL
      );
      CREATE INDEX idx_briefs_lead ON briefs(lead_id);

      -- A generated multi-page mockup. Files live on disk under
      -- data/mockups/<token>/; the token is the only secret protecting the
      -- preview URL, so it is long and random.
      CREATE TABLE mockups (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        brief_id     INTEGER REFERENCES briefs(id) ON DELETE SET NULL,
        token        TEXT    NOT NULL UNIQUE,
        business_name TEXT   NOT NULL,
        trade        TEXT,
        pages        TEXT    NOT NULL,
        palette      TEXT,
        generated_at TEXT    NOT NULL,
        sent_at      TEXT,
        opened_at    TEXT,
        error        TEXT
      );
      CREATE INDEX idx_mockups_lead ON mockups(lead_id, generated_at DESC);
    `,
  },
  {
    name: '014_trading_name',
    up: `
      -- The name they actually trade under, which is routinely not the name
      -- on the register. Companies House gives "HILLSIDE ROOFING LTD"; the
      -- van says "Hillside Roofing". The site should say what the van says.
      ALTER TABLE briefs ADD COLUMN trading_name TEXT;
    `,
  },
  {
    name: '015_company_ledger',
    up: `
      -- A permanent record of every company this tool has ever put in front
      -- of the owner, and whether it has ever been contacted.
      --
      -- It has to be a separate table because the lead row is not durable:
      -- DELETE FROM leads is a hard delete, and the hunt's only defence
      -- against re-finding a company is "SELECT 1 FROM leads WHERE
      -- company_number = ?". Delete a lead you were not interested in and
      -- tomorrow's hunt files it again, spends a Places request on it, and
      -- offers it up for a second cold email. suppression_list already
      -- outlives the lead for exactly this reason; this is the same idea
      -- applied to "have I already approached this business".
      --
      -- Keyed on company_key rather than on lead id, so two lead rows for one
      -- real company — a Places import and a register import of the same
      -- business — count as one company. See companyKey() in lib/recontact.js.
      CREATE TABLE company_ledger (
        company_key    TEXT PRIMARY KEY,
        company_number TEXT,
        business_name  TEXT,
        location       TEXT,
        found_at       TEXT NOT NULL,
        contacted_at   TEXT,
        last_channel   TEXT,
        times_contacted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_company_ledger_number ON company_ledger (company_number);
      CREATE INDEX idx_company_ledger_contacted ON company_ledger (contacted_at);
    `,
  },
  {
    name: '016_one_row_per_company',
    up: `
      -- One company, one lead row.
      --
      -- company_number arrived as a plain nullable TEXT column, was written
      -- exactly as typed, and was compared with a case-sensitive '='. So
      -- 'sc123456' and 'SC123456' were two different companies as far as
      -- every dedupe check was concerned — and the checks were only ever soft
      -- anyway: SELECT-then-INSERT with a network round trip in between, from
      -- a process holding a lock no other process can see.
      --
      -- Two rows for one business are two independent targets. Each can be
      -- emailed, each can be WhatsApped, and the owner sees no connection
      -- between them. To the business it is one firm contacting them twice.
      --
      -- Numbers are folded to upper case here; the duplicate merge and the
      -- UNIQUE index follow in the JS half, which needs real logic.
      UPDATE leads
         SET company_number = UPPER(TRIM(company_number))
       WHERE company_number IS NOT NULL AND TRIM(company_number) <> '';

      UPDATE leads SET company_number = NULL
       WHERE company_number IS NOT NULL AND TRIM(company_number) = '';
    `,
    run: mergeDuplicateCompanies,
  },
  {
    name: '017_send_queue_allow_repeat',
    up: `
      -- A queue row the owner deliberately wants sent to a company already
      -- contacted. Without it the send loop's re-check, which runs after the
      -- row may have sat overnight, would refuse the very thing the owner
      -- asked for at queue time.
      ALTER TABLE send_queue ADD COLUMN allow_repeat INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '018_company_ledger_name_key',
    up: `
      -- A second way into the same ledger row.
      --
      -- The register path knows a company number and nothing else useful; the
      -- Places path knows a trading name and a town and never learns a
      -- number. Keyed on one of those, the two funnels are blind to each
      -- other and the same business arrives down both — as two leads, each
      -- independently contactable.
      --
      -- So every row carries a name key as well as its primary key, and a
      -- lookup tries both. The name key is weaker (two firms called "Ace
      -- Plumbing" in one town collide), but the failure it causes is that one
      -- of them is not contacted, which is much cheaper than contacting the
      -- same one twice.
      ALTER TABLE company_ledger ADD COLUMN name_key TEXT;
      CREATE INDEX idx_company_ledger_name ON company_ledger (name_key);
    `,
  },
  {
    name: '020_hunt_runs_no_contact',
    up: `
      -- Companies skipped because Google held no phone number for them.
      -- Counted separately so a short run can say "found 6, skipped 40 with
      -- no phone" rather than just coming up short and looking broken.
      ALTER TABLE hunt_runs ADD COLUMN no_contact INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '021_hunt_runs_wrong_town',
    up: `
      -- Companies the register returned that are not in the town we asked
      -- for. Its location filter matches the whole registered office
      -- address, so "Stone" finds companies on Stone Road in Aylesbury.
      ALTER TABLE hunt_runs ADD COLUMN wrong_town INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '019_backfill_company_ledger',
    up: `
      -- Carry the leads that already exist into the ledger, so the guarantee
      -- covers the list the owner has been working rather than starting from
      -- whenever this upgrade landed. Without it, every lead emailed last
      -- week is a clean sheet again.
      --
      -- company_key mirrors companyKey() in lib/recontact.js: 'ch:<NUMBER>'
      -- when we hold a number. Rows without one are backfilled in the JS half,
      -- which can run the same name normaliser the application uses rather
      -- than a SQL approximation of it that would drift from it.
      INSERT OR IGNORE INTO company_ledger
        (company_key, company_number, business_name, location,
         found_at, contacted_at, last_channel, times_contacted)
      SELECT 'ch:' || UPPER(TRIM(company_number)),
             UPPER(TRIM(company_number)),
             business_name,
             location,
             COALESCE(created_at, last_contacted_at),
             last_contacted_at,
             CASE WHEN last_contacted_at IS NOT NULL THEN 'before the ledger' END,
             CASE WHEN last_contacted_at IS NOT NULL THEN 1 ELSE 0 END
        FROM leads
       WHERE company_number IS NOT NULL AND TRIM(company_number) <> '';
    `,
    run: backfillLedgerNameKeys,
  },
  {
    name: '022_hunt_runs_not_mobile',
    up: `
      -- Companies skipped because the only number Google held was a landline.
      -- WhatsApp and SMS reach 07 numbers and nothing else, so a landline is
      -- a call and only a call. Counted separately from no_contact: "Google
      -- had no number" and "Google had a number you cannot message" are
      -- different problems with different answers.
      ALTER TABLE hunt_runs ADD COLUMN not_mobile INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '023_starter_templates',
    run: seedStarterTemplates,
  },
  {
    name: '024_raise_hunt_budget',
    // The per-run budget shipped far too low: 25 register pages and 40 Google
    // lookups. Because most high-street trades are sole traders the register
    // does not hold, a run burned that budget turning up only a handful of
    // limited companies and stopped — looking, wrongly, like it had run out
    // of towns. The defaults are raised; this carries an install that already
    // saved the old ones up with them, but ONLY where the stored value is
    // still at or below the old ceiling, so a number the owner deliberately
    // set higher is never pulled down.
    run: () => {
      const bump = (key, atOrBelow, to) => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (!row) return; // never saved → the new, higher default already applies
        const n = Number(row.value);
        if (Number.isFinite(n) && n <= atOrBelow) {
          db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(to), key);
        }
      };
      bump('hunt_max_register_pages', 80, 200);
      bump('hunt_max_places_requests', 80, 120);
    },
  },
  {
    name: '025_users_and_sessions',
    up: `
      -- Accounts, so the hub can be reached by a team over the internet
      -- without handing the URL-holder the whole database. Email is stored
      -- lowercased and unique; the password is a scrypt hash, never the
      -- plaintext. See server/lib/auth.js.
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('admin','rep')),
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        last_login_at TEXT
      );

      -- One row per signed-in browser. token_hash is the SHA-256 of the
      -- cookie value, never the value itself, so a dump of this table cannot
      -- be replayed as a live session.
      CREATE TABLE sessions (
        token_hash   TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
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
      if (m.up) db.exec(m.up);
      // Some migrations cannot be expressed as a statement list — merging
      // duplicate rows has to read what is there and decide. `run` executes
      // inside the same transaction, so a failure rolls the whole migration
      // back rather than leaving the schema half-moved.
      if (m.run) m.run();
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

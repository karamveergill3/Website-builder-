import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { wrap, badRequest, notFound, conflict, nowIso, str, int, bool } from '../lib/http.js';
import {
  textSearch, placeDetails, normalise, parseAreas, buildQuery, estimateCost,
  PlacesError, PRICING_DEFAULTS, PRICING_SOURCE,
} from '../lib/places.js';
import { looksCorporate } from '../lib/pecr.js';
import { recordFound, ledgerFor } from '../lib/recontact.js';

const router = Router();

const MAX_AREAS = 60;
const MAX_PAGES_PER_AREA = 3;   // Google caps Text Search at 3 pages / 60 places
const PAUSE_BETWEEN_CALLS_MS = 250;

/** Only one sweep at a time — this is a single-user tool and spend is real. */
let activeRun = null;

/**
 * Candidate names, addresses and phone numbers from a sweep, held in memory
 * for the length of a review session and never written to the database.
 * Google's terms permit caching the place ID but not the listing content, so
 * this is the only place that content lives -- and it goes when the process
 * does, or after CANDIDATE_TTL_MS, whichever is sooner.
 */
const CANDIDATE_TTL_MS = 60 * 60 * 1000;
const runCandidates = new Map();   // run_id -> { expiresAt, byPlaceId: Map }

/** Open a review session for a run, so an empty result set is still "live". */
function openSession(runId) {
  runCandidates.set(runId, {
    expiresAt: Date.now() + CANDIDATE_TTL_MS,
    byPlaceId: new Map(),
  });
}

function rememberCandidate(runId, row, area) {
  const entry = runCandidates.get(runId);
  if (!entry) return;
  // A long sweep must not outlive its own session and start dropping results,
  // so every candidate pushes the expiry back.
  entry.expiresAt = Date.now() + CANDIDATE_TTL_MS;
  entry.byPlaceId.set(row.place_id, { ...row, area });
}

function recallCandidates(runId) {
  const entry = runCandidates.get(runId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { runCandidates.delete(runId); return null; }
  return entry.byPlaceId;
}

/** Drop expired sessions; called whenever a sweep starts. */
function sweepCandidateCache() {
  for (const [id, entry] of runCandidates) {
    if (Date.now() > entry.expiresAt) runCandidates.delete(id);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pricing the user can correct without touching code, because Google reprices
 * Maps Platform periodically. `verified_on` stays null until they have opened
 * Google's billing page and confirmed the figures.
 */
const rates = () => ({
  text_search_per_1000: Number(
    getSetting('places_text_search_per_1000', String(PRICING_DEFAULTS.text_search_per_1000))
  ),
  place_details_per_1000: Number(
    getSetting('places_details_per_1000', String(PRICING_DEFAULTS.place_details_per_1000))
  ),
  free_calls_per_sku_per_month: Number(
    getSetting('places_free_calls_per_month', String(PRICING_DEFAULTS.free_calls_per_sku_per_month))
  ),
  verified_on: getSetting('places_pricing_verified_on', null) || null,
});

/* ---------------------------------------------------------------- helpers */

const knownPlaceIds = () => new Set([
  ...db.prepare('SELECT place_id FROM place_cache').all().map((r) => r.place_id),
  ...db.prepare('SELECT google_place_id FROM leads WHERE google_place_id IS NOT NULL')
       .all().map((r) => r.google_place_id),
]);

/**
 * Persist only what the terms permit: the place ID, whether it had a website,
 * and our own query text. Names, addresses and phone numbers stay in memory.
 */
const upsertPlace = db.transaction((row, runId, area) => {
  // An upsert, not a branch on "have we seen this before": a place ID can be
  // known from a hand-entered lead while having no place_cache row at all, and
  // the run_places insert below has a foreign key onto that row.
  db.prepare(
    `INSERT INTO place_cache
       (place_id, has_website, imported, first_seen_at, refreshed_at, query_text)
     VALUES (@place_id, @has_website, 0, @now, @now, @query_text)
     ON CONFLICT(place_id) DO UPDATE SET
       has_website  = excluded.has_website,
       refreshed_at = excluded.refreshed_at`
  ).run({ place_id: row.place_id, has_website: row.has_website, now: nowIso(), query_text: area });

  db.prepare('INSERT OR IGNORE INTO run_places (run_id, place_id, area) VALUES (?, ?, ?)')
    .run(runId, row.place_id, area);
});

/**
 * Candidates for review: found by this run, no website, not already a lead.
 * The durable half (IDs, flags) comes from the database; the displayable half
 * (name, address, phone) comes from the in-memory session and is absent once
 * that has expired.
 */
function candidatesForRun(runId) {
  const content = recallCandidates(runId);
  const rows = db.prepare(`
    SELECT pc.place_id, pc.imported, pc.first_seen_at, rp.area,
           EXISTS (SELECT 1 FROM leads l WHERE l.google_place_id = pc.place_id) AS is_lead
      FROM run_places rp
      JOIN place_cache pc ON pc.place_id = rp.place_id
     WHERE rp.run_id = ? AND pc.has_website = 0
     ORDER BY rp.area
  `).all(runId).map((r) => {
    const c = content?.get(r.place_id);
    return {
      ...r,
      is_lead: r.is_lead === 1,
      imported: r.imported === 1,
      display_name: c?.display_name ?? null,
      address: c?.address ?? null,
      phone: c?.phone ?? null,
    };
  });
  rows.sort((a, b) =>
    (a.area ?? '').localeCompare(b.area ?? '') ||
    (a.display_name ?? '').localeCompare(b.display_name ?? ''));
  return { rows, contentAvailable: Boolean(content) };
}

const updateRun = (id, patch) => db.prepare(
  `UPDATE search_runs SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`
).run({ ...patch, id });

/* ------------------------------------------------------------ the sweep */

async function runSweep(runId, { category, areas, pagesPerArea, regionCode, verifyWithDetails }) {
  const counters = { text_search_calls: 0, places_returned: 0, places_new: 0, candidates_found: 0 };
  const known = knownPlaceIds();

  try {
    for (const area of areas) {
      let pageToken;
      for (let page = 0; page < pagesPerArea; page++) {
        const { places, nextPageToken } = await textSearch(
          buildQuery(category, area),
          { regionCode, pageToken }
        );
        counters.text_search_calls++;
        counters.places_returned += places.length;

        for (const place of places) {
          if (!place.id) continue;
          const row = normalise(place);
          const alreadyKnown = known.has(row.place_id);
          if (!alreadyKnown) { counters.places_new++; known.add(row.place_id); }
          upsertPlace(row, runId, area);
          if (row.has_website === 0) rememberCandidate(runId, row, area);
          if (row.has_website === 0) counters.candidates_found++;
        }

        updateRun(runId, counters);
        if (!nextPageToken) break;
        pageToken = nextPageToken;
        await sleep(PAUSE_BETWEEN_CALLS_MS);
      }
      await sleep(PAUSE_BETWEEN_CALLS_MS);
    }

    // Optional belt-and-braces pass: confirm "no website" with a Place Details
    // call. Off by default because Text Search already answered the question,
    // and this bills once per candidate. Never touches a place we already knew.
    if (verifyWithDetails) {
      const toCheck = db.prepare(`
        SELECT pc.place_id FROM run_places rp
          JOIN place_cache pc ON pc.place_id = rp.place_id
         WHERE rp.run_id = ? AND pc.has_website = 0 AND pc.first_seen_at = pc.refreshed_at
      `).all(runId);
      for (const { place_id } of toCheck) {
        const detail = await placeDetails(place_id);
        const row = normalise({ ...detail, id: place_id });
        // Only the derived flag is storable -- website_uri is Maps Content.
        db.prepare(
          'UPDATE place_cache SET has_website = @has_website, refreshed_at = @now WHERE place_id = @place_id'
        ).run({ place_id, has_website: row.has_website, now: nowIso() });
        await sleep(PAUSE_BETWEEN_CALLS_MS);
      }
    }

    updateRun(runId, { ...counters, finished_at: nowIso() });
  } catch (err) {
    updateRun(runId, {
      ...counters,
      finished_at: nowIso(),
      error: err instanceof PlacesError ? `${err.code}: ${err.message}` : err.message,
    });
  } finally {
    activeRun = null;
  }
}

/* -------------------------------------------------------------- routes */

router.get('/status', wrap((_req, res) => {
  res.json({
    configured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    active_run: activeRun,
    pricing: { ...rates(), currency: PRICING_DEFAULTS.currency, source: PRICING_SOURCE },
    limits: { max_areas: MAX_AREAS, max_pages_per_area: MAX_PAGES_PER_AREA },
    cached_places: db.prepare('SELECT COUNT(*) n FROM place_cache').get().n,
    cached_without_website: db.prepare('SELECT COUNT(*) n FROM place_cache WHERE has_website = 0').get().n,
    // Only place IDs and the has-a-website flag are stored; see migration 008.
    stores_listing_content: false,
    live_review_sessions: runCandidates.size,
    default_areas: getSetting('default_areas', ''),
    default_region_code: getSetting('default_region_code', 'GB'),
  });
}));

router.get('/estimate', wrap((req, res) => {
  res.json(estimateCost({
    areas: parseAreas(req.query.areas).length,
    pagesPerArea: int(req.query.pages_per_area, 1),
    rates: rates(),
  }));
}));

/** POST /api/places/search — start a sweep. Nothing is imported by this. */
router.post('/search', wrap((req, res) => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new PlacesError(
      'GOOGLE_MAPS_API_KEY is not set. Add it to .env — see docs/PHASE2-PLACES.md.',
      { status: 503, code: 'NO_API_KEY' }
    );
  }
  if (activeRun) throw conflict('A search is already running. Wait for it to finish.');

  const category = str(req.body.category);
  if (!category) throw badRequest('category is required, e.g. "roofers"');

  // A location is optional: with no areas, the category is searched on its own
  // and Google decides the geography (biased by regionCode).
  const areas = parseAreas(req.body.areas);
  if (areas.length > MAX_AREAS) throw badRequest(`At most ${MAX_AREAS} areas per sweep.`);
  const sweepAreas = areas.length ? areas : [null];

  const pagesPerArea = Math.min(Math.max(int(req.body.pages_per_area, 1), 1), MAX_PAGES_PER_AREA);
  const regionCode = str(req.body.region_code) ?? getSetting('default_region_code', 'GB');
  const verifyWithDetails = bool(req.body.verify_with_details);

  const info = db.prepare(
    `INSERT INTO search_runs (category, areas, started_at) VALUES (?, ?, ?)`
  ).run(category, areas.join('\n'), nowIso());

  const runId = Number(info.lastInsertRowid);
  sweepCandidateCache();
  openSession(runId);
  activeRun = { id: runId, category, areas: areas.length };

  // Fire and forget: the client polls GET /runs/:id for progress.
  runSweep(runId, { category, areas: sweepAreas, pagesPerArea, regionCode, verifyWithDetails });

  res.status(202).json({
    run: db.prepare('SELECT * FROM search_runs WHERE id = ?').get(runId),
    estimate: estimateCost({ areas: sweepAreas.length, pagesPerArea, rates: rates() }),
  });
}));

router.get('/runs', wrap((_req, res) => {
  res.json({
    runs: db.prepare('SELECT * FROM search_runs ORDER BY id DESC LIMIT 40').all(),
    active_run: activeRun,
  });
}));

router.get('/runs/:id', wrap((req, res) => {
  const run = db.prepare('SELECT * FROM search_runs WHERE id = ?').get(req.params.id);
  if (!run) throw notFound('Search run not found');
  const { rows: candidates, contentAvailable } = candidatesForRun(run.id);
  res.json({
    run,
    running: activeRun?.id === run.id,
    areas: run.areas ? run.areas.split('\n') : [],
    candidates,
    // Listing details are held for the review session only, never stored.
    // Once they have gone the run still knows WHICH places had no website,
    // but re-running the search is the only way to see who they were.
    content_available: contentAvailable,
    content_ttl_minutes: CANDIDATE_TTL_MS / 60000,
    summary: {
      candidates: candidates.length,
      new_candidates: candidates.filter((c) => !c.is_lead && !c.imported).length,
      already_leads: candidates.filter((c) => c.is_lead).length,
      with_phone: candidates.filter((c) => c.phone).length,
    },
  });
}));

/**
 * POST /api/places/import — turn checked candidates into leads.
 * Explicitly opt-in: nothing is ever imported without this call.
 */
router.post('/import', wrap((req, res) => {
  const runId = int(req.body.run_id);
  const placeIds = Array.isArray(req.body.place_ids) ? req.body.place_ids.map(String) : [];
  if (placeIds.length === 0) throw badRequest('Tick at least one business to add.');

  const run = runId ? db.prepare('SELECT * FROM search_runs WHERE id = ?').get(runId) : null;
  const imported = [];
  const skipped = [];

  const content = runId ? recallCandidates(runId) : null;
  if (runId && !content) {
    throw conflict(
      'Those search results have expired. Listing details are held only for the length of a ' +
      'review session and are never stored, so run the search again to import from it.'
    );
  }

  const doImport = db.transaction(() => {
    for (const placeId of placeIds) {
      const place = db.prepare('SELECT * FROM place_cache WHERE place_id = ?').get(placeId);
      if (!place) { skipped.push({ place_id: placeId, reason: 'not in the search results' }); continue; }
      if (place.has_website === 1) { skipped.push({ place_id: placeId, reason: 'has a website' }); continue; }

      const existing = db.prepare('SELECT id FROM leads WHERE google_place_id = ?').get(placeId);
      if (existing) { skipped.push({ place_id: placeId, reason: 'already a lead' }); continue; }

      const details = content?.get(placeId);
      if (!details) { skipped.push({ place_id: placeId, reason: 'details no longer in the review session' }); continue; }
      const area = details.area ?? null;

      // The place id is not the only way we might already hold this business.
      // A Places import keys on place_id and a register import keys on
      // company_number, so the two paths were blind to each other: the same
      // roofer could arrive twice and be contacted twice, once down each
      // funnel. The ledger's name-and-town key spans both, and it also
      // remembers a business whose lead the owner deleted.
      const known = ledgerFor({
        business_name: details.display_name,
        location: area,
      });
      if (known) {
        skipped.push({
          place_id: placeId,
          reason: known.contacted_at
            ? `already contacted on ${String(known.contacted_at).slice(0, 10)}`
            : 'already found under another source',
        });
        continue;
      }

      // Imported leads always start unclassified. A name ending in "Ltd" is a
      // hint, not proof of incorporation, so it never auto-unblocks sending --
      // it only shows up in the UI as a suggestion to check Companies House.
      const info = db.prepare(
        `INSERT INTO leads
           (business_name, category, location, phone, google_place_id, status,
            notes, source, opted_out, entity_type, created_at)
         VALUES (@name, @category, @location, @phone, @place_id, 'new', @notes, @source, 0,
                 'unknown', @now)`
      ).run({
        name: details.display_name ?? '(unnamed business)',
        category: run?.category ?? null,
        location: area ?? null,
        phone: details.phone,
        place_id: placeId,
        notes: details.address ? `Address: ${details.address}` : null,
        source: 'Google Places',
        now: nowIso(),
      });
      db.prepare(
        "UPDATE leads SET details_source = 'google_places', details_imported_at = ? WHERE id = ?"
      ).run(nowIso(), info.lastInsertRowid);
      recordFound({
        business_name: details.display_name ?? null,
        location: area ?? null,
        company_number: null,
      });

      db.prepare('UPDATE place_cache SET imported = 1 WHERE place_id = ?').run(placeId);
      imported.push(Number(info.lastInsertRowid));
    }
  });
  doImport();

  res.status(201).json({
    imported: imported.length,
    skipped,
    // How many of the new leads have a name that suggests a limited company,
    // so the UI can say how much checking is left to do.
    looks_corporate: imported.filter((id) =>
      looksCorporate(db.prepare('SELECT business_name FROM leads WHERE id = ?').get(id)?.business_name)
    ).length,
    leads: imported.length
      ? db.prepare(`SELECT * FROM leads WHERE id IN (${imported.map(() => '?').join(',')})`).all(...imported)
      : [],
  });
}));

/**
 * POST /api/places/check-website — for leads that came from Companies House,
 * ask Google once each whether they have a website. One billed Text Search
 * per lead, and only the yes/no answer is kept.
 */
router.post('/check-website', wrap(async (req, res) => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new PlacesError('GOOGLE_MAPS_API_KEY is not set.', { status: 503, code: 'NO_API_KEY' });
  }
  const ids = Array.isArray(req.body.lead_ids) ? req.body.lead_ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) throw badRequest('Pick at least one lead.');
  if (ids.length > 60) throw badRequest('At most 60 at a time — each one is a billed request.');

  const rows = db.prepare(
    `SELECT id, business_name, registered_name, location FROM leads
      WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);

  const results = [];
  for (const lead of rows) {
    const name = lead.business_name ?? lead.registered_name;
    const query = [name, lead.location].filter(Boolean).join(' ');
    try {
      const { places } = await textSearch(query, { regionCode: getSetting('default_region_code', 'GB'), pageSize: 1 });
      const top = places[0];
      if (!top) {
        results.push({ lead_id: lead.id, name, found: false });
      } else {
        const row = normalise(top);
        db.prepare('UPDATE leads SET has_website = ?, website_checked_at = ? WHERE id = ?')
          .run(row.has_website, nowIso(), lead.id);
        results.push({
          lead_id: lead.id, name, found: true,
          has_website: row.has_website === 1,
          matched_name: row.display_name,
          phone: row.phone,
        });
      }
    } catch (err) {
      results.push({ lead_id: lead.id, name, error: err.message });
    }
    await sleep(PAUSE_BETWEEN_CALLS_MS);
  }

  res.json({
    checked: results.length,
    without_website: results.filter((r) => r.has_website === false).length,
    results,
  });
}));

export default router;

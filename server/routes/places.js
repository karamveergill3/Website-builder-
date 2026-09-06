import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { wrap, badRequest, notFound, conflict, nowIso, str, int, bool } from '../lib/http.js';
import {
  textSearch, placeDetails, normalise, parseAreas, buildQuery, estimateCost,
  PlacesError, PRICING,
} from '../lib/places.js';

const router = Router();

const MAX_AREAS = 60;
const MAX_PAGES_PER_AREA = 3;   // Google caps Text Search at 3 pages / 60 places
const PAUSE_BETWEEN_CALLS_MS = 250;

/** Only one sweep at a time — this is a single-user tool and spend is real. */
let activeRun = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- helpers */

const knownPlaceIds = () => new Set([
  ...db.prepare('SELECT place_id FROM place_cache').all().map((r) => r.place_id),
  ...db.prepare('SELECT google_place_id FROM leads WHERE google_place_id IS NOT NULL')
       .all().map((r) => r.google_place_id),
]);

const upsertPlace = db.transaction((row, runId, area, alreadyKnown) => {
  if (alreadyKnown) {
    // Refresh the cached copy we just received for free in the page response.
    db.prepare(
      `UPDATE place_cache SET display_name=@display_name, address=@address, phone=@phone,
         website_uri=@website_uri, has_website=@has_website, refreshed_at=@now
       WHERE place_id=@place_id`
    ).run({ ...row, now: nowIso() });
  } else {
    db.prepare(
      `INSERT INTO place_cache
         (place_id, display_name, address, phone, website_uri, has_website,
          imported, first_seen_at, refreshed_at, query_text)
       VALUES (@place_id, @display_name, @address, @phone, @website_uri, @has_website,
               0, @now, @now, @query_text)`
    ).run({ ...row, now: nowIso(), query_text: area });
  }
  db.prepare('INSERT OR IGNORE INTO run_places (run_id, place_id, area) VALUES (?, ?, ?)')
    .run(runId, row.place_id, area);
});

/** Candidates for review: found by this run, no website, not already a lead. */
function candidatesForRun(runId) {
  return db.prepare(`
    SELECT pc.*, rp.area,
           EXISTS (SELECT 1 FROM leads l WHERE l.google_place_id = pc.place_id) AS is_lead
      FROM run_places rp
      JOIN place_cache pc ON pc.place_id = rp.place_id
     WHERE rp.run_id = ? AND pc.has_website = 0
     ORDER BY rp.area, pc.display_name COLLATE NOCASE
  `).all(runId).map((r) => ({ ...r, is_lead: r.is_lead === 1, imported: r.imported === 1 }));
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
          upsertPlace(row, runId, area, alreadyKnown);
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
        db.prepare(
          `UPDATE place_cache SET website_uri=@website_uri, has_website=@has_website,
             refreshed_at=@now WHERE place_id=@place_id`
        ).run({ ...row, now: nowIso() });
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
    pricing: PRICING,
    limits: { max_areas: MAX_AREAS, max_pages_per_area: MAX_PAGES_PER_AREA },
    cached_places: db.prepare('SELECT COUNT(*) n FROM place_cache').get().n,
    cached_without_website: db.prepare('SELECT COUNT(*) n FROM place_cache WHERE has_website = 0').get().n,
    default_areas: getSetting('default_areas', ''),
    default_region_code: getSetting('default_region_code', 'GB'),
  });
}));

router.get('/estimate', wrap((req, res) => {
  res.json(estimateCost({
    areas: parseAreas(req.query.areas).length,
    pagesPerArea: int(req.query.pages_per_area, 1),
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

  const areas = parseAreas(req.body.areas);
  if (areas.length === 0) throw badRequest('Give at least one town or city to search.');
  if (areas.length > MAX_AREAS) throw badRequest(`At most ${MAX_AREAS} areas per sweep.`);

  const pagesPerArea = Math.min(Math.max(int(req.body.pages_per_area, 1), 1), MAX_PAGES_PER_AREA);
  const regionCode = str(req.body.region_code) ?? getSetting('default_region_code', 'GB');
  const verifyWithDetails = bool(req.body.verify_with_details);

  const info = db.prepare(
    `INSERT INTO search_runs (category, areas, started_at) VALUES (?, ?, ?)`
  ).run(category, areas.join('\n'), nowIso());

  const runId = Number(info.lastInsertRowid);
  activeRun = { id: runId, category, areas: areas.length };

  // Fire and forget: the client polls GET /runs/:id for progress.
  runSweep(runId, { category, areas, pagesPerArea, regionCode, verifyWithDetails });

  res.status(202).json({
    run: db.prepare('SELECT * FROM search_runs WHERE id = ?').get(runId),
    estimate: estimateCost({ areas: areas.length, pagesPerArea }),
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
  const candidates = candidatesForRun(run.id);
  res.json({
    run,
    running: activeRun?.id === run.id,
    areas: run.areas.split('\n'),
    candidates,
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

  const doImport = db.transaction(() => {
    for (const placeId of placeIds) {
      const place = db.prepare('SELECT * FROM place_cache WHERE place_id = ?').get(placeId);
      if (!place) { skipped.push({ place_id: placeId, reason: 'not in the search results' }); continue; }
      if (place.has_website === 1) { skipped.push({ place_id: placeId, reason: 'has a website' }); continue; }

      const existing = db.prepare('SELECT id FROM leads WHERE google_place_id = ?').get(placeId);
      if (existing) { skipped.push({ place_id: placeId, reason: 'already a lead' }); continue; }

      const area = runId
        ? db.prepare('SELECT area FROM run_places WHERE run_id = ? AND place_id = ?')
            .get(runId, placeId)?.area
        : null;

      const info = db.prepare(
        `INSERT INTO leads
           (business_name, category, location, phone, google_place_id, status,
            notes, source, opted_out, created_at)
         VALUES (@name, @category, @location, @phone, @place_id, 'new', @notes, @source, 0, @now)`
      ).run({
        name: place.display_name ?? '(unnamed business)',
        category: run?.category ?? null,
        location: area ?? null,
        phone: place.phone,
        place_id: placeId,
        notes: place.address ? `Address: ${place.address}` : null,
        source: 'Google Places',
        now: nowIso(),
      });

      db.prepare('UPDATE place_cache SET imported = 1 WHERE place_id = ?').run(placeId);
      imported.push(Number(info.lastInsertRowid));
    }
  });
  doImport();

  res.status(201).json({
    imported: imported.length,
    skipped,
    leads: imported.length
      ? db.prepare(`SELECT * FROM leads WHERE id IN (${imported.map(() => '?').join(',')})`).all(...imported)
      : [],
  });
}));

export default router;

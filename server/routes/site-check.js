/**
 * Check the leads already on file for a website of their own.
 *
 * The hunt now looks on the web before filing anyone, but leads filed before
 * that were judged on Google's listing alone, and some of them (COSELEY
 * SERVICES LIMITED was the one that showed it) have a site Google does not
 * link. This runs the same check over existing leads and marks the ones that
 * turn out to have a site, so they stop being pitched a website they own.
 *
 *   POST /api/leads/site-check          { lead_ids? }  start (202)
 *   GET  /api/leads/site-check/status                  progress
 *   POST /api/leads/site-check/stop                    stop after this lead
 *
 * Background, like Find contacts: each lead is a few fetches and, when the
 * guesses find nothing, one web search spaced a few seconds from the last.
 */
import { Router } from 'express';
import { db } from '../db.js';
import { wrap, badRequest, nowIso } from '../lib/http.js';
import { findWebsite, postcodeIn } from '../lib/site-check.js';
import { recordSiteVerdict, searchGapMs, notePossibleSite } from '../lib/hunter.js';

const router = Router();

let run = null;
export const activeSiteCheck = () => run;

/** Everything on file that helps tell their site from someone else's. */
export function bizFromLead(lead) {
  const signals = db.prepare(
    "SELECT kind, value FROM contact_signals WHERE lead_id = ? AND kind IN ('phone', 'website')"
  ).all(lead.id);
  return {
    names: [lead.business_name, lead.registered_name].filter(Boolean),
    phones: [lead.phone, ...signals.filter((s) => s.kind === 'phone').map((s) => s.value)].filter(Boolean),
    postcode: postcodeIn(lead.registered_address) ?? postcodeIn(lead.notes),
    towns: [lead.location].filter(Boolean),
    email: lead.email ?? null,
    knownUrls: [lead.website, ...signals.filter((s) => s.kind === 'website').map((s) => s.value)]
      .filter(Boolean),
  };
}

const subjectsOf = (lead) => [
  lead.company_number && `ch:${String(lead.company_number).trim().toUpperCase()}`,
  lead.google_place_id && `pl:${lead.google_place_id}`,
];

/** The lead has a site: record it, and where, and how we know. */
export function markHasWebsite(lead, found) {
  const now = nowIso();
  db.prepare(
    `UPDATE leads SET has_website = 1, website = ?, website_checked_at = ?, website_evidence = ?
      WHERE id = ?`
  ).run(found.url, now, `site-check:${found.how}`, lead.id);
  db.prepare(
    `INSERT INTO contact_signals
       (lead_id, kind, value, source, confidence, note, first_seen_at, last_seen_at)
     VALUES (?, 'website', ?, 'site-check', 95, ?, ?, ?)
     ON CONFLICT(lead_id, kind, value) DO UPDATE SET
       last_seen_at = excluded.last_seen_at, confidence = MAX(confidence, 95), note = excluded.note`
  ).run(lead.id, found.url, `their website (${(found.evidence ?? []).join(', ') || 'checked'})`, now, now);
  recordSiteVerdict(subjectsOf(lead), 'site', found);
}

/** Looked, found nothing: say so on the lead without claiming more than that. */
function markChecked(lead, { complete }) {
  db.prepare(
    `UPDATE leads SET website_checked_at = ?,
       has_website = COALESCE(has_website, 0),
       website_evidence = CASE
         WHEN website_evidence IS NULL THEN 'web'
         WHEN website_evidence LIKE '%+web' OR website_evidence = 'web' THEN website_evidence
         ELSE website_evidence || '+web' END
     WHERE id = ?`
  ).run(nowIso(), lead.id);
  if (complete) recordSiteVerdict(subjectsOf(lead), 'none');
}

router.post('/leads/site-check', wrap(async (req, res) => {
  if (run?.running) throw badRequest('A website check is already running.');

  const ids = Array.isArray(req.body?.lead_ids)
    ? req.body.lead_ids.map(Number).filter(Number.isInteger)
    : [];
  // With no list: every lead not already known to have a site.
  const leads = (ids.length
    ? ids.map((id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id)).filter(Boolean)
    : db.prepare(
      `SELECT * FROM leads WHERE has_website IS NOT 1 AND opted_out = 0
        ORDER BY created_at DESC LIMIT 500`
    ).all()
  ).filter((l) => l.has_website !== 1);

  if (!leads.length) {
    return res.json({ started: false, reason: 'Nothing to check: those leads are already known to have a website.' });
  }

  run = {
    running: true, total: leads.length, done: 0, with_site: 0, without: 0, possible: 0,
    found: [], search_blocked: false,
    started_at: nowIso(), finished_at: null, error: null,
  };
  const mine = run;

  (async () => {
    for (const lead of leads) {
      if (!mine.running) break;
      try {
        const r = await findWebsite(bizFromLead(lead), {
          search: mine.search_blocked ? false : { gapMs: searchGapMs() },
        });
        if (r.searchBlocked) mine.search_blocked = true;
        if (r.found) {
          markHasWebsite(lead, r);
          mine.with_site += 1;
          mine.found.push({ id: lead.id, name: lead.business_name, url: r.url });
        } else {
          // A site that may be theirs is shown to the rep, not acted on.
          if (r.possible) { notePossibleSite(lead.id, r.possible); mine.possible += 1; }
          markChecked(lead, { complete: r.searched && !r.searchBlocked && !r.possible });
          mine.without += 1;
        }
      } catch (err) {
        // One lead failing says nothing about the next.
        mine.error = err.message;
      }
      mine.done += 1;
    }
    mine.running = false;
    mine.finished_at = nowIso();
  })();

  res.status(202).json({ started: true, total: leads.length });
}));

router.get('/leads/site-check/status', wrap((_req, res) => {
  res.json({ run });
}));

router.post('/leads/site-check/stop', wrap((_req, res) => {
  if (run?.running) run.running = false;
  res.json({ run });
}));

export default router;

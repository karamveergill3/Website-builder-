import { Router } from 'express';
import { db } from '../db.js';
import { wrap, badRequest, int } from '../lib/http.js';
import {
  hunt, huntConfig, activeHunt, recentRuns, targetProgress, foundToday, syncTargets,
} from '../lib/hunter.js';
import { configured as chConfigured } from '../lib/companies-house.js';
import { resolveTrade, allTradeKeywords } from '../lib/sic.js';
import { ledgerStats } from '../lib/recontact.js';
import { REGIONS } from '../lib/towns.js';

const router = Router();

/** What the hunt would do with the current configuration, before it runs. */
function plan(cfg) {
  const resolved = cfg.trades.map((t) => ({ trade: t, ...resolveTrade(t) }));
  const unknown = resolved.filter((r) => !r.codes.length).map((r) => r.trade);
  const areas = cfg.areas.length ? cfg.areas : ['anywhere in the UK'];
  return {
    combinations: resolved.filter((r) => r.codes.length).length * areas.length,
    trades: resolved,
    unrecognised_trades: unknown,
    areas,
  };
}

router.get('/status', wrap((_req, res) => {
  const cfg = huntConfig();
  const targets = targetProgress();
  res.json({
    configured: chConfigured(),
    config: cfg,
    plan: plan(cfg),
    active: activeHunt(),
    found_today: foundToday(),
    runs: recentRuns(10),
    targets,
    coverage: {
      total: targets.length,
      exhausted: targets.filter((t) => t.exhausted_at).length,
      never_run: targets.filter((t) => !t.last_run_at).length,
      found_total: targets.reduce((n, t) => n + t.found_total, 0),
    },
    next_run: nextRunAt(cfg),
    places_configured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
  });
}));

/** When the built-in scheduler will next fire, if it is on. */
export function nextRunAt(cfg = huntConfig()) {
  if (!cfg.enabled) return null;
  const next = new Date();
  next.setHours(cfg.hour, 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** Run now. Returns as soon as it starts; poll /status for progress. */
router.post('/run', wrap((req, res) => {
  if (!chConfigured()) {
    throw badRequest('COMPANIES_HOUSE_API_KEY is not set — the hunt has nowhere to look.');
  }
  if (activeHunt()) throw badRequest('A hunt is already running.');

  const cfg = huntConfig();
  if (!cfg.trades.length) {
    throw badRequest('Set at least one trade before running the hunt.');
  }
  if (cfg.requireNoWebsite && !process.env.GOOGLE_MAPS_API_KEY) {
    throw badRequest(
      'Checking for websites needs GOOGLE_MAPS_API_KEY. Set it, or turn off ' +
      '"only businesses with no website" and take every qualified company.'
    );
  }

  const target = int(req.body?.target) ?? cfg.target;
  hunt({ trigger: 'manual', target }).catch(() => { /* recorded on the run row */ });

  res.status(202).json({ started: true, target });
}));

/** Every trade keyword the picker recognises, for the UI's "add all" preset. */
router.get('/trades', wrap((_req, res) => {
  res.json({ trades: allTradeKeywords() });
}));

/**
 * Town presets, towns and all. The whole payload is a couple of hundred short
 * strings, so sending it once beats a round trip per button press.
 */
router.get('/towns', wrap((_req, res) => {
  res.json({ regions: REGIONS });
}));

router.post('/sync-targets', wrap((_req, res) => {
  const cfg = huntConfig();
  const n = syncTargets(cfg);
  res.json({ combinations: n, targets: targetProgress() });
}));

/** Start a trade/town over from the beginning of the register. */
router.post('/targets/:id/reset', wrap((req, res) => {
  const info = db.prepare(
    'UPDATE hunt_targets SET cursor = 0, exhausted_at = NULL WHERE id = ?'
  ).run(req.params.id);
  if (!info.changes) throw badRequest('No such target.');
  res.json({ targets: targetProgress() });
}));

/**
 * How many companies this tool has ever put in front of the owner, and how
 * many of those have been approached. Answers "why did today's hunt only
 * find six" without the owner having to guess.
 */
router.get('/ledger', wrap((_req, res) => res.json({ ledger: ledgerStats() })));

export default router;

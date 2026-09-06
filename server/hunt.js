#!/usr/bin/env node
/**
 * Run one hunt and exit — for cron, launchd, or running it by hand.
 *
 *   npm run hunt              use the configured daily target
 *   npm run hunt -- 25        override it for this run
 *
 * The server has its own scheduler, so this is only needed when the server
 * is not left running (a laptop that sleeps, say). Both write to the same
 * database and neither will start while the other is mid-hunt.
 */
import 'dotenv/config';
import { hunt, huntConfig } from './lib/hunter.js';
import { configured as chConfigured } from './lib/companies-house.js';

const fail = (message) => {
  console.error(`hunt: ${message}`);
  process.exit(1);
};

if (!chConfigured()) {
  fail('COMPANIES_HOUSE_API_KEY is not set — see docs/COMPANIES-HOUSE.md');
}

const cfg = huntConfig();
if (!cfg.trades.length) {
  fail('no trades configured. Set them under Settings, or in the hunt_trades setting.');
}
if (cfg.requireNoWebsite && !process.env.GOOGLE_MAPS_API_KEY) {
  fail('checking for websites needs GOOGLE_MAPS_API_KEY. Set it, or turn off '
     + 'hunt_require_no_website to take every qualified company.');
}

const override = Number(process.argv[2]);
const target = Number.isFinite(override) && override > 0 ? override : cfg.target;

console.log(`Hunting for ${target} prospect(s) across ${cfg.trades.length} trade(s)`
          + `${cfg.areas.length ? ` and ${cfg.areas.length} town(s)` : ''}…`);

const run = await hunt({ trigger: 'cli', target });

if (run.error) {
  console.error(`\nStopped: ${run.error}`);
}

console.log([
  '',
  `Found            ${run.found} of ${run.target}`,
  `Companies seen   ${run.companies_seen}`,
  `Already had      ${run.already_known}`,
  `Had a website    ${run.had_website}`,
  `Register pages   ${run.register_requests}`,
  `Places requests  ${run.places_requests}`,
  run.areas_covered ? `Covered          ${run.areas_covered}` : null,
].filter((l) => l !== null).join('\n'));

if (run.found < run.target && !run.error) {
  console.log(
    '\nShort of target. Usually means the towns configured are worked through — '
  + 'add more, or raise hunt_max_register_pages.'
  );
}

process.exit(run.error ? 1 : 0);

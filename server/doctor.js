/**
 * Preflight: is this thing actually ready to go out and find work?
 *
 *   npm run doctor            everything free
 *   npm run doctor -- --places   also spends ~3p on one real Places search
 *
 * Every other check in this project is a unit test against a stub, which
 * proves the code is right and proves nothing about whether the keys work.
 * This makes real calls and reports what actually came back, because the
 * only useful answer to "am I ready" is one that has talked to the outside
 * world.
 *
 * It never sends anything to anybody. The Gmail check reads the connection
 * state; it does not put mail in the world.
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WANT_PLACES = process.argv.includes('--places');

/* ------------------------------------------------------------- reporting */

const results = [];
const record = (level, name, detail, next) =>
  results.push({ level, name, detail, next });

const ok   = (name, detail) => record('ok', name, detail);
const warn = (name, detail, next) => record('warn', name, detail, next);
const bad  = (name, detail, next) => record('bad', name, detail, next);

const MARK = { ok: '  ok  ', warn: ' todo ', bad: ' STOP ' };

/* --------------------------------------------------------------- checks */

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) return ok('Node', `v${process.versions.node}`);
  bad('Node', `v${process.versions.node} — too old`,
    'Install Node 20 or newer from nodejs.org. better-sqlite3 will not build on older versions.');
}

function checkInstall() {
  if (existsSync(resolve(ROOT, 'node_modules', 'better-sqlite3'))) {
    return ok('Dependencies', 'installed');
  }
  bad('Dependencies', 'not installed', 'Run: npm install');
}

function checkEnv() {
  if (existsSync(resolve(ROOT, '.env'))) return ok('.env', 'present');
  warn('.env', 'missing',
    'Run: cp .env.example .env — then put your keys in it. The tracker works '
    + 'without one; the hunt does not.');
}

async function checkCompaniesHouse() {
  const key = process.env.COMPANIES_HOUSE_API_KEY?.trim();
  if (!key) {
    return bad('Companies House', 'no API key',
      'Free, and it is the one that unblocks the most. Register at '
      + 'developer.company-information.service.gov.uk, create an application, '
      + 'take the REST API key, and put it in .env as COMPANIES_HOUSE_API_KEY. '
      + 'Without it the hunt finds nothing at all.');
  }

  // A real call. One page of one roofing company — free, and it exercises
  // exactly the query the daily hunt runs.
  try {
    const { advancedSearch } = await import('./lib/companies-house.js');
    const page = await advancedSearch({ sicCodes: '43910', size: 1 });
    if (!page.items.length) {
      return warn('Companies House', 'the key works, but the search came back empty',
        'Unexpected — SIC 43910 (roofing) should never be empty. Worth a second '
        + 'run before trusting it.');
    }
    const first = page.items[0];
    return ok('Companies House',
      `live — ${page.total.toLocaleString()} active roofers on the register, `
      + `e.g. ${first.company_name} (${first.company_number})`);
  } catch (err) {
    // Match on the code, not the wording: the client turns both 401 and 403
    // into KEY_REJECTED, and a regex over the message drifts the moment
    // anyone rephrases it.
    const HINTS = {
      KEY_REJECTED:
        'Copy the REST API key from your application, not the streaming key, '
        + 'and check the application has no IP restriction on it. A key that '
        + 'has never been used still needs the application to be live rather '
        + 'than in test mode.',
      NETWORK:
        'Could not reach the register at all. Check your connection — this is '
        + 'not a problem with the key.',
      NEEDS_FILTER:
        'A bug in the preflight rather than in your setup. Worth reporting.',
    };
    return bad('Companies House', err.message,
      HINTS[err.code] ?? 'Check the key and your connection, then run again.');
  }
}

async function checkPlaces() {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) {
    return warn('Google Places', 'no API key',
      'This is what tells you which businesses have no website — the whole '
      + 'filter. Create a key in a Google Cloud project with the Places API '
      + '(New) enabled and billing on, then set GOOGLE_MAPS_API_KEY. Until '
      + 'then, set hunt_require_no_website to 0 and the hunt will file every '
      + 'company it finds without checking.');
  }
  if (!WANT_PLACES) {
    return warn('Google Places', 'key present, not tested',
      'A live test costs about 3p. Run: npm run doctor -- --places');
  }
  try {
    const { textSearch } = await import('./lib/places.js');
    const { places } = await textSearch('roofers in Wolverhampton', { regionCode: 'GB' });
    const noSite = places.filter((p) => !p.websiteUri).length;
    return ok('Google Places',
      `live — ${places.length} businesses back, ${noSite} with no website`);
  } catch (err) {
    return bad('Google Places', err.message,
      'Usually one of: the Places API (New) is not enabled on the project, '
      + 'billing is not on, or the key is restricted to the wrong referrer. '
      + 'A server-side key needs no referrer restriction.');
  }
}

async function checkGmail() {
  const { clientConfigured, isConnected, connectedEmail, hasReadScope } =
    await import('./lib/gmail.js');
  if (!clientConfigured()) {
    return warn('Gmail', 'no OAuth client',
      'Only needed to send email from inside the tool. WhatsApp, SMS and '
      + 'calling all work without it — and for businesses with no website, '
      + 'those are the channels that actually reach anyone.');
  }
  if (!isConnected()) {
    return warn('Gmail', 'client configured, account not connected',
      'Start the server and connect it under Settings. Use a separate '
      + 'account, never your personal one: Google\'s policies prohibit '
      + 'unsolicited commercial mail with no volume exemption, and the '
      + 'stated sanction includes disabling the account.');
  }
  return ok('Gmail',
    `connected as ${connectedEmail()}${hasReadScope() ? ' (can read replies)' : ' (send only)'}`);
}

async function checkIdentity() {
  const { missingIdentityFields } = await import('./lib/compliance.js');
  const missing = missingIdentityFields();
  if (!missing.length) return ok('Your business details', 'complete');
  bad('Your business details', `missing ${missing.map((f) => f.label).join(', ')}`,
    'No email can lawfully be produced until these are filled in — Companies '
    + 'Act 2006 and PECR both require them. Start the server and fill in '
    + 'Settings, or put them in .env as BIZ_* and they will be seeded on boot.');
}

async function checkHunt() {
  const { huntConfig } = await import('./lib/hunter.js');
  const cfg = huntConfig();
  if (!cfg.trades.length) {
    return warn('Daily hunt', 'no trades configured',
      'Open the Hunt screen and use "Add every trade", or list the trades you '
      + 'want. Nothing runs until it knows what to look for.');
  }
  const areas = cfg.areas.length ? `${cfg.areas.length} town(s)` : 'no towns set';
  const line = `${cfg.trades.length} trade(s), ${areas}, target ${cfg.target}/day`;
  if (!cfg.enabled) {
    return warn('Daily hunt', `${line} — schedule OFF`,
      'Turn the schedule on when you are ready for it to run unattended. '
      + 'Until then, "Run now" and npm run hunt both work.');
  }
  return ok('Daily hunt', `${line}, runs at ${String(cfg.hour).padStart(2, '0')}:00`);
}

async function checkLedger() {
  const { ledgerStats } = await import('./lib/recontact.js');
  const { companies, contacted } = ledgerStats();
  ok('No-repeat ledger',
    `${companies} compan${companies === 1 ? 'y' : 'ies'} remembered, ${contacted} approached`);
}

async function checkOllama() {
  const { available, model } = await import('./lib/ollama.js');
  const state = await available();
  if (state.ok) return ok('Local AI (optional)', `${model()} on ${state.host}`);
  if (state.misconfigured) {
    return bad('Local AI (optional)', state.reason,
      'OLLAMA_HOST must be a loopback address. Nothing about a prospect is '
      + 'allowed to leave this machine.');
  }
  warn('Local AI (optional)', 'not running',
    'Only used to read messy replies. Numbered replies extract fine without '
    + 'it. To add it: curl -fsSL https://ollama.com/install.sh | sh '
    + '&& ollama pull llama3.2');
}

/* ----------------------------------------------------------------- main */

async function main() {
  console.log('\n  Prospect Book — preflight\n');

  checkNode();
  checkInstall();
  checkEnv();
  await checkCompaniesHouse();
  await checkPlaces();
  await checkGmail();
  await checkIdentity();
  await checkHunt();
  await checkLedger();
  await checkOllama();

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`  [${MARK[r.level]}] ${r.name.padEnd(width)}  ${r.detail}`);
  }

  const blockers = results.filter((r) => r.level === 'bad');
  const todos = results.filter((r) => r.level === 'warn');

  if (blockers.length || todos.length) console.log('');
  for (const r of [...blockers, ...todos]) {
    console.log(`  ${r.name}`);
    console.log(`    ${wrap(r.next, 72)}\n`);
  }

  // The single next thing to do, rather than a list to triage.
  console.log('  ' + '─'.repeat(72));
  if (blockers.length) {
    console.log(`\n  Not ready. Start with: ${blockers[0].name}\n`);
    process.exitCode = 1;
  } else if (todos.length) {
    console.log('\n  Ready to hunt. Next: npm run hunt — then open the app and'
      + '\n  work the list. Outstanding items above are optional.\n');
  } else {
    console.log('\n  Everything is live. npm start\n');
  }
}

const wrap = (s, n) => String(s ?? '').replace(
  new RegExp(`(?![^\\n]{1,${n}}$)([^\\n]{1,${n}})\\s`, 'g'), '$1\n    '
);

main().catch((err) => {
  console.error('\n  The preflight itself failed:', err.message, '\n');
  process.exitCode = 1;
});

import 'dotenv/config';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

import { DB_PATH, db } from './db.js';
import leads from './routes/leads.js';
import templates from './routes/templates.js';
import emails from './routes/emails.js';
import settings from './routes/settings.js';
import suppression from './routes/suppression.js';
import outreach from './routes/outreach.js';
import mockups, { MOCKUP_ROOT } from './routes/mockups.js';
import { seedIdentityFromEnv } from './lib/identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');

export const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/api/health', (_req, res) => res.json({ ok: true, db: DB_PATH }));

/**
 * A sweep or a send that was in flight when the process died leaves rows that
 * would otherwise be polled forever. Queued emails are deliberately left
 * pending -- nothing was sent, so nothing is lost.
 */
function recoverInterruptedWork() {
  const info = db.prepare(
    `UPDATE search_runs SET finished_at = ?, error = 'interrupted — the server restarted mid-search'
      WHERE finished_at IS NULL`
  ).run(new Date().toISOString());
  if (info.changes) console.log(`[server] closed ${info.changes} interrupted search run(s)`);
}

app.use('/api/leads', leads);
app.use('/api/templates', templates);
app.use('/api/emails', emails);
app.use('/api/settings', settings);
app.use('/api/suppression', suppression);
// The outreach module registers /api/leads/:id/... paths too, so it must be
// mounted AT /api and after the leads router — Express matches most-specific
// first only within one Router.
app.use('/api', outreach);
app.use('/api', mockups);

/**
 * Generated mockup sites, served read-only from data/mockups/<token>/.
 *
 * The token is the only thing protecting a preview, so it is 128 bits of
 * randomness and the directory listing is off — without the exact token
 * there is nothing to find. `dotfiles: 'deny'` and express.static's own
 * path normalisation keep a crafted URL inside the mockup root.
 *
 * These pages contain text a prospect emailed us. It is escaped at render
 * time (see site-builder.js), and served under a CSP that would neuter any
 * script that did slip through.
 *
 * `default-src 'none'` and the total absence of a script-src are what
 * matter: no script can run here by any route, so the XSS posture does not
 * depend on the escaping being perfect. Google Fonts is allowed for
 * stylesheets and font files only, because typography is most of what makes
 * a mockup read as worth paying for and the system stack cannot carry eight
 * distinct sector themes. It widens nothing that can execute — the cost is
 * that the viewer's IP reaches Google, which is true of most of the web and
 * is a fair trade for a page shown to one prospect. Every theme falls back
 * to a real system face if the load is blocked.
 */
const FONT_CSS = 'https://fonts.googleapis.com';
const FONT_FILES = 'https://fonts.gstatic.com';

app.use('/m', (_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; "
    + `style-src 'unsafe-inline' ${FONT_CSS}; `
    + `font-src 'self' data: ${FONT_FILES}; `
    + "img-src 'self' data:; "
    + "form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // A mockup is a private draft for one prospect; keep it out of indexes.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
}, express.static(MOCKUP_ROOT, {
  index: 'index.html',
  dotfiles: 'deny',
  redirect: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

// Phase 2 and 3 routers are mounted lazily so the tracker keeps working even
// if their integrations are unconfigured or their modules fail to load.
const optional = [
  ['/api/places', './routes/places.js'],
  ['/api/gmail', './routes/gmail.js'],
  ['/api/companies', './routes/companies.js'],
  ['/api/hunt', './routes/hunt.js'],
];
for (const [mount, path] of optional) {
  try {
    const mod = await import(path);
    app.use(mount, mod.default);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
      console.error(`[server] failed to mount ${mount}:`, err.message);
    }
  }
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

// Express identifies error middleware by its four-argument signature.
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.message ?? 'Something went wrong',
    ...(err.details ? { details: err.details } : {}),
  });
});

const PORT = Number(process.env.PORT ?? 3000);
// Loopback only unless deliberately overridden. This process holds a Gmail
// refresh token and has no authentication of its own, so it has no business
// listening on a shared network.
const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * The addresses a phone on the same network can use to reach the app.
 *
 * Every non-internal IPv4 the machine holds, as a full URL. This is only ever
 * printed when the owner has opted into HOST=0.0.0.0, and it saves them
 * reading their LAN IP out of ipconfig by hand.
 */
export function lanUrls(port = PORT) {
  const urls = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      // node <18 gives a string family, >=18 a number; accept both.
      const four = a.family === 'IPv4' || a.family === 4;
      if (four && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

/**
 * The built-in scheduler. Checks every few minutes whether today's hunt is
 * due and has not already run, so the server does not need to be up at
 * exactly the right minute — only at some point during the day. For a machine
 * that sleeps, drive server/hunt.js from cron instead.
 */
async function startScheduler() {
  const { huntConfig, hunt, activeHunt, ranToday } = await import('./lib/hunter.js');

  const tick = async () => {
    try {
      const cfg = huntConfig();
      if (!cfg.enabled || activeHunt() || ranToday()) return;
      if (new Date().getHours() < cfg.hour) return;

      console.log(`[hunt] starting — target ${cfg.target}`);
      const run = await hunt({ trigger: 'schedule' });
      console.log(run.error
        ? `[hunt] stopped: ${run.error}`
        : `[hunt] found ${run.found} of ${run.target} (${run.companies_seen} companies seen)`);
    } catch (err) {
      console.error('[hunt] scheduler error:', err.message);
    }
  };

  setInterval(tick, 5 * 60 * 1000).unref();
  setTimeout(tick, 20_000).unref();
}

if (process.env.NODE_ENV !== 'test') {
  const seeded = seedIdentityFromEnv();
  if (seeded.length) {
    console.log(`[server] seeded ${seeded.length} identity setting(s) from .env: ${seeded.join(', ')}`);
  }
  recoverInterruptedWork();
  startScheduler();
  app.listen(PORT, HOST, () => {
    console.log(`\n  Prospect Book running at http://localhost:${PORT}`);
    console.log(`  Database: ${DB_PATH}`);
    if (HOST !== '127.0.0.1') {
      // Listening beyond loopback, so a phone on the same Wi-Fi can reach it.
      // Print the exact address to type into the phone rather than making the
      // owner dig their machine's IP out of ipconfig.
      for (const url of lanUrls(PORT)) {
        console.log(`  On the same Wi-Fi (e.g. your phone): ${url}`);
      }
      console.log('  Note: this has no password, so anyone on this Wi-Fi can open');
      console.log('  it. Fine on your own home/office network; not on public Wi-Fi.');
    }
    console.log('');
  });
}

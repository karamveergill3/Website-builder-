import 'dotenv/config';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DB_PATH, db } from './db.js';
import leads from './routes/leads.js';
import templates from './routes/templates.js';
import emails from './routes/emails.js';
import settings from './routes/settings.js';
import suppression from './routes/suppression.js';

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
  recoverInterruptedWork();
  startScheduler();
  app.listen(PORT, HOST, () => {
    console.log(`\n  Prospect Book running at http://localhost:${PORT}`);
    console.log(`  Database: ${DB_PATH}`);
    if (HOST !== '127.0.0.1') {
      console.log(`  WARNING: listening on ${HOST} — this app has no login. Do not expose it.`);
    }
    console.log('');
  });
}

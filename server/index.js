import 'dotenv/config';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DB_PATH } from './db.js';
import leads from './routes/leads.js';
import templates from './routes/templates.js';
import emails from './routes/emails.js';
import settings from './routes/settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');

export const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/api/health', (_req, res) => res.json({ ok: true, db: DB_PATH }));

app.use('/api/leads', leads);
app.use('/api/templates', templates);
app.use('/api/emails', emails);
app.use('/api/settings', settings);

// Phase 2 and 3 routers are mounted lazily so the tracker keeps working even
// if their integrations are unconfigured or their modules fail to load.
const optional = [
  ['/api/places', './routes/places.js'],
  ['/api/gmail', './routes/gmail.js'],
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

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.message ?? 'Something went wrong',
    ...(err.details ? { details: err.details } : {}),
  });
});

const PORT = Number(process.env.PORT ?? 3000);

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`\n  Prospect Book running at http://localhost:${PORT}`);
    console.log(`  Database: ${DB_PATH}\n`);
  });
}

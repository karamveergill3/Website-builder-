/**
 * Nightly database backup.
 *
 *   npm run backup
 *
 * Everything the business is made of lives in one SQLite file — leads,
 * invoices, and the messaging-consent records that are the legal cover for
 * contacting sole traders. One reclaimed VM or one bad disk and it is all
 * gone, so this takes a consistent copy (SQLite's own online backup, safe to
 * run while the server is live) into data/backups/ and keeps the most recent
 * few. A systemd timer runs it nightly; scripts/install-backup.sh sets that up.
 *
 * Uses only better-sqlite3, already a dependency — no new package, nothing
 * leaves the machine.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function dbPath() {
  return process.env.DB_PATH
    ? resolve(ROOT, process.env.DB_PATH)
    : resolve(ROOT, 'data', 'prospect-book.db');
}

/** A filesystem-safe stamp, minute resolution: 2026-09-14-0300. */
function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * Copy the database to <db dir>/backups, then keep only the newest `keep`.
 * Returns { dest, kept }.
 */
export async function runBackup({ source = dbPath(), keep = 14, now = new Date() } = {}) {
  if (!existsSync(source)) {
    throw new Error(`No database at ${source} — nothing to back up.`);
  }
  const destDir = join(dirname(source), 'backups');
  mkdirSync(destDir, { recursive: true });

  const dest = join(destDir, `prospect-book-${stamp(now)}.db`);
  const db = new Database(source);
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }

  // Prune to the newest `keep`, by modified time.
  const all = readdirSync(destDir)
    .filter((f) => /^prospect-book-.*\.db$/.test(f))
    .map((f) => ({ f, t: statSync(join(destDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of all.slice(keep)) unlinkSync(join(destDir, f));

  return { dest, kept: Math.min(all.length, keep) };
}

// Run when invoked directly (npm run backup), not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBackup({ keep: Number(process.env.BACKUP_KEEP) || 14 })
    .then(({ dest, kept }) => { console.log(`Backed up to ${dest} — ${kept} kept.`); })
    .catch((err) => { console.error(err.message); process.exit(1); });
}

/**
 * The nightly backup: it must make a real, openable copy of the database and
 * never let the backups folder grow without bound.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runBackup } = await import('../scripts/backup.js');

const dir = mkdtempSync(join(tmpdir(), 'pb-backup-'));
const source = join(dir, 'prospect-book.db');

// A tiny database with one known row to prove the copy carries the data.
const seed = new Database(source);
seed.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT)');
seed.prepare('INSERT INTO leads (business_name) VALUES (?)').run('Hillside Roofing Ltd');
seed.close();

test('a backup is a working copy of the database, with the data in it', async () => {
  const { dest } = await runBackup({ source });
  assert.ok(existsSync(dest), 'the backup file exists');

  const copy = new Database(dest, { readonly: true });
  const row = copy.prepare('SELECT business_name FROM leads').get();
  copy.close();
  assert.equal(row.business_name, 'Hillside Roofing Ltd', 'the data came across');
});

test('only the newest `keep` backups are retained', async () => {
  // Ten runs, keeping three. Distinct timestamps so the names (and prune
  // order) are stable minute-to-minute regardless of the clock.
  const base = new Date('2026-09-14T03:00:00');
  for (let i = 0; i < 10; i += 1) {
    await runBackup({ source, keep: 3, now: new Date(base.getTime() + i * 60_000) });
  }
  const files = readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.db'));
  assert.equal(files.length, 3, 'old backups are pruned to the limit');
});

test('backing up a database that is not there fails loudly, not silently', async () => {
  await assert.rejects(
    () => runBackup({ source: join(dir, 'does-not-exist.db') }),
    /nothing to back up/i,
  );
});

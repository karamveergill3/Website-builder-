/**
 * The shared "Websites" library.
 *
 * When a job is finished and handed over, the finished site's ZIP is uploaded
 * here with its handover details (domain, host, a note). It lands in one place
 * the whole team can see — because everyone signs into the same hub — so if a
 * client comes back months later, whoever is free can pull the site back down.
 *
 * The ZIP lives on disk next to the database (so it travels with it and, in a
 * test, with the throwaway db); only the metadata is in SQLite. No passwords
 * are stored: client logins belong in the handover letter to the client, not
 * in a shared team table.
 *
 * Upload is a raw ZIP body (no multipart parser, so no extra dependency) with
 * the details in the query string.
 */
import { Router } from 'express';
import express from 'express';
import { resolve, dirname } from 'node:path';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { db, DB_PATH } from '../db.js';
import { wrap, badRequest, notFound, nowIso, str, int } from '../lib/http.js';

export const WEBSITES_ROOT = resolve(dirname(DB_PATH), 'websites');
const MAX_BYTES = 60 * 1024 * 1024; // 60 MB per site — plenty for a static site

const router = Router();

/** The whole shared library, newest first, with who filed it and disk used. */
router.get('/', wrap((_req, res) => {
  const sites = db.prepare(
    `SELECT a.id, a.business_name, a.domain, a.host, a.notes, a.file_name,
            a.file_size, a.archived_at, a.archived_by,
            u.name AS archived_by_name, c.name AS client_name
       FROM archived_sites a
       LEFT JOIN users u ON u.id = a.archived_by
       LEFT JOIN clients c ON c.id = a.client_id
      ORDER BY a.archived_at DESC`
  ).all();
  const diskUsed = sites.reduce((n, s) => n + (s.file_size || 0), 0);
  res.json({ sites, disk_used: diskUsed });
}));

/**
 * Archive a finished site. The request body IS the ZIP (Content-Type
 * application/zip); the details come in the query string.
 */
router.post(
  '/',
  express.raw({ type: ['application/zip', 'application/octet-stream'], limit: MAX_BYTES }),
  wrap((req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw badRequest('No file received — attach the finished site as a ZIP.');
    }
    // Every ZIP starts "PK". Cheap guard against someone uploading the wrong thing.
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
      throw badRequest('That does not look like a ZIP file.');
    }

    const business_name = str(req.query.business_name);
    if (!business_name) throw badRequest('A business name is required.');

    mkdirSync(WEBSITES_ROOT, { recursive: true });
    const stored = `${randomBytes(12).toString('hex')}.zip`;
    writeFileSync(resolve(WEBSITES_ROOT, stored), buf);

    const info = db.prepare(
      `INSERT INTO archived_sites
         (client_id, business_name, domain, host, notes,
          file_name, file_path, file_size, archived_by, archived_at)
       VALUES (@client_id, @business_name, @domain, @host, @notes,
               @file_name, @file_path, @file_size, @archived_by, @now)`
    ).run({
      client_id: int(req.query.client_id) ?? null,
      business_name,
      domain: str(req.query.domain),
      host: str(req.query.host),
      notes: str(req.query.notes),
      // Sanitise the shown filename; the stored name is our own random one.
      file_name: (str(req.query.file_name) ?? 'site.zip').replace(/[^\w.\-]+/g, '_').slice(0, 120),
      file_path: stored,
      file_size: buf.length,
      archived_by: req.user?.id ?? null,
      now: nowIso(),
    });

    res.status(201).json({
      site: db.prepare('SELECT * FROM archived_sites WHERE id = ?').get(info.lastInsertRowid),
    });
  })
);

/** Download one site's ZIP. Any signed-in team member. */
router.get('/:id/download', wrap((req, res) => {
  const site = db.prepare('SELECT * FROM archived_sites WHERE id = ?').get(int(req.params.id));
  if (!site) throw notFound('That site is not in the archive.');
  const path = resolve(WEBSITES_ROOT, site.file_path);
  if (!existsSync(path)) throw notFound('The file is missing from the archive.');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${site.file_name || 'site.zip'}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(readFileSync(path));
}));

/** Remove a site from the archive, file and all. */
router.delete('/:id', wrap((req, res) => {
  const site = db.prepare('SELECT * FROM archived_sites WHERE id = ?').get(int(req.params.id));
  if (!site) throw notFound('That site is not in the archive.');
  try {
    const path = resolve(WEBSITES_ROOT, site.file_path);
    if (existsSync(path)) unlinkSync(path);
  } catch { /* the row goes regardless */ }
  db.prepare('DELETE FROM archived_sites WHERE id = ?').run(site.id);
  res.status(204).end();
}));

export default router;

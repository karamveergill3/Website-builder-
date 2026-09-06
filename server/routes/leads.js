import { Router } from 'express';
import { db } from '../db.js';
import {
  wrap, badRequest, notFound, conflict, nowIso, str, requiredStr, bool, int, looksLikeEmail,
} from '../lib/http.js';

export const STATUSES = ['new', 'sent', 'replied', 'won', 'lost'];

const router = Router();

const SORTS = {
  created:  'created_at DESC, id DESC',
  oldest:   'created_at ASC, id ASC',
  name:     'business_name COLLATE NOCASE ASC',
  contacted:'last_contacted_at DESC NULLS LAST, id DESC',
};

/** Shape a DB row for the client: SQLite has no booleans. */
const toApi = (row) => (row ? { ...row, opted_out: row.opted_out === 1 } : row);

function parseLeadBody(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('business_name')) {
    out.business_name = requiredStr(body.business_name, 'business_name');
  }
  for (const f of ['category', 'location', 'phone', 'notes', 'source', 'google_place_id']) {
    if (!partial || has(f)) out[f] = str(body[f]);
  }
  if (!partial || has('email')) {
    const email = str(body.email);
    if (email !== null && !looksLikeEmail(email)) {
      throw badRequest(`"${email}" does not look like an email address`);
    }
    out.email = email;
  }
  if (!partial || has('status')) {
    const status = str(body.status) ?? 'new';
    if (!STATUSES.includes(status)) {
      throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
    }
    out.status = status;
  }
  if (!partial || has('opted_out')) out.opted_out = bool(body.opted_out) ? 1 : 0;
  if (has('last_contacted_at')) out.last_contacted_at = str(body.last_contacted_at);

  return out;
}

/** GET /api/leads — filter by status, free-text search, sort. */
router.get('/', wrap((req, res) => {
  const where = [];
  const params = {};

  const status = str(req.query.status);
  if (status && status !== 'all') {
    if (!STATUSES.includes(status)) throw badRequest(`unknown status "${status}"`);
    where.push('status = @status');
    params.status = status;
  }

  const q = str(req.query.q);
  if (q) {
    where.push(`(business_name LIKE @q OR category LIKE @q OR location LIKE @q
                 OR email LIKE @q OR phone LIKE @q OR notes LIKE @q)`);
    params.q = `%${q}%`;
  }

  if (str(req.query.opted_out) !== null) {
    where.push('opted_out = @opted');
    params.opted = bool(req.query.opted_out) ? 1 : 0;
  }
  if (bool(req.query.has_email)) where.push("email IS NOT NULL AND email <> ''");

  const sql = `SELECT * FROM leads
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${SORTS[req.query.sort] ?? SORTS.created}
    LIMIT @limit OFFSET @offset`;

  params.limit = Math.min(int(req.query.limit, 500), 2000);
  params.offset = Math.max(int(req.query.offset, 0), 0);

  res.json({ leads: db.prepare(sql).all(params).map(toApi) });
}));

/**
 * GET /api/leads/stats — the numbers behind the stat tiles.
 * "Awaiting reply" is deliberately the count of leads sat at `sent`: contacted
 * but not yet heard back from.
 */
router.get('/stats', wrap((_req, res) => {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status').all()) {
    byStatus[row.status] = row.n;
  }
  const one = (sql) => db.prepare(sql).get().n;

  res.json({
    total:          one('SELECT COUNT(*) n FROM leads'),
    awaiting_reply: byStatus.sent,
    replied:        byStatus.replied,
    won:            byStatus.won,
    lost:           byStatus.lost,
    new:            byStatus.new,
    by_status:      byStatus,
    opted_out:      one('SELECT COUNT(*) n FROM leads WHERE opted_out = 1'),
    emailable:      one(`SELECT COUNT(*) n FROM leads
                         WHERE opted_out = 0 AND email IS NOT NULL AND email <> ''`),
    no_email:       one("SELECT COUNT(*) n FROM leads WHERE email IS NULL OR email = ''"),
  });
}));

router.get('/:id', wrap((req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) throw notFound('Lead not found');
  const history = db
    .prepare('SELECT * FROM email_log WHERE lead_id = ? ORDER BY sent_at DESC')
    .all(lead.id);
  res.json({ lead: toApi(lead), history });
}));

router.post('/', wrap((req, res) => {
  const lead = parseLeadBody(req.body);
  lead.created_at = nowIso();
  lead.last_contacted_at = lead.last_contacted_at ?? null;

  const cols = Object.keys(lead);
  try {
    const info = db
      .prepare(`INSERT INTO leads (${cols.join(', ')})
                VALUES (${cols.map((c) => `@${c}`).join(', ')})`)
      .run(lead);
    res.status(201).json({
      lead: toApi(db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid)),
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE') && lead.google_place_id) {
      throw conflict('A lead with that Google place ID already exists');
    }
    throw err;
  }
}));

router.patch('/:id', wrap((req, res) => {
  const existing = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('Lead not found');

  const patch = parseLeadBody(req.body, { partial: true });
  if (Object.keys(patch).length === 0) return res.json({ lead: toApi(existing) });

  // Moving a lead to "sent" by hand should stamp the contact date, unless the
  // caller set one explicitly.
  if (patch.status === 'sent' && existing.status !== 'sent' && !('last_contacted_at' in patch)) {
    patch.last_contacted_at = nowIso();
  }

  db.prepare(`UPDATE leads SET ${Object.keys(patch).map((c) => `${c} = @${c}`).join(', ')}
              WHERE id = @id`).run({ ...patch, id: existing.id });

  res.json({ lead: toApi(db.prepare('SELECT * FROM leads WHERE id = ?').get(existing.id)) });
}));

router.delete('/:id', wrap((req, res) => {
  const info = db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  if (info.changes === 0) throw notFound('Lead not found');
  res.status(204).end();
}));

/** POST /api/leads/bulk-status — for multi-select actions in the list. */
router.post('/bulk-status', wrap((req, res) => {
  const status = requiredStr(req.body.status, 'status');
  if (!STATUSES.includes(status)) throw badRequest(`unknown status "${status}"`);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) throw badRequest('ids must be a non-empty array');

  const stmt = db.prepare('UPDATE leads SET status = ? WHERE id = ?');
  const run = db.transaction((rows) => rows.forEach((id) => stmt.run(status, id)));
  run(ids);
  res.json({ updated: ids.length, status });
}));

export default router;

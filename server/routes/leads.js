import { Router } from 'express';
import { db } from '../db.js';
import {
  wrap, badRequest, notFound, conflict, nowIso, str, requiredStr, bool, int, looksLikeEmail,
} from '../lib/http.js';
import { ENTITY_TYPES, sendability, looksCorporate } from '../lib/pecr.js';
import { isSuppressed, suppress } from '../lib/suppression.js';

export const STATUSES = ['new', 'sent', 'replied', 'won', 'lost'];

const router = Router();

/** Looked up with Object.hasOwn, so a key like "constructor" cannot reach the SQL. */
const SORTS = {
  created:  'created_at DESC, id DESC',
  oldest:   'created_at ASC, id ASC',
  name:     'business_name COLLATE NOCASE ASC',
  contacted:'last_contacted_at DESC NULLS LAST, id DESC',
};

/**
 * Shape a DB row for the client: SQLite has no booleans, and every lead
 * carries the verdict on whether it may lawfully be emailed.
 */
function toApi(row) {
  if (!row) return row;
  const suppressed = isSuppressed(row.email);
  const verdict = sendability(row, { suppressed });
  return {
    ...row,
    opted_out: row.opted_out === 1,
    suppressed,
    can_email: verdict.allowed,
    block_code: verdict.allowed ? null : verdict.code,
    block_reason: verdict.reason,
    looks_corporate: looksCorporate(row.business_name),
  };
}

function parseLeadBody(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('business_name')) {
    out.business_name = requiredStr(body.business_name, 'business_name');
  }
  for (const f of ['category', 'location', 'phone', 'notes', 'source',
                   'google_place_id', 'company_number', 'entity_note']) {
    if (!partial || has(f)) out[f] = str(body[f]);
  }
  if (!partial || has('entity_type')) {
    const et = str(body.entity_type) ?? 'unknown';
    if (!ENTITY_TYPES.includes(et)) {
      throw badRequest(`entity_type must be one of: ${ENTITY_TYPES.join(', ')}`);
    }
    out.entity_type = et;
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

/**
 * A trading name ending in "Ltd" is not evidence of incorporation. Google shows
 * TRADING names, which routinely differ from registered names, and the PECR
 * "subscriber" is whoever contracts for the communications service -- not
 * whoever the map listing names. So classifying a lead as a corporate
 * subscriber requires a company number on the record: "the listing said Ltd"
 * is not an answer to "how did you know they were a corporate subscriber?".
 */
function requireCorporateEvidence(next) {
  if (next.entity_type !== 'corporate') return;
  const number = (next.company_number ?? '').replace(/\s+/g, '');
  if (!number) {
    throw badRequest(
      'To mark a lead as a limited company you must record its company number. ' +
      'Look the business up on the Companies House register — a trading name ' +
      'ending in "Ltd" is not evidence of incorporation.'
    );
  }
  if (!/^[A-Z0-9]{6,10}$/i.test(number)) {
    throw badRequest(
      `"${next.company_number}" does not look like a company number. UK company ` +
      'numbers are 8 characters, for example 01234567 or SC123456.'
    );
  }
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
    ORDER BY ${Object.hasOwn(SORTS, req.query.sort ?? '') ? SORTS[req.query.sort] : SORTS.created}
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
    no_email:       one("SELECT COUNT(*) n FROM leads WHERE email IS NULL OR email = ''"),
    // "Emailable" means lawfully emailable, not merely "has an address".
    emailable:      db.prepare('SELECT * FROM leads').all()
                      .filter((l) => sendability(l, { suppressed: isSuppressed(l.email) }).allowed).length,
    unclassified:   one(`SELECT COUNT(*) n FROM leads
                         WHERE entity_type = 'unknown' AND opted_out = 0
                           AND email IS NOT NULL AND email <> ''`),
    corporate:      one("SELECT COUNT(*) n FROM leads WHERE entity_type = 'corporate'"),
    individual:     one("SELECT COUNT(*) n FROM leads WHERE entity_type = 'individual'"),
    suppressed:     one('SELECT COUNT(*) n FROM suppression_list'),
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
  requireCorporateEvidence(lead);
  lead.created_at = nowIso();
  lead.last_contacted_at = lead.last_contacted_at ?? null;

  const cols = Object.keys(lead);
  try {
    const info = db
      .prepare(`INSERT INTO leads (${cols.join(', ')})
                VALUES (${cols.map((c) => `@${c}`).join(', ')})`)
      .run(lead);
    // A lead created already opted out must go on the suppression list too --
    // otherwise the opt-out is lost the moment the lead is deleted.
    if (lead.opted_out === 1) {
      suppress(lead.email, { businessName: lead.business_name, reason: 'created as opted out' });
    }
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
  requireCorporateEvidence({ ...existing, ...patch });

  // Moving a lead to "sent" by hand should stamp the contact date, unless the
  // caller set one explicitly.
  if (patch.status === 'sent' && existing.status !== 'sent' && !('last_contacted_at' in patch)) {
    patch.last_contacted_at = nowIso();
  }

  db.prepare(`UPDATE leads SET ${Object.keys(patch).map((c) => `${c} = @${c}`).join(', ')}
              WHERE id = @id`).run({ ...patch, id: existing.id });

  // An opt-out is recorded against the address, not just the row, so deleting
  // or re-importing the lead cannot resurrect it as a target.
  if (patch.opted_out === 1) {
    suppress(patch.email ?? existing.email, {
      businessName: patch.business_name ?? existing.business_name,
      reason: 'marked opted out',
    });
  }

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

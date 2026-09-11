import { Router } from 'express';
import { db } from '../db.js';
import {
  wrap, badRequest, notFound, conflict, nowIso, str, requiredStr, bool, int, looksLikeEmail,
} from '../lib/http.js';
import { ENTITY_TYPES, sendability, looksCorporate } from '../lib/pecr.js';
import { isSuppressed, suppress } from '../lib/suppression.js';
import { recordContact, recordFound, recontactCheck, ledgerFor } from '../lib/recontact.js';
import { sectorFor, sectorLabel } from '../lib/sectors.js';

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
  // Whether this COMPANY has been approached before, on any channel and under
  // any lead row. Two separate questions the UI kept conflating: may we
  // lawfully contact this business (can_email), and have we already
  // (can_contact). A screen that only answers the first invites the repeat.
  const again = recontactCheck(row);
  return {
    ...row,
    opted_out: row.opted_out === 1,
    suppressed,
    can_email: verdict.allowed,
    block_code: verdict.allowed ? null : verdict.code,
    block_reason: verdict.reason,
    looks_corporate: looksCorporate(row.business_name),
    // Which broad sector this trade falls in, so the right opening message
    // picks itself on the Reach screen. Server-side, so the keyword list has
    // one home.
    sector: sectorFor(row.category),
    sector_label: sectorLabel(sectorFor(row.category)),
    can_contact: again.allowed,
    contacted_before: !again.allowed || again.code === 'IN_CONVERSATION',
    contacted_at: again.previous ?? row.last_contacted_at ?? null,
    contacted_via: again.channel ?? null,
    contact_block_reason: again.allowed ? null : again.reason,
  };
}

function parseLeadBody(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('business_name')) {
    out.business_name = requiredStr(body.business_name, 'business_name');
  }
  for (const f of ['category', 'location', 'phone', 'notes', 'source',
                   'google_place_id', 'entity_note']) {
    if (!partial || has(f)) out[f] = str(body[f]);
  }
  // Upper-cased on the way in. It is the dedupe key for a whole company, and
  // it was being compared with a case-sensitive '=', so 'sc123456' and
  // 'SC123456' were two different businesses to every check that mattered.
  if (!partial || has('company_number')) {
    const n = str(body.company_number);
    out.company_number = n ? n.toUpperCase() : n;
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
  // Reassigning a lead: an id of an existing user, or null to unassign.
  if (has('assigned_to')) out.assigned_to = normAssignee(body.assigned_to);

  return out;
}

/** A lead owner is a real user id, or null (unassigned). */
function normAssignee(v) {
  if (v === null || v === undefined || v === '') return null;
  const id = Number(v);
  if (!Number.isInteger(id)) throw badRequest('assigned_to must be a team member id.');
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) {
    throw badRequest('No such team member.');
  }
  return id;
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

  // Owner filter: "me" (this rep's own leads), "none" (unassigned), or a
  // specific team member's id.
  const who = str(req.query.assigned_to);
  if (who === 'none') {
    where.push('assigned_to IS NULL');
  } else if (who === 'me') {
    where.push('assigned_to = @me');
    params.me = req.user?.id ?? -1;
  } else if (who) {
    where.push('assigned_to = @assignee');
    params.assignee = Number(who) || -1;
  }

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
    // Everything whose legal form is not yet confirmed — this is what
    // "Check register" actually looks up, so the count must match it. It used
    // to also require an email (a leftover from when leads arrived with one),
    // which read 0 for the phone-only leads the hunt files now and made the
    // "Check register" dialog claim there was nothing to check.
    unclassified:   one(`SELECT COUNT(*) n FROM leads
                         WHERE entity_type = 'unknown' AND opted_out = 0`),
    corporate:      one("SELECT COUNT(*) n FROM leads WHERE entity_type = 'corporate'"),
    individual:     one("SELECT COUNT(*) n FROM leads WHERE entity_type = 'individual'"),
    suppressed:     one('SELECT COUNT(*) n FROM suppression_list'),
    // How many leads each rep has been given today, keyed by user id (plus
    // "none" for unassigned). The Leads screen turns this into "You 5 · …".
    by_assignee_today: Object.fromEntries(
      db.prepare(
        `SELECT COALESCE(assigned_to, 'none') AS id, COUNT(*) AS n FROM leads
          WHERE substr(created_at, 1, 10) = ? GROUP BY assigned_to`
      ).all(nowIso().slice(0, 10)).map((r) => [String(r.id), r.n])
    ),
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

/**
 * POST /api/leads/:id/consent — record that a business agreed to be messaged.
 *
 * The lawful route to a sole trader: you call them (regulation 21), and if
 * they say yes to a WhatsApp/text/email, that agreement is consent under
 * regulation 22 and unblocks those channels for this lead. Stamped with who
 * recorded it and when, so it can be shown and proven. Pass consent:false to
 * withdraw it (they changed their mind).
 */
router.post('/:id/consent', wrap((req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) throw notFound('Lead not found');

  const granting = req.body?.consent !== false;
  db.prepare(
    `UPDATE leads SET messaging_consent_at = @at, messaging_consent_by = @by,
       messaging_consent_note = @note WHERE id = @id`
  ).run({
    id: lead.id,
    at: granting ? nowIso() : null,
    by: granting ? (req.user?.id ?? null) : null,
    note: granting ? (str(req.body?.note) ?? 'Agreed on a call to be messaged') : null,
  });
  res.json({ lead: toApi(db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)) });
}));

router.post('/', wrap((req, res) => {
  const lead = parseLeadBody(req.body);
  requireCorporateEvidence(lead);
  lead.created_at = nowIso();
  lead.last_contacted_at = lead.last_contacted_at ?? null;
  // A lead added by hand belongs to whoever added it, unless one was named.
  if (!('assigned_to' in lead)) lead.assigned_to = req.user?.id ?? null;

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
    const created = db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid);
    recordFound(created);
    if (created.last_contacted_at) recordContact(created, 'existing', created.last_contacted_at);
    res.status(201).json({ lead: toApi(created) });
  } catch (err) {
    const msg = String(err.message);
    // SQLite names the column, not the index, so match on the column.
    if (msg.includes('UNIQUE') && msg.includes('leads.company_number')) {
      // The partial unique index from migration 016. Two rows for one company
      // are two independent targets, contacted independently, with nothing in
      // the UI connecting them — the split identity the ledger exists to stop.
      const held = db.prepare(
        'SELECT id, business_name FROM leads WHERE company_number = ?'
      ).get(lead.company_number);
      throw conflict(
        `Company ${lead.company_number} is already lead #${held?.id} `
        + `(${held?.business_name}).`
      );
    }
    if (msg.includes('UNIQUE') && lead.google_place_id) {
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
  // Whatever route stamped the contact date, the ledger has to hear about
  // it — it is the only record that survives this lead being deleted.
  const contactedNow = patch.last_contacted_at
    && patch.last_contacted_at !== existing.last_contacted_at;

  db.prepare(`UPDATE leads SET ${Object.keys(patch).map((c) => `${c} = @${c}`).join(', ')}
              WHERE id = @id`).run({ ...patch, id: existing.id });

  if (contactedNow) {
    recordContact({ ...existing, ...patch }, 'marked by hand', patch.last_contacted_at);
  }

  // An opt-out is recorded against the address, not just the row, so deleting
  // or re-importing the lead cannot resurrect it as a target.
  if (patch.opted_out === 1) {
    suppress(patch.email ?? existing.email, {
      businessName: patch.business_name ?? existing.business_name,
      reason: 'marked opted out',
    });
    // suppression_list is keyed on an email address, so a phone-only lead —
    // which most no-website trades are — could not be suppressed at all, and
    // its opt-out died with the row. The ledger is keyed on the company, so
    // it can carry one for a business that has never given us an address.
    recordContact({ ...existing, ...patch }, 'opted out');
  }

  res.json({ lead: toApi(db.prepare('SELECT * FROM leads WHERE id = ?').get(existing.id)) });
}));

/**
 * The bookkeeping a lead needs before its row goes.
 *
 * An opt-out is recorded against the address, and the PATCH that sets the
 * flag does that — but only with an address to record. Most no-website trades
 * are phone-only when they opt out, so the flag gets set with nothing to
 * suppress, and if an email turns up afterwards the opt-out has no way to
 * follow it. Checking again on the way out is the last chance to catch that.
 *
 * Returns whether an address was suppressed, so a bulk caller can report it.
 */
function retire(lead) {
  if (!lead || lead.opted_out !== 1 || !lead.email) return false;
  return suppress(lead.email, {
    businessName: lead.business_name,
    reason: 'opted out, then the lead was deleted',
  });
}

router.delete('/:id', wrap((req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) throw notFound('Lead not found');
  retire(lead);
  db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);
  res.status(204).end();
}));

/**
 * POST /api/leads/bulk-delete — clear the list, or the part of it on screen.
 *
 * Two things deliberately outlive the rows:
 *
 *   suppression_list — an opted-out lead is suppressed on the way out, the
 *     same as the single-lead path does, or the opt-out dies with the row and
 *     the next import makes them contactable again.
 *
 *   company_ledger  — the record of who has already been approached. Wiping
 *     the leads is how you say "this list is no good"; it is not a licence to
 *     cold-message the same roofer a second time, which is what earns the
 *     complaint that costs the mailbox.
 *
 * `forget` is the escape hatch, and it is deliberately narrow: it drops the
 * ledger rows for companies that have never been contacted, so the hunt can
 * find them again. A company with a contact date keeps its row whatever is
 * asked, because the whole point of that date is that it cannot be argued
 * away by deleting something.
 */
router.post('/bulk-delete', wrap((req, res) => {
  const all = bool(req.body?.all);
  const forget = bool(req.body?.forget);
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isFinite)
    : [];
  if (!all && ids.length === 0) {
    throw badRequest('Pass ids, or all: true to clear the whole list.');
  }

  // One row at a time rather than an IN list: SQLite caps a statement at 999
  // parameters, and "delete all" on a list of a thousand-odd is exactly the
  // case this exists for.
  const one = db.prepare('SELECT * FROM leads WHERE id = ?');
  const drop = db.prepare('DELETE FROM leads WHERE id = ?');
  const unfile = db.prepare(
    'DELETE FROM company_ledger WHERE company_key = ? AND contacted_at IS NULL'
  );

  const out = { deleted: 0, suppressed: 0, forgotten: 0, reopened: 0, kept: 0 };
  const forgottenTowns = new Set();

  const run = db.transaction((rows) => {
    for (const id of rows) {
      const lead = one.get(id);
      if (!lead) continue;

      if (retire(lead)) out.suppressed += 1;

      // Read the ledger row before the lead goes: ledgerFor() needs the
      // lead's name and town to reach a row filed under the weaker key.
      const filed = forget ? ledgerFor(lead) : null;
      drop.run(id);
      out.deleted += 1;

      if (!filed) continue;
      if (filed.contacted_at) { out.kept += 1; continue; }
      const removed = unfile.run(filed.company_key).changes;
      out.forgotten += removed;
      if (removed && lead.location) forgottenTowns.add(lead.location);
    }
  });

  run(all ? db.prepare('SELECT id FROM leads').all().map((r) => r.id) : ids);

  // Clearing the ledger is not enough on its own. The hunt reads the register
  // one page at a time and remembers how far it got (the target's cursor), and
  // it retires a town it has worked through (exhausted_at). So a forgotten
  // business still never reappears — the run starts past the page it sits on.
  // Re-open the towns we just forgot: rewind their cursor and un-retire them,
  // so the next hunt reads them again from the top and re-finds the business.
  if (forget && out.forgotten > 0) {
    const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const wanted = new Set([...forgottenTowns].map(norm));
    const reopen = db.prepare(
      'UPDATE hunt_targets SET cursor = 0, exhausted_at = NULL WHERE id = ?'
    );
    const targets = db.prepare('SELECT id, area FROM hunt_targets').all();
    const reopenAll = db.transaction(() => {
      for (const t of targets) {
        // Match the town, or — if the forgotten leads carried no town to match
        // on — re-open everything, so the escape hatch always actually works.
        if (!wanted.size || wanted.has(norm(t.area))) out.reopened += reopen.run(t.id).changes;
      }
    });
    reopenAll();
  }

  res.json(out);
}));

/** POST /api/leads/bulk-status — for multi-select actions in the list. */
router.post('/bulk-status', wrap((req, res) => {
  const status = requiredStr(req.body.status, 'status');
  if (!STATUSES.includes(status)) throw badRequest(`unknown status "${status}"`);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) throw badRequest('ids must be a non-empty array');

  // Marking a batch as "sent" by hand is a claim that they were contacted, so
  // it stamps the date exactly as the single-lead PATCH does. It did not, so
  // the list showed a contacted lead with no contact date on it.
  const now = nowIso();
  const stmt = db.prepare('UPDATE leads SET status = ? WHERE id = ?');
  const stamp = db.prepare(
    'UPDATE leads SET status = ?, last_contacted_at = ? WHERE id = ? AND status != ?'
  );
  const run = db.transaction((rows) => {
    for (const id of rows) {
      if (status !== 'sent') { stmt.run(status, id); continue; }
      const before = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
      if (!before) continue;
      stamp.run(status, before.last_contacted_at ?? now, id, 'sent');
      if (!before.last_contacted_at) recordContact(before, 'marked by hand', now);
    }
  });
  run(ids);
  res.json({ updated: ids.length, status });
}));

/** POST /api/leads/bulk-assign — hand a batch of leads to a team member. */
router.post('/bulk-assign', wrap((req, res) => {
  const assignee = normAssignee(req.body?.assigned_to); // id, or null to unassign
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) throw badRequest('ids must be a non-empty array');

  const stmt = db.prepare('UPDATE leads SET assigned_to = ? WHERE id = ?');
  const run = db.transaction((rows) => { for (const id of rows) stmt.run(assignee, id); });
  run(ids);
  res.json({ updated: ids.length, assigned_to: assignee });
}));

/**
 * POST /api/leads/import-emails — paste addresses in against business names.
 *
 * Neither Google nor Companies House holds an email address, so this is the
 * step that is always manual. Making it bulk at least keeps it quick.
 * Accepts "Business name, email" per line, in either order, comma or tab
 * separated.
 */
router.post('/import-emails', wrap((req, res) => {
  const text = String(req.body.text ?? '');
  if (!text.trim()) throw badRequest('Nothing pasted.');

  const leads = db.prepare('SELECT id, business_name, email FROM leads').all();
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map(leads.map((l) => [norm(l.business_name), l]));

  const matched = [];
  const unmatched = [];
  const invalid = [];

  const apply = db.transaction((rows) => {
    for (const row of rows) {
      db.prepare('UPDATE leads SET email = ? WHERE id = ?').run(row.email, row.id);
    }
  });

  const staged = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(/[\t,;]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) { unmatched.push({ line, reason: 'needs a name and an address' }); continue; }

    const email = parts.find((p) => looksLikeEmail(p));
    const name = parts.filter((p) => p !== email).join(' ').trim();
    if (!email) { invalid.push({ line, reason: 'no valid email address on that line' }); continue; }
    if (!name) { unmatched.push({ line, reason: 'no business name' }); continue; }

    // Exact normalised match first, then a unique prefix match.
    let lead = byName.get(norm(name));
    if (!lead) {
      const hits = leads.filter((l) => norm(l.business_name).startsWith(norm(name))
                                    || norm(name).startsWith(norm(l.business_name)));
      if (hits.length === 1) [lead] = hits;
    }
    if (!lead) { unmatched.push({ line, name, email, reason: 'no lead with that name' }); continue; }

    staged.push({ id: lead.id, email, name: lead.business_name, replaced: Boolean(lead.email) });
  }

  apply(staged);
  matched.push(...staged);

  res.json({ matched: matched.length, updated: matched, unmatched, invalid });
}));

export default router;

/**
 * Pull replies out of Gmail, match them to leads, and extract a brief.
 *
 * The matching is deliberately conservative: a message counts as a reply
 * only when its From address is already on a lead. We never guess from the
 * subject line or thread — a false match would attach a stranger's email to
 * someone else's lead and, worse, could end up quoted back into a mockup.
 *
 * Reading is gated twice: the user has to turn it on (a setting) AND Google
 * has to have actually granted the scope. Both are checked before a single
 * request is made, because the failure mode otherwise is a confusing 403
 * from deep inside the API client.
 */

import { db } from '../db.js';
import { nowIso } from './http.js';
import {
  isConnected, readEnabled, hasReadScope, listMessages, getMessage, replyQuery, GmailError,
} from './gmail.js';
import { buildBrief } from './brief.js';
import { classifyReply } from './reply-draft.js';

/** Gmail caps query length; 40 addresses per query stays well inside it. */
const ADDRESSES_PER_QUERY = 40;

export function readiness() {
  if (!isConnected()) {
    return { ready: false, code: 'NOT_CONNECTED', reason: 'Gmail is not connected.' };
  }
  if (!readEnabled()) {
    return {
      ready: false,
      code: 'READ_DISABLED',
      reason: 'Reading replies is switched off. Turn it on under Settings, then reconnect '
            + 'Gmail so the read permission is granted.',
    };
  }
  if (!hasReadScope()) {
    return {
      ready: false,
      code: 'NO_READ_SCOPE',
      reason: 'Gmail is connected but without permission to read. Reconnect the account — '
            + 'the consent screen will now ask for read access as well as send.',
    };
  }
  return { ready: true, code: 'OK', reason: null };
}

/** Every lead address we might see a reply from, lowercased. */
function leadAddresses() {
  return db.prepare(
    `SELECT DISTINCT LOWER(TRIM(email)) AS email FROM leads
      WHERE email IS NOT NULL AND TRIM(email) <> ''`
  ).all().map((r) => r.email).filter(Boolean);
}

function leadByAddress(address) {
  return db.prepare(
    'SELECT * FROM leads WHERE LOWER(TRIM(email)) = ? ORDER BY id LIMIT 1'
  ).get(String(address).toLowerCase());
}

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Fetch new replies and store them. Returns a summary; never throws for an
 * ordinary Gmail failure, so a scheduled sync cannot take the server down.
 *
 * `sinceDays` bounds the search — there is no point re-reading a year of
 * mail every few minutes.
 */
export async function syncReplies({ sinceDays = 30, max = 50, extract = true } = {}) {
  const gate = readiness();
  if (!gate.ready) return { ok: false, ...gate, found: 0, stored: 0 };

  const addresses = leadAddresses();
  if (!addresses.length) {
    return { ok: true, found: 0, stored: 0, reason: 'No leads have an email address yet.' };
  }

  const seen = db.prepare('SELECT provider_id FROM replies WHERE provider_id IS NOT NULL');
  const known = new Set(seen.all().map((r) => r.provider_id));

  const insert = db.prepare(
    `INSERT INTO replies
       (lead_id, channel, provider_id, thread_id, from_address, subject, body,
        received_at, fetched_at)
     VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id) DO NOTHING`
  );

  let found = 0;
  let stored = 0;
  const errors = [];
  const newReplyIds = [];

  for (const batch of chunk(addresses, ADDRESSES_PER_QUERY)) {
    const q = replyQuery(batch, { sinceDays });
    if (!q) continue;

    let ids;
    try {
      ids = await listMessages(q, { max });
    } catch (err) {
      errors.push(err instanceof GmailError ? err.message : String(err.message ?? err));
      // A permission or auth failure will fail identically for every batch,
      // so stop rather than repeating it once per chunk.
      if (err?.code === 'NO_READ_SCOPE' || err?.code === 'REAUTH_NEEDED') break;
      continue;
    }

    for (const { id } of ids) {
      if (known.has(id)) continue;
      found++;
      let msg;
      try {
        msg = await getMessage(id);
      } catch (err) {
        errors.push(`message ${id}: ${err.message}`);
        continue;
      }

      const lead = leadByAddress(msg.from_address);
      if (!lead) continue; // not one of ours after all

      const info = insert.run(
        lead.id, msg.id, msg.threadId, msg.from_address,
        msg.subject, msg.body, msg.received_at, nowIso()
      );
      if (!info.changes) continue;
      stored++;
      newReplyIds.push({ replyId: Number(info.lastInsertRowid), lead });

      // A reply is the strongest possible signal that a lead is live.
      db.prepare(
        `UPDATE leads
            SET status = CASE WHEN status IN ('new','sent') THEN 'replied' ELSE status END
          WHERE id = ?`
      ).run(lead.id);
    }
  }

  let briefed = 0;
  if (extract) {
    for (const { replyId, lead } of newReplyIds) {
      try {
        await extractBriefFor(replyId, lead);
        briefed++;
      } catch (err) {
        errors.push(`brief for reply ${replyId}: ${err.message}`);
      }
    }
  }

  return { ok: true, found, stored, briefed, errors, addresses: addresses.length };
}

/**
 * Build (or rebuild) the brief for one reply. Safe to re-run: the row is
 * replaced, which is how a user gets a better brief after installing Ollama.
 */
export async function extractBriefFor(replyId, leadRow = null) {
  const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(replyId);
  if (!reply) throw new Error(`No reply ${replyId}`);
  const lead = leadRow ?? db.prepare('SELECT * FROM leads WHERE id = ?').get(reply.lead_id) ?? {};

  const b = await buildBrief(reply.body, lead);

  db.prepare(
    `INSERT INTO briefs
       (reply_id, lead_id, trading_name, services, primary_cta, areas, has_logo, has_photos,
        brand_colours, tone, notes, source, confidence, created_at, updated_at)
     VALUES (@reply_id, @lead_id, @trading_name, @services, @primary_cta, @areas, @has_logo,
             @has_photos, @brand_colours, @tone, @notes, @source, @confidence, @now, @now)
     ON CONFLICT(reply_id) DO UPDATE SET
       trading_name=excluded.trading_name,
       services=excluded.services, primary_cta=excluded.primary_cta, areas=excluded.areas,
       has_logo=excluded.has_logo, has_photos=excluded.has_photos,
       brand_colours=excluded.brand_colours, tone=excluded.tone, notes=excluded.notes,
       source=excluded.source, confidence=excluded.confidence, updated_at=excluded.updated_at,
       edited_by_user=0`
  ).run({
    reply_id: replyId,
    lead_id: reply.lead_id,
    trading_name: b.trading_name ?? null,
    services: JSON.stringify(b.services ?? []),
    primary_cta: b.primary_cta,
    areas: JSON.stringify(b.areas ?? []),
    has_logo: b.has_logo ? 1 : 0,
    has_photos: b.has_photos ? 1 : 0,
    brand_colours: JSON.stringify(b.brand_colours ?? []),
    tone: b.tone,
    notes: b.notes,
    source: b.source,
    confidence: b.confidence,
    now: nowIso(),
  });

  return { ...b, reply_id: replyId, model_error: b.model_error ?? null };
}

/* -------------------------------------------------------------- reading */

const parseJson = (s, fallback) => {
  try { return JSON.parse(s ?? ''); } catch { return fallback; }
};

/** Shape a brief row for the API: JSON columns back into real values. */
export function briefToApi(row) {
  if (!row) return null;
  return {
    ...row,
    services: parseJson(row.services, []),
    areas: parseJson(row.areas, []),
    brand_colours: parseJson(row.brand_colours, []),
    has_logo: row.has_logo === 1,
    has_photos: row.has_photos === 1,
    edited_by_user: row.edited_by_user === 1,
  };
}

export function listReplies({ limit = 50, leadId = null, unreadOnly = false } = {}) {
  const where = [];
  const params = [];
  if (leadId != null) { where.push('r.lead_id = ?'); params.push(leadId); }
  if (unreadOnly) where.push('r.read_at IS NULL');

  const rows = db.prepare(
    `SELECT r.*, l.business_name, l.category, l.location, l.phone, l.status AS lead_status,
            b.id AS brief_id, b.trading_name, b.services, b.primary_cta, b.areas,
            b.has_logo, b.has_photos,
            b.brand_colours, b.tone, b.notes, b.source AS brief_source,
            b.confidence AS brief_confidence, b.edited_by_user,
            m.token AS mockup_token, m.generated_at AS mockup_generated_at
       FROM replies r
       LEFT JOIN leads   l ON l.id = r.lead_id
       LEFT JOIN briefs  b ON b.reply_id = r.id
       -- The latest mock up only: a rebuild adds a row, and a plain join
       -- listed the reply once per build. Built from this reply, or failing
       -- that the one built for them before they replied (a follow-up's),
       -- so it shows here rather than being built a second time.
       LEFT JOIN mockups m ON m.id = COALESCE(
         (SELECT m2.id FROM mockups m2 WHERE m2.brief_id = b.id
           ORDER BY m2.generated_at DESC, m2.id DESC LIMIT 1),
         (SELECT m3.id FROM mockups m3 WHERE m3.lead_id = r.lead_id AND m3.brief_id IS NULL
             AND m3.error IS NULL
           ORDER BY m3.generated_at DESC, m3.id DESC LIMIT 1))
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.received_at DESC
      LIMIT ?`
  ).all(...params, Math.min(200, Math.max(1, limit)));

  return rows.map((r) => ({
    id: r.id,
    // What kind of reply it is (a yes, a no, "we've got someone"), so the
    // screen can leave the build tools off a reply that turned us down.
    intent: classifyReply(r.body, {}, { location: r.location }),
    lead_id: r.lead_id,
    business_name: r.business_name,
    category: r.category,
    location: r.location,
    phone: r.phone,
    lead_status: r.lead_status,
    channel: r.channel,
    from_address: r.from_address,
    subject: r.subject,
    body: r.body,
    received_at: r.received_at,
    fetched_at: r.fetched_at,
    read_at: r.read_at,
    brief: r.brief_id ? briefToApi({
      id: r.brief_id, trading_name: r.trading_name,
      services: r.services, primary_cta: r.primary_cta, areas: r.areas,
      has_logo: r.has_logo, has_photos: r.has_photos, brand_colours: r.brand_colours,
      tone: r.tone, notes: r.notes, source: r.brief_source, confidence: r.brief_confidence,
      edited_by_user: r.edited_by_user,
    }) : null,
    mockup: r.mockup_token
      ? { token: r.mockup_token, generated_at: r.mockup_generated_at }
      : null,
  }));
}

/**
 * The scheduler's look at Gmail: new replies filed on their own, every few
 * minutes, whenever Gmail is connected with permission to read. Skipped
 * (not an error) when it isn't, or while a look is still running.
 */
let checking = false;
const doneChecking = () => { checking = false; };
export async function checkForReplies() {
  if (checking || !readiness().ready) return { skipped: true };
  checking = true;
  try {
    return await syncReplies({ sinceDays: 14, max: 50 });
  } finally {
    doneChecking();
  }
}

/** How many replies have come in since this person last opened Replies. */
export function unseenReplies(user) {
  if (!user?.id) return 0;
  const row = db.prepare('SELECT replies_seen_at, created_at FROM users WHERE id = ?').get(user.id);
  const since = row?.replies_seen_at ?? row?.created_at ?? '';
  return db.prepare('SELECT COUNT(*) AS n FROM replies WHERE fetched_at > ?').get(since).n;
}

/** They have opened Replies: returns when they last had, to mark what is new. */
export function seeReplies(user) {
  if (!user?.id) return null;
  const row = db.prepare('SELECT replies_seen_at, created_at FROM users WHERE id = ?').get(user.id);
  db.prepare('UPDATE users SET replies_seen_at = ? WHERE id = ?').run(nowIso(), user.id);
  return row?.replies_seen_at ?? row?.created_at ?? null;
}

export function markRead(replyId) {
  db.prepare('UPDATE replies SET read_at = ? WHERE id = ? AND read_at IS NULL')
    .run(nowIso(), replyId);
}

/**
 * Record a reply that arrived somewhere other than email — a WhatsApp
 * message, a note from a phone call. Same pipeline from here on.
 */
export async function recordManualReply({ leadId, body, channel = 'manual', subject = null }) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error(`No lead ${leadId}`);
  const replyId = insertReply({ leadId, body, channel, subject });
  const brief = await extractBriefFor(replyId, lead);
  return { replyId, brief };
}

/**
 * The filing half of that, with no brief: synchronous, so a caller can do it
 * inside a transaction. `receivedAt` is when they sent it, when that is known;
 * `threadId` is, for WhatsApp, the number it came from (so the answer goes
 * back to the same chat). `from_address` stays the lead's email either way,
 * because the Replies screen offers it as the address to answer by email.
 */
export function insertReply({
  leadId, body, channel = 'manual', subject = null, receivedAt = null, threadId = null,
}) {
  const lead = db.prepare('SELECT email FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error(`No lead ${leadId}`);
  const info = db.prepare(
    `INSERT INTO replies (lead_id, channel, thread_id, from_address, subject, body, received_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(leadId, channel, threadId, lead.email ?? null, subject, body, receivedAt ?? nowIso(), nowIso());
  db.prepare(
    `UPDATE leads SET status = CASE WHEN status IN ('new','sent') THEN 'replied' ELSE status END
      WHERE id = ?`
  ).run(leadId);
  return Number(info.lastInsertRowid);
}

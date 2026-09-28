/**
 * Replies, briefs and generated mockups.
 *
 *   GET    /api/replies                 what has come back, with briefs
 *   POST   /api/replies/sync            pull new replies from Gmail
 *   POST   /api/replies/manual          record a reply that came another way
 *   POST   /api/replies/whatsapp-paste  file messages copied out of WhatsApp
 *   POST   /api/replies/:id/extract     re-run the brief extractor
 *   PATCH  /api/replies/:id/brief       user corrections to the brief
 *   POST   /api/replies/:id/read        mark as read
 *   POST   /api/replies/:id/reply        send a reply via Resend
 *   POST   /api/mockups                 generate a site from a brief
 *   GET    /api/mockups                 list generated mockups
 *   POST   /api/mockups/:id/sent        record that the link was sent
 *   GET    /api/ollama                  is the local model there?
 */

import { Router } from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { wrap, badRequest, notFound, nowIso, str, int } from '../lib/http.js';
import {
  syncReplies, extractBriefFor, listReplies, markRead, recordManualReply,
  readiness, briefToApi, insertReply,
} from '../lib/replies.js';
import {
  configured as resendConfigured, sendEmail as resendSend,
} from '../lib/resend.js';
import { getUserById } from '../lib/auth.js';
import { sendingDomain } from '../lib/sending-policy.js';
import { looksLikeEmail } from '../lib/http.js';
import { renderSite, writeSite, newToken, PAGES, SINGLE_PAGE } from '../lib/site-builder.js';
import { briefForBuild, CTAS } from '../lib/brief.js';
import { available as ollamaAvailable, model as ollamaModel } from '../lib/ollama.js';
import { getSetting, getSettings } from '../db.js';
import { draftReply } from '../lib/reply-draft.js';
import { askQuestions } from '../lib/ask.js';
import { leadVoice } from '../lib/auth.js';
import { senderContext, firstName } from '../lib/template.js';
import { normalisePhone } from '../lib/handoff.js';
import { suppress } from '../lib/suppression.js';
import { recordContact } from '../lib/recontact.js';
import {
  parseWhatsApp, theirSide, fingerprint, senderKey, senderPhone, nameFit,
} from '../lib/wa-paste.js';

/** The starting prices the "how much?" answer quotes, from the Prices screen. */
function startingPrices() {
  let list = null;
  try { list = JSON.parse(getSetting('price_list_json', 'null')); } catch { /* defaults */ }
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  // The Prices screen's own defaults: a one-page site, and the cheapest plan.
  return { from: n(list?.pages?.one_page, 300), monthly: n(list?.monthly?.keep_it_live, 12) };
}

/**
 * The drafted answer to one reply, with what the screen needs to send it:
 * the WhatsApp number it came from, and a built mock up's link.
 */
function draftFor(replyId, { user = null, origin = null, kind = null } = {}) {
  const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(replyId);
  if (!reply) throw notFound('Reply not found');
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(reply.lead_id);
  if (!lead) throw notFound('Lead not found');
  const brief = briefToApi(db.prepare('SELECT * FROM briefs WHERE reply_id = ?').get(replyId)) ?? {};
  const mockup = db.prepare(
    'SELECT token FROM mockups WHERE lead_id = ? AND error IS NULL ORDER BY generated_at DESC LIMIT 1'
  ).get(lead.id);
  const base = /^https?:\/\/[^/\s]+$/i.test(String(origin ?? '')) ? origin : '';
  const sentTo = db.prepare(
    `SELECT recipient FROM outreach_events WHERE lead_id = ? AND channel = 'whatsapp'
      ORDER BY COALESCE(confirmed_sent_at, prepared_at) DESC LIMIT 1`
  ).get(lead.id)?.recipient;
  const phone = normalisePhone(sentTo ?? lead.phone ?? '');
  // A reply pasted from WhatsApp knows the number it came from: answer that
  // chat, even when it is not the number the first message went to.
  const cameFrom = reply.channel === 'whatsapp' && /^\+\d{8,15}$/.test(reply.thread_id ?? '')
    ? reply.thread_id : null;

  const draft = draftReply({
    body: reply.body,
    brief,
    lead,
    sender: senderContext(undefined, leadVoice(lead, user)).my_name,
    ask: askQuestions(),
    prices: startingPrices(),
    mockupUrl: mockup ? `${base}/m/${mockup.token}/` : null,
    kind,
  });
  return {
    ...draft,
    reply_id: reply.id,
    lead_id: lead.id,
    business_name: lead.business_name,
    wa_number: cameFrom ? cameFrom.slice(1) : (phone.ok ? phone.e164.replace(/^\+/, '') : null),
    has_mockup: Boolean(mockup),
  };
}

/**
 * They asked not to be contacted: honoured at once, the same way marking a
 * lead opted out does it, so no rep and no hunt offers them again.
 */
function optOut(lead) {
  db.prepare("UPDATE leads SET opted_out = 1, status = 'lost' WHERE id = ?").run(lead.id);
  if (lead.email) suppress(lead.email, { businessName: lead.business_name, reason: 'asked to stop' });
  recordContact(lead, 'opted out');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MOCKUP_ROOT = resolve(__dirname, '..', '..', 'data', 'mockups');

const router = Router();

/* ------------------------------------------------------------- replies */

router.get('/replies', wrap((req, res) => {
  res.json({
    replies: listReplies({
      limit: int(req.query.limit) ?? 50,
      leadId: int(req.query.lead_id),
      unreadOnly: req.query.unread === '1',
    }),
    gmail: readiness(),
  });
}));

router.post('/replies/sync', wrap(async (req, res) => {
  const out = await syncReplies({
    sinceDays: int(req.body?.since_days) ?? 30,
    max: Math.min(100, int(req.body?.max) ?? 50),
  });
  res.status(out.ok ? 200 : 422).json(out);
}));

router.post('/replies/manual', wrap(async (req, res) => {
  const leadId = int(req.body?.lead_id);
  const body = str(req.body?.body);
  if (!leadId) throw badRequest('lead_id is required');
  if (!body) throw badRequest('body is required — paste what they wrote back');

  const channel = str(req.body?.channel) ?? 'manual';
  if (!['manual', 'whatsapp', 'sms', 'email'].includes(channel)) {
    throw badRequest('channel must be manual, whatsapp, sms or email');
  }

  const out = await recordManualReply({
    leadId, body, channel, subject: str(req.body?.subject),
  });
  // The answer back, drafted from what they said. A "stop" is acted on here
  // and now, before anyone can reply to it.
  const draft = draftFor(out.replyId, { user: req.user, origin: str(req.body?.origin) });
  if (draft.intent === 'stop') optOut(db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId));
  res.status(201).json({
    reply_id: out.replyId,
    brief: out.brief,
    draft,
    replies: listReplies({ leadId }),
  });
}));

/* ------------------------------------------- pasted out of WhatsApp */

/**
 * Tells our side of a pasted chat from theirs: the team's names (full and
 * first) and phones, and the business name and number from Settings, which
 * is what a WhatsApp Business account signs its messages with.
 */
function ourSide() {
  const names = new Set(['you']);
  const phones = new Set();
  const name = (v) => { const n = String(v ?? '').trim().toLowerCase(); if (n) names.add(n); };
  const phone = (v) => { const p = senderPhone(v); if (p) phones.add(p); };
  for (const u of db.prepare('SELECT name, phone FROM users').all()) {
    name(u.name); name(firstName(u.name)); phone(u.phone);
  }
  const s = getSettings();
  name(s.biz_name); name(s.biz_contact_name); name(firstName(s.biz_contact_name)); phone(s.biz_phone);
  return (m) => (m.phone ? phones.has(m.phone) : names.has(String(m.sender ?? '').trim().toLowerCase()));
}

/**
 * The leads a WhatsApp number belongs to, best first: the number a WhatsApp
 * actually went to, then a lead's own phone, then a number the finder or a
 * rep filed against it (never one lifted from a directory page, which lists
 * other firms' numbers too).
 */
function leadsForNumber(e164) {
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  for (const r of db.prepare(
    `SELECT lead_id FROM outreach_events
      WHERE channel = 'whatsapp' AND recipient = ? AND lead_id IS NOT NULL
      ORDER BY confirmed_sent_at IS NULL, COALESCE(confirmed_sent_at, prepared_at) DESC`
  ).all(e164)) add(r.lead_id);
  const sent = ids.length;
  for (const r of db.prepare("SELECT id, phone FROM leads WHERE phone IS NOT NULL AND TRIM(phone) <> ''").all()) {
    if (normalisePhone(r.phone).e164 === e164) add(r.id);
  }
  for (const r of db.prepare(
    `SELECT lead_id FROM contact_signals
      WHERE kind IN ('phone', 'whatsapp') AND value = ?
        AND (promoted_at IS NOT NULL
             OR source IN ('places', 'lead:existing', 'user:manual', 'website', 'website:wa'))
      ORDER BY confidence DESC`
  ).all(e164)) add(r.lead_id);
  return { ids, sent };
}

/** A lead as the "whose reply is this?" list shows it. */
const candidate = (row, fit = null) => ({
  id: row.id,
  business_name: row.business_name,
  location: row.location,
  status: row.status,
  whatsapp_sent_at: row.wa_at ?? null,
  fit,
});

const CANDIDATE_SQL = `SELECT l.*, (SELECT MAX(oe.confirmed_sent_at) FROM outreach_events oe
  WHERE oe.lead_id = l.id AND oe.channel = 'whatsapp') AS wa_at FROM leads l`;

/**
 * Who it might be when the paste does not say: leads whose name fits a saved
 * contact name, then everyone messaged on WhatsApp lately, awaiting a reply
 * first.
 */
function candidatesFor({ ids = [], name = null } = {}) {
  const out = [];
  const seen = new Set();
  const push = (row, fit) => { if (row && !seen.has(row.id)) { seen.add(row.id); out.push(candidate(row, fit)); } };
  for (const id of ids) push(db.prepare(`${CANDIDATE_SQL} WHERE l.id = ?`).get(id));
  const recent = db.prepare(
    `${CANDIDATE_SQL} WHERE EXISTS (SELECT 1 FROM outreach_events oe WHERE oe.lead_id = l.id
       AND oe.channel = 'whatsapp' AND oe.confirmed_sent_at IS NOT NULL)
     ORDER BY (l.status = 'sent') DESC, wa_at DESC LIMIT 300`
  ).all();
  if (name) {
    recent.map((row) => ({ row, fit: nameFit(name, row.business_name) }))
      .filter((x) => x.fit > 0)
      .sort((a, b) => b.fit - a.fit)
      .slice(0, 5)
      .forEach((x) => push(x.row, Math.round(x.fit * 100)));
  }
  for (const row of recent) {
    if (out.length >= 8) break;
    push(row, null);
  }
  return out;
}

/**
 * POST /api/replies/whatsapp-paste { text, lead_id?, origin }
 *
 * Messages copied out of WhatsApp, filed against the lead they came from and
 * answered. Copied from WhatsApp Desktop, each message carries who sent it,
 * which for a prospect not saved in the phone is their number; that finds the
 * lead with nobody choosing it. Our own messages in the same paste are left
 * out, and anything already pasted before is not filed twice.
 *
 * Nothing is sent: the answer comes back drafted, to copy into WhatsApp.
 *
 *   201 { filed: true,  reply_id, lead, draft, messages }
 *   200 { filed: false, already: true, reply_id, lead, draft }  all pasted before
 *   200 { need_lead: true, reason, sender, preview, candidates }  say whose it is
 */
router.post('/replies/whatsapp-paste', wrap(async (req, res) => {
  const text = str(req.body?.text);
  if (!text) throw badRequest('Paste the WhatsApp messages they sent');
  const chosen = int(req.body?.lead_id);
  const chosenLead = chosen ? db.prepare('SELECT * FROM leads WHERE id = ?').get(chosen) : null;
  if (chosen && !chosenLead) throw notFound('Lead not found');

  const parsed = parseWhatsApp(text);
  if (!parsed.messages.length) throw badRequest('There is no message in that paste');
  const isUs = ourSide();

  // Everyone in the paste who is not us, with the leads their number is on.
  const people = [];
  for (const m of parsed.messages) {
    if (isUs(m) || people.some((p) => p.key === senderKey(m))) continue;
    people.push({ key: senderKey(m), sender: m.sender, phone: m.phone, found: m.phone ? leadsForNumber(m.phone) : null });
  }
  if (!people.length) throw badRequest('Those are all your own messages. Copy theirs too');

  let who = null;
  let lead = chosenLead;
  if (lead) {
    // The rep said whose it is: take the person whose number is on that lead,
    // else the one person in the paste.
    who = people.find((p) => p.found?.ids.includes(lead.id)) ?? people.find((p) => p.phone) ?? people[0];
  } else {
    const matched = people.filter((p) => p.found?.ids.length);
    if (matched.length === 1) {
      who = matched[0];
      const { ids, sent } = who.found;
      // One lead, or the number a WhatsApp of ours actually went to: that is
      // the conversation. Several leads sharing a phone and no send: ask.
      if (ids.length === 1 || sent > 0) lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(ids[0]);
    }
    if (!lead) {
      const first = who ?? people.find((p) => p.phone) ?? people[0];
      const their = theirSide(parsed.messages, (m) => senderKey(m) !== first.key).latest[first.key] ?? [];
      const reason = !parsed.headed ? 'no-header'
        : matched.length ? 'several'
        : first.phone ? 'unknown-number' : 'name';
      return res.json({
        need_lead: true,
        reason,
        sender: { name: first.phone ? null : first.sender, phone: first.phone },
        preview: their.map((m) => m.text).join('\n').slice(0, 600),
        candidates: candidatesFor({
          ids: matched.flatMap((p) => p.found.ids),
          name: first.phone ? null : first.sender,
        }),
      });
    }
  }

  // In a one-to-one chat, whoever is not them is us, whatever name we sign with.
  const theirs = theirSide(parsed.messages, (m) => senderKey(m) !== who.key).latest[who.key] ?? [];
  if (!theirs.length) throw badRequest('There is nothing from them in that paste');

  const filed = db.transaction(() => {
    const prints = theirs.map((m) => fingerprint(lead.id, m));
    const seenRow = db.prepare('SELECT reply_id FROM wa_paste_seen WHERE fingerprint = ?');
    const fresh = theirs.filter((_, i) => !seenRow.get(prints[i]));
    if (!fresh.length) return { replyId: seenRow.get(prints[prints.length - 1]).reply_id, fresh: 0 };
    const replyId = insertReply({
      leadId: lead.id,
      channel: 'whatsapp',
      body: fresh.map((m) => m.text).join('\n'),
      receivedAt: fresh[fresh.length - 1].at,
      threadId: who.phone,
    });
    const mark = db.prepare(
      'INSERT OR IGNORE INTO wa_paste_seen (fingerprint, lead_id, reply_id, seen_at) VALUES (?, ?, ?, ?)'
    );
    theirs.forEach((m, i) => mark.run(prints[i], lead.id, replyId, nowIso()));
    // A number the rep has just told us is this lead's: next time it matches
    // by itself.
    if (who.phone && !who.found?.ids.includes(lead.id)) {
      db.prepare(
        `INSERT INTO contact_signals
           (lead_id, kind, value, source, confidence, note, first_seen_at, last_seen_at)
         VALUES (?, 'whatsapp', ?, 'user:manual', 100, 'their WhatsApp, from a pasted reply', ?, ?)
         ON CONFLICT(lead_id, kind, value) DO UPDATE SET last_seen_at = excluded.last_seen_at`
      ).run(lead.id, who.phone, nowIso(), nowIso());
    }
    return { replyId, fresh: fresh.length };
  })();

  if (filed.fresh) {
    try {
      await extractBriefFor(filed.replyId, lead);
    } catch (err) {
      // The reply is filed and the answer does not need the brief.
      console.warn(`[replies] brief for pasted WhatsApp reply ${filed.replyId}: ${err.message}`);
    }
  }
  const draft = draftFor(filed.replyId, { user: req.user, origin: str(req.body?.origin) });
  // They asked us to stop: honoured the moment it is filed, as a typed-in
  // reply would be.
  if (filed.fresh && draft.intent === 'stop' && !lead.opted_out) optOut(lead);

  res.status(filed.fresh ? 201 : 200).json({
    filed: Boolean(filed.fresh),
    already: !filed.fresh,
    reply_id: filed.replyId,
    messages: filed.fresh,
    lead: { id: lead.id, business_name: lead.business_name },
    draft,
  });
}));

/** GET /api/replies/:id/draft?origin=&kind=mockup — the answer, drafted again. */
router.get('/replies/:id/draft', wrap((req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');
  const kind = str(req.query.kind) === 'mockup' ? 'mockup' : null;
  res.json({ draft: draftFor(id, { user: req.user, origin: str(req.query.origin), kind }) });
}));

/** POST /api/leads/:id/has-website — they told us they have one. */
router.post('/leads/:id/has-website', wrap((req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(int(req.params.id));
  if (!lead) throw notFound('Lead not found');
  db.prepare(
    `UPDATE leads SET has_website = 1, website_evidence = 'they said so', website_checked_at = ?,
       status = CASE WHEN status IN ('new', 'sent', 'replied') THEN 'lost' ELSE status END
     WHERE id = ?`
  ).run(nowIso(), lead.id);
  res.json({ ok: true });
}));

router.post('/replies/:id/extract', wrap(async (req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');
  const brief = await extractBriefFor(id);
  res.json({ brief, replies: listReplies({ leadId: brief.lead_id ?? undefined }) });
}));

router.post('/replies/:id/read', wrap((req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');
  markRead(id);
  res.json({ ok: true });
}));

/**
 * User corrections. Anything the extractor got wrong is fixed here, and the
 * row is flagged so a later re-extract does not quietly undo the edit.
 */
router.patch('/replies/:id/brief', wrap((req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');
  const existing = db.prepare('SELECT * FROM briefs WHERE reply_id = ?').get(id);
  if (!existing) throw notFound('No brief for that reply yet — extract one first.');

  const b = req.body ?? {};
  const cta = b.primary_cta === undefined ? existing.primary_cta : str(b.primary_cta);
  if (cta && !CTAS.includes(cta)) {
    throw badRequest(`primary_cta must be one of: ${CTAS.join(', ')}`);
  }

  const asJson = (v, fallback) => {
    if (v === undefined) return fallback;
    const list = Array.isArray(v)
      ? v
      : String(v).split('\n').map((s) => s.trim()).filter(Boolean);
    return JSON.stringify(list.slice(0, 20));
  };

  db.prepare(
    `UPDATE briefs SET
       trading_name=@trading_name,
       services=@services, primary_cta=@cta, areas=@areas,
       has_logo=@has_logo, has_photos=@has_photos, brand_colours=@colours,
       notes=@notes, edited_by_user=1, updated_at=@now
     WHERE reply_id=@id`
  ).run({
    id,
    trading_name: b.trading_name === undefined ? existing.trading_name : str(b.trading_name),
    services: asJson(b.services, existing.services),
    cta,
    areas: asJson(b.areas, existing.areas),
    colours: asJson(b.brand_colours, existing.brand_colours),
    has_logo: b.has_logo === undefined ? existing.has_logo : (b.has_logo ? 1 : 0),
    has_photos: b.has_photos === undefined ? existing.has_photos : (b.has_photos ? 1 : 0),
    notes: b.notes === undefined ? existing.notes : str(b.notes),
    now: nowIso(),
  });

  res.json({ brief: briefToApi(db.prepare('SELECT * FROM briefs WHERE reply_id = ?').get(id)) });
}));

/* ------------------------------------------------------------- mockups */

router.post('/mockups', wrap((req, res) => {
  const replyId = int(req.body?.reply_id);
  const leadId  = int(req.body?.lead_id);
  if (!replyId && !leadId) throw badRequest('Supply reply_id or lead_id');

  const briefRow = replyId
    ? db.prepare('SELECT * FROM briefs WHERE reply_id = ?').get(replyId)
    : db.prepare('SELECT * FROM briefs WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1').get(leadId);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?')
    .get(briefRow?.lead_id ?? leadId);
  if (!lead) throw notFound('Lead not found');

  // A mockup can be built with no brief at all — from the lead alone. It is
  // more generic, but "no reply yet" should not block making something to
  // show them.
  const brief = briefRow
    ? briefForBuild(briefToApi(briefRow), lead)
    : briefForBuild({ services: [], areas: [] }, lead);

  const token = newToken();
  const studio = getSetting('biz_name', 'this studio');
  // One page unless the caller explicitly asks for the four-file build.
  const layout = req.body?.pages === 'multi' ? 'multi' : 'single';
  const files = renderSite(brief, {
    draftNote: `Draft mockup for ${brief.business_name} — prepared by ${studio}`,
    pages: layout,
  });

  let error = null;
  try {
    writeSite(MOCKUP_ROOT, token, files);
  } catch (err) {
    error = err.message;
  }
  if (error) throw new Error(`Could not write the mockup: ${error}`);

  const info = db.prepare(
    `INSERT INTO mockups
       (lead_id, brief_id, token, business_name, trade, pages, palette, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lead.id, briefRow?.id ?? null, token, lead.business_name,
    brief.trade ?? lead.category ?? null,
    JSON.stringify(layout === 'multi' ? PAGES : SINGLE_PAGE),
    JSON.stringify(brief.brand_colours ?? []), nowIso()
  );

  res.status(201).json({
    mockup: {
      id: Number(info.lastInsertRowid),
      token,
      url: `/m/${token}/`,
      pages: layout === 'multi' ? PAGES : SINGLE_PAGE,
      layout,
      business_name: brief.business_name,
    },
    brief,
  });
}));

router.get('/mockups', wrap((req, res) => {
  const leadId = int(req.query.lead_id);
  const rows = leadId
    ? db.prepare('SELECT * FROM mockups WHERE lead_id = ? ORDER BY generated_at DESC').all(leadId)
    : db.prepare('SELECT * FROM mockups ORDER BY generated_at DESC LIMIT 100').all();
  res.json({
    mockups: rows.map((m) => ({ ...m, url: `/m/${m.token}/`, pages: JSON.parse(m.pages ?? '[]') })),
  });
}));

/**
 * Send a reply to the lead directly via Resend — no Gmail "Send mail as" needed.
 */
router.post('/replies/:id/reply', wrap(async (req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');

  const reply = db.prepare(
    `SELECT r.*, l.business_name, l.email AS lead_email, l.id AS lid
     FROM replies r JOIN leads l ON l.id = r.lead_id
     WHERE r.id = ?`
  ).get(id);
  if (!reply) throw notFound('Reply not found');

  const to = str(req.body?.to) || reply.lead_email || reply.from_address;
  if (!to || !looksLikeEmail(to)) throw badRequest('No valid recipient email');

  const subject = str(req.body?.subject)
    || (reply.subject ? `Re: ${reply.subject.replace(/^Re:\s*/i, '')}` : `Your website — ${reply.business_name}`);
  const body = str(req.body?.body);
  if (!body) throw badRequest('body is required');

  if (!resendConfigured()) {
    throw badRequest('Resend is not configured — set RESEND_API_KEY in .env');
  }

  const domain = sendingDomain();
  if (!domain) throw badRequest('No sending domain — set biz_email in Settings');

  const rep = req.user ? getUserById(req.user.id) : null;
  const fromAddr = (rep?.work_email || db.prepare("SELECT value FROM settings WHERE key='biz_email'").get()?.value || '').trim().toLowerCase();
  if (!fromAddr || !looksLikeEmail(fromAddr)) {
    throw badRequest('No valid from address — set biz_email or a work_email');
  }
  const fromName = rep?.name || getSetting('biz_contact_name', '');
  const from = fromName ? `${fromName} <${fromAddr}>` : fromAddr;

  const sent = await resendSend({ from, to, subject, text: body, replyTo: fromAddr });

  const at = nowIso();
  const fromDomain = fromAddr.split('@')[1] ?? null;
  db.prepare(
    `INSERT INTO email_log
       (lead_id, template_id, lead_name, to_email, subject_snapshot, body_snapshot,
        sent_at, channel, provider_message_id, provider, from_domain)
     VALUES (?, NULL, ?, ?, ?, ?, ?, 'gmail', ?, 'resend', ?)`
  ).run(reply.lid, reply.business_name, to, subject, body, at, sent.id, fromDomain);

  db.prepare(
    `UPDATE leads SET last_contacted_at = ?,
       status = CASE WHEN status IN ('new','replied') THEN 'sent' ELSE status END
     WHERE id = ?`
  ).run(at, reply.lid);

  res.json({ ok: true, message_id: sent.id, to, subject });
}));

router.post('/mockups/:id/sent', wrap((req, res) => {
  const id = int(req.params.id);
  const info = db.prepare('UPDATE mockups SET sent_at = ? WHERE id = ?').run(nowIso(), id);
  if (!info.changes) throw notFound('No such mockup');
  res.json({ ok: true });
}));

/* -------------------------------------------------------------- ollama */

router.get('/ollama', wrap(async (req, res) => {
  const probe = await ollamaAvailable({ force: req.query.force === '1' });
  res.json({
    ...probe,
    model: ollamaModel(),
    // What the tool does without it, so the UI can be honest rather than
    // presenting this as broken.
    fallback: 'Replies are still parsed by the built-in rules; a numbered '
            + 'reply extracts fine without any model at all.',
  });
}));

export default router;

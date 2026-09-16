/**
 * Replies, briefs and generated mockups.
 *
 *   GET    /api/replies                 what has come back, with briefs
 *   POST   /api/replies/sync            pull new replies from Gmail
 *   POST   /api/replies/manual          record a reply that came another way
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
  readiness, briefToApi,
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
import { getSetting } from '../db.js';

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
  res.status(201).json({
    reply_id: out.replyId,
    brief: out.brief,
    replies: listReplies({ leadId }),
  });
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

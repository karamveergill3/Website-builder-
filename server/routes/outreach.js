/**
 * Routes for the free-tier discovery and multi-channel outreach.
 *
 *   POST /api/leads/:id/find-contacts   run one discovery pass
 *   GET  /api/leads/:id/signals         list what we've found
 *   POST /api/leads/:id/signals/:sid/promote   copy a signal into email/phone
 *   POST /api/outreach/prepare          gate-check + render + return deep link
 *   POST /api/outreach/log              user confirms they sent it
 *   POST /api/outreach/:id/sent         mark a prepared event as sent
 */

import { Router } from 'express';
import { db } from '../db.js';
import { wrap, badRequest, notFound, nowIso, requiredStr } from '../lib/http.js';
import { sendability } from '../lib/pecr.js';
import { recontactCheck, recordContact } from '../lib/recontact.js';
import { isSuppressed } from '../lib/suppression.js';
import { discover, signalsForLead, promoteSignal, recentFinds } from '../lib/contact-finder.js';
import { handoff } from '../lib/handoff.js';
import { renderTemplate } from '../lib/template.js';

const router = Router();

const CHANNELS = ['whatsapp', 'sms', 'call'];

function getLead(id) {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!row) throw notFound(`Lead ${id} not found`);
  return row;
}

router.get('/leads/:id/signals', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Bad lead id');
  getLead(id); // 404 if missing
  res.json({
    signals: signalsForLead(id),
    finds: recentFinds(id),
  });
}));

router.post('/leads/:id/find-contacts', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Bad lead id');
  const lead = getLead(id);
  const opts = {
    web:        req.body?.web !== false,
    websiteUrl: req.body?.website_url ?? null,
  };
  // A URL the user pastes in is worth filing as a website signal so a
  // later re-run picks it up automatically.
  if (opts.websiteUrl) {
    db.prepare(
      `INSERT INTO contact_signals
         (lead_id, kind, value, source, confidence, first_seen_at, last_seen_at)
       VALUES (?, 'website', ?, 'user:manual', 100, ?, ?)
       ON CONFLICT(lead_id, kind, value) DO UPDATE SET last_seen_at = excluded.last_seen_at`
    ).run(id, opts.websiteUrl, nowIso(), nowIso());
  }
  const out = await discover(lead, opts);
  res.json({
    signals: out.signals,
    sources: out.sources,
    errors:  out.errors,
    find_id: out.findId,
  });
}));

router.post('/leads/:id/signals/:sid/promote', wrap((req, res) => {
  const id = Number(req.params.id);
  const sid = Number(req.params.sid);
  if (!Number.isInteger(id) || !Number.isInteger(sid)) throw badRequest('Bad id');
  getLead(id);
  const p = promoteSignal(id, sid);
  if (!p) throw notFound('No such signal');
  res.json({ promoted: p.promoted, signals: signalsForLead(id) });
}));

router.delete('/leads/:id/signals/:sid', wrap((req, res) => {
  const id = Number(req.params.id);
  const sid = Number(req.params.sid);
  if (!Number.isInteger(id) || !Number.isInteger(sid)) throw badRequest('Bad id');
  const info = db.prepare(
    'DELETE FROM contact_signals WHERE id = ? AND lead_id = ?'
  ).run(sid, id);
  if (!info.changes) throw notFound('No such signal');
  res.json({ ok: true, signals: signalsForLead(id) });
}));

/**
 * Pre-flight a WhatsApp/SMS/Call send: check PECR, render the template,
 * return the deep link and a prepared event id.
 *
 * Body: { lead_id, channel, template_id? , text? }
 * If text is supplied, it wins over the template. Otherwise the template is
 * rendered against the lead. Empty text is only accepted for the 'call'
 * channel (no message to prepare, just a click-to-dial).
 */
router.post('/outreach/prepare', wrap((req, res) => {
  const leadId = Number(req.body?.lead_id);
  if (!Number.isInteger(leadId)) throw badRequest('lead_id is required');
  const channel = requiredStr(req.body?.channel, 'channel');
  if (!CHANNELS.includes(channel)) {
    throw badRequest(`channel must be one of: ${CHANNELS.join(', ')}`);
  }
  const lead = getLead(leadId);

  const verdict = sendability(lead, {
    channel,
    suppressed: isSuppressed(lead.email),
  });
  if (!verdict.allowed) {
    return res.status(422).json({
      error: verdict.reason,
      code: verdict.code,
      channel,
    });
  }

  // Whether this company has been approached before, on ANY channel. Until
  // now this endpoint had exactly one gate — the PECR check above — which
  // asks whether we may lawfully contact this business at all, never whether
  // we already have. So the same roofer could be handed a fresh WhatsApp
  // link every morning, and an email yesterday placed no obstacle at all.
  const again = recontactCheck(lead, { allowRepeat: Boolean(req.body?.allow_repeat) });
  if (!again.allowed) {
    return res.status(422).json({
      error: again.reason,
      code: again.code,
      channel,
      previous: again.previous,
      previous_channel: again.channel ?? null,
      times: again.times ?? null,
    });
  }

  let text = null;
  let templateId = null;
  let subject = null;
  if (channel !== 'call') {
    if (req.body?.text) {
      text = String(req.body.text).trim();
    } else if (req.body?.template_id) {
      templateId = Number(req.body.template_id);
      const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId);
      if (!tpl) throw notFound('Template not found');
      if (tpl.channel !== channel) {
        throw badRequest(
          `Template "${tpl.name}" is for ${tpl.channel}, not ${channel}.`
        );
      }
      const r = renderTemplate(tpl, lead);
      text = r.body;
      subject = r.subject;
    } else {
      throw badRequest('Supply a template_id or a text.');
    }
    if (!text) throw badRequest('Message body is empty.');
  }

  const link = handoff({ channel, phone: lead.phone, text });
  if (!link.ok) {
    return res.status(422).json({
      error: `Cannot build a ${channel} link: ${link.reason}`,
      code: 'BAD_PHONE',
      channel,
    });
  }

  // Log the prepare so recent activity shows what was queued.
  const info = db.prepare(
    `INSERT INTO outreach_events
       (lead_id, template_id, lead_name, channel, recipient, body_snapshot, prepared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(leadId, templateId, lead.business_name, channel, link.e164, text, nowIso());

  res.json({
    event_id: info.lastInsertRowid,
    url: link.url,
    e164: link.e164,
    mobile: link.mobile,
    channel,
    text,
    subject,
    advice: verdict.advice ?? null,
  });
}));

/**
 * The user confirms they've tapped Send in WhatsApp / dialled / sent the SMS.
 * We record it against the prepared event and touch the lead's contacted_at.
 */
router.post('/outreach/:id/sent', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('Bad id');
  const row = db.prepare('SELECT * FROM outreach_events WHERE id = ?').get(id);
  if (!row) throw notFound('No such outreach event');
  const now = nowIso();
  db.prepare('UPDATE outreach_events SET confirmed_sent_at = ? WHERE id = ?').run(now, id);
  if (row.lead_id) {
    db.prepare(
      `UPDATE leads SET last_contacted_at = ?, status = CASE WHEN status = 'new' THEN 'sent' ELSE status END WHERE id = ?`
    ).run(now, row.lead_id);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(row.lead_id);
    if (lead) recordContact(lead, row.channel, now);
  }
  res.json({ ok: true, confirmed_sent_at: now });
}));

router.get('/outreach', wrap((req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({
    events: db.prepare(
      `SELECT id, lead_id, template_id, lead_name, channel, recipient,
              body_snapshot, prepared_at, confirmed_sent_at
         FROM outreach_events
         ORDER BY prepared_at DESC
         LIMIT ?`
    ).all(limit),
  });
}));

export default router;

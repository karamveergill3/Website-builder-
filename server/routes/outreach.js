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
import { db, getSetting } from '../db.js';
import { wrap, badRequest, notFound, nowIso, requiredStr } from '../lib/http.js';
import { sendability } from '../lib/pecr.js';
import { recontactCheck, recordContact } from '../lib/recontact.js';
import { isSuppressed } from '../lib/suppression.js';
import { discover, signalsForLead, promoteSignal, recentFinds, autoPromote } from '../lib/contact-finder.js';
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

/* ------------------------------------------------- bulk contact discovery */

/**
 * Find contact details for a batch of leads.
 *
 * The hunt files companies Google has never heard of — registered, real,
 * and with no listing at all. Those arrive with no website AND no phone,
 * because Google was the only thing that could have supplied one. They are
 * often the best prospects precisely because nobody has marketed to them,
 * and until now the only way to get a number was to open each lead and press
 * a button.
 *
 * Runs in the background because contact-finder.js is deliberately slow: a
 * three-second global gate between fetches, so forty leads is minutes rather
 * than seconds. Polled the same way the hunt is.
 */
let sweep = null;
export const activeSweep = () => sweep;

router.post('/leads/find-contacts', wrap(async (req, res) => {
  if (sweep?.running) throw badRequest('A contact sweep is already running.');

  const ids = Array.isArray(req.body?.lead_ids)
    ? req.body.lead_ids.map(Number).filter(Number.isInteger)
    : [];
  // With no explicit list, sweep the leads that need it most: no email, no
  // phone, and never approached. Those are the ones that are otherwise dead.
  const leads = ids.length
    ? ids.map((id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id)).filter(Boolean)
    : db.prepare(
      `SELECT * FROM leads
        WHERE (email IS NULL OR TRIM(email) = '')
          AND (phone IS NULL OR TRIM(phone) = '')
          AND opted_out = 0
        ORDER BY created_at DESC
        LIMIT 100`
    ).all();

  if (!leads.length) {
    return res.json({ started: false, reason: 'Nothing to look up — every lead already has a phone or an email.' });
  }

  sweep = {
    running: true, total: leads.length, done: 0,
    found_phone: 0, found_mobile: 0, found_email: 0, none: 0,
    started_at: nowIso(), finished_at: null, error: null,
  };

  (async () => {
    for (const lead of leads) {
      if (!sweep.running) break;
      try {
        const out = await discover(lead, { web: lead.has_website !== 0 });
        // Copy the best number/email onto the lead so it shows on the row and
        // the mobile/reachable filters work, mobile preferred for WhatsApp.
        const promoted = autoPromote(lead.id);
        const kinds = new Set((out.signals ?? []).map((sig) => sig.kind));
        if (kinds.has('phone')) sweep.found_phone += 1;
        if (promoted.phoneMobile) sweep.found_mobile += 1;
        if (kinds.has('email')) sweep.found_email += 1;
        if (!kinds.has('phone') && !kinds.has('email')) sweep.none += 1;
      } catch (err) {
        // One lead failing must not end the sweep — a directory being down
        // says nothing about the next lead.
        sweep.none += 1;
        sweep.error = err.message;
      }
      sweep.done += 1;
    }
    sweep.running = false;
    sweep.finished_at = nowIso();
  })();

  res.status(202).json({ started: true, total: leads.length });
}));

router.get('/leads/find-contacts/status', wrap((_req, res) => {
  res.json({ sweep });
}));

router.post('/leads/find-contacts/stop', wrap((_req, res) => {
  if (sweep?.running) sweep.running = false;
  res.json({ sweep });
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
    // Owner override: message any business regardless of legal form. Still
    // never lifts opt-out or suppression — those are the recipient's own "no".
    allowUncleared: getSetting('outreach_allow_uncleared', '0') === '1',
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
      const r = renderTemplate(tpl, lead, undefined, req.user);
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

import { Router } from 'express';
import { db, getSettings } from '../db.js';
import { wrap, badRequest, notFound, nowIso, int, str, looksLikeEmail } from '../lib/http.js';
import { renderTemplate, unknownPlaceholders } from '../lib/template.js';
import { withFooter, buildFooter } from '../lib/compliance.js';
import { sendability } from '../lib/pecr.js';
import { isSuppressed } from '../lib/suppression.js';

const router = Router();

/**
 * Compose one email for a lead + template, footer included.
 * Shared by the preview endpoint, the manual-send log, and the Phase 3 queue.
 */
export function composeFor(leadId, templateId, { requireEmail = false, requireCompliance = false } = {}) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw notFound('Lead not found');
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId);
  if (!template) throw notFound('Template not found');

  // One gate for every path that can produce a sendable email.
  const verdict = sendability(lead, { suppressed: isSuppressed(lead.email) });
  if (!verdict.allowed && ['OPTED_OUT', 'SUPPRESSED', 'FREE_MAIL', 'INDIVIDUAL_SUBSCRIBER'].includes(verdict.code)) {
    throw badRequest(verdict.reason);
  }
  if (requireEmail && !verdict.allowed) {
    throw badRequest(verdict.reason);
  }
  if (requireEmail && !looksLikeEmail(lead.email ?? '')) {
    throw badRequest(`${lead.business_name} has no usable email address`);
  }

  const rendered = renderTemplate(template, lead);
  const settings = getSettings();
  const footer = buildFooter(settings);

  // The identity block and opt-out line are not optional under PECR, so any
  // path that actually produces a sendable email refuses without them. The
  // preview path passes requireCompliance:false so the user can see the draft
  // and read why it is blocked.
  if (requireCompliance && !footer.complete) {
    const err = new Error(
      'Cannot produce a compliant email: missing ' +
      footer.missing.map((f) => f.label).join(', ') +
      '. Fill these in on the Settings screen.'
    );
    err.status = 422;
    err.details = { missing: footer.missing };
    throw err;
  }

  return {
    lead,
    verdict,
    template,
    subject: rendered.subject,
    // Body without the footer, plus the compliant body, so the UI can show both.
    body_without_footer: rendered.body,
    body: footer.complete ? withFooter(rendered.body, settings) : rendered.body,
    footer,
    warnings: [
      ...(footer.complete
        ? []
        : ['Business identity details are incomplete — the compliance footer is missing and sending is blocked. Fill them in under Settings.']),
      ...(unknownPlaceholders(template.subject, template.body).length
        ? [`Unrecognised placeholder(s): ${unknownPlaceholders(template.subject, template.body).map((u) => `{{${u}}}`).join(', ')}`]
        : []),
      ...(looksLikeEmail(lead.email ?? '') ? [] : ['This lead has no email address — you can still copy the text or phone them.']),
      ...(verdict.allowed || verdict.code === 'NO_EMAIL' ? [] : [verdict.reason]),
    ],
  };
}

/** GET /api/emails/preview?lead_id=&template_id= */
router.get('/preview', wrap((req, res) => {
  const leadId = int(req.query.lead_id);
  const templateId = int(req.query.template_id);
  if (!leadId || !templateId) throw badRequest('lead_id and template_id are required');

  const c = composeFor(leadId, templateId);
  // No draft link until the email would be both compliant and lawful to send.
  const mailto = c.footer.complete && c.verdict.allowed
    ? `mailto:${encodeURIComponent(c.lead.email)}` +
      `?subject=${encodeURIComponent(c.subject)}&body=${encodeURIComponent(c.body)}`
    : null;

  res.json({
    lead: { ...c.lead, opted_out: c.lead.opted_out === 1 },
    template: { id: c.template.id, name: c.template.name },
    subject: c.subject,
    body: c.body,
    body_without_footer: c.body_without_footer,
    footer: c.footer,
    mailto,
    can_send: c.footer.complete && c.verdict.allowed,
    compliant: c.footer.complete,
    lawful: c.verdict.allowed,
    block_code: c.verdict.allowed ? null : c.verdict.code,
    block_reason: c.verdict.reason,
    warnings: c.warnings,
  });
}));

/**
 * POST /api/emails/log — record an email the user sent by hand (mailto: draft
 * or copy-paste). Snapshots exactly what went out and advances the lead to
 * "sent". Nothing is sent by this endpoint; it is the audit trail for the
 * manual path.
 */
router.post('/log', wrap((req, res) => {
  const leadId = int(req.body.lead_id);
  const templateId = int(req.body.template_id);
  if (!leadId || !templateId) throw badRequest('lead_id and template_id are required');

  const channel = str(req.body.channel) ?? 'mailto';
  if (!['mailto', 'copy'].includes(channel)) {
    throw badRequest('channel must be "mailto" or "copy" for manually sent email');
  }

  const c = composeFor(leadId, templateId, { requireCompliance: true, requireEmail: true });
  // Trust the client's snapshot if it edited the draft, else use the render.
  const subject = str(req.body.subject) ?? c.subject;
  const body = str(req.body.body) ?? c.body;
  const to = str(req.body.to_email) ?? c.lead.email ?? '';
  const at = nowIso();

  const info = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO email_log
         (lead_id, template_id, lead_name, to_email, subject_snapshot, body_snapshot, sent_at, channel)
       VALUES (@lead_id, @template_id, @lead_name, @to_email, @subject, @body, @sent_at, @channel)`
    ).run({
      lead_id: c.lead.id, template_id: c.template.id, lead_name: c.lead.business_name,
      to_email: to, subject, body, sent_at: at, channel,
    });
    // Only advance a lead that has not already moved further down the funnel.
    db.prepare(
      `UPDATE leads SET last_contacted_at = ?,
         status = CASE WHEN status IN ('new') THEN 'sent' ELSE status END
       WHERE id = ?`
    ).run(at, c.lead.id);
    return r;
  })();

  res.status(201).json({
    entry: db.prepare('SELECT * FROM email_log WHERE id = ?').get(info.lastInsertRowid),
    lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(c.lead.id),
  });
}));

/** GET /api/emails/log — the send history. */
router.get('/log', wrap((req, res) => {
  const where = [];
  const params = { limit: Math.min(int(req.query.limit, 200), 1000), offset: int(req.query.offset, 0) };
  if (int(req.query.lead_id)) { where.push('lead_id = @lead_id'); params.lead_id = int(req.query.lead_id); }

  res.json({
    entries: db.prepare(
      `SELECT * FROM email_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY sent_at DESC, id DESC LIMIT @limit OFFSET @offset`
    ).all(params),
    total: db.prepare('SELECT COUNT(*) n FROM email_log').get().n,
  });
}));

router.get('/log/:id', wrap((req, res) => {
  const entry = db.prepare('SELECT * FROM email_log WHERE id = ?').get(req.params.id);
  if (!entry) throw notFound('Log entry not found');
  res.json({ entry });
}));

export default router;

import { Router } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import { db, getSetting } from '../db.js';
import { wrap, badRequest, notFound, conflict, nowIso, str, int, bool, looksLikeEmail } from '../lib/http.js';
import { DEFAULTS } from './settings.js';
import { composeFor } from './emails.js';
import { buildFooter, optOutMailto } from '../lib/compliance.js';
import { sendability } from '../lib/pecr.js';
import { isSuppressed } from '../lib/suppression.js';
import { scoreDraft } from '../lib/deliverability.js';
import { checkAddress } from '../lib/addresses.js';
import { capState, windowState, domainCooldown, policyState } from '../lib/sending-policy.js';
import {
  authUrl, exchangeCode, redirectUri, buildRawMessage, sendRaw, revoke,
  isConnected, connectedEmail, clientConfigured, GmailError, SCOPES,
} from '../lib/gmail.js';

const router = Router();

/** One send run at a time, so the daily cap and delay cannot be raced. */
let activeSend = null;
/** Short-lived OAuth state values, to stop a stray callback being accepted. */
const pendingStates = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Short reasons for the skip list in the UI. */
const REASONS = {
  NO_LEAD: 'no such lead',
  OPTED_OUT: 'opted out',
  SUPPRESSED: 'on the suppression list',
  NO_EMAIL: 'no email address',
  FREE_MAIL: 'personal mailbox — PECR reg 22 applies',
  INDIVIDUAL_SUBSCRIBER: 'sole trader — consent required',
  UNCLASSIFIED: 'not checked as a company yet',
};

/** Read a numeric setting, falling back to the shared default for that key. */
const settingInt = (key, fallback = Number(DEFAULTS[key])) => {
  const n = Number(getSetting(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
};

/* ------------------------------------------------------------ connection */

router.get('/status', wrap((_req, res) => {
  res.json({
    client_configured: clientConfigured(),
    connected: isConnected(),
    email: connectedEmail(),
    scopes: SCOPES,
    policy: policyState(),
    daily: capState(),
    delay_min_seconds: settingInt('send_delay_min_seconds'),
    delay_max_seconds: settingInt('send_delay_max_seconds'),
    active_send: activeSend,
    pending: db.prepare("SELECT COUNT(*) n FROM send_queue WHERE status = 'pending'").get().n,
  });
}));

router.get('/connect', wrap((req, res) => {
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  // Expire anything older than 10 minutes.
  for (const [k, t] of pendingStates) if (Date.now() - t > 600_000) pendingStates.delete(k);
  res.json({ url: authUrl(redirectUri(req), state) });
}));

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Anything from the query string is attacker-controlled — escape it. */
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESC[c]);

router.get('/callback', wrap(async (req, res) => {
  const page = (title, messageHtml, ok) => res.status(ok ? 200 : 400).send(
    `<!doctype html><meta charset="utf-8"><title>${escHtml(title)}</title>
     <body style="font-family:system-ui;max-width:34rem;margin:14vh auto;padding:0 1.5rem;
                  color:#1b2b21;background:#f4f2e9;line-height:1.6">
       <h1 style="font-family:Georgia,serif">${escHtml(title)}</h1>
       <p>${messageHtml}</p>
       <p><a href="/#/outbox" style="color:#2f6b4f">Back to Prospect Book</a></p>
     </body>`
  );

  if (req.query.error) {
    return page('Not connected', `Google returned: ${escHtml(str(req.query.error))}`, false);
  }
  const state = str(req.query.state);
  if (!state || !pendingStates.has(state)) {
    return page('Not connected', 'That sign-in link was not one this app started. Try again from the Outbox.', false);
  }
  pendingStates.delete(state);

  const code = str(req.query.code);
  if (!code) return page('Not connected', 'Google did not send an authorisation code.', false);

  try {
    const { email } = await exchangeCode(code, redirectUri(req));
    return page('Gmail connected',
      `Prospect Book can now send as <strong>${escHtml(email ?? 'your account')}</strong>.`, true);
  } catch (err) {
    return page('Not connected', escHtml(err.message), false);
  }
}));

router.post('/disconnect', wrap(async (_req, res) => {
  await revoke();
  res.json({ connected: false });
}));

/* ---------------------------------------------------------------- queue */

/**
 * POST /api/gmail/queue — stage emails for review.
 * Opted-out leads, leads with no usable address, and any lead whose email
 * would not carry a compliance footer are refused here, and again at send.
 */
router.post('/queue', wrap(async (req, res) => {
  const templateId = int(req.body.template_id);
  if (!templateId) throw badRequest('template_id is required');
  const leadIds = Array.isArray(req.body.lead_ids)
    ? req.body.lead_ids.map(Number).filter(Number.isFinite) : [];
  if (leadIds.length === 0) throw badRequest('Pick at least one lead');

  const footer = buildFooter();
  if (!footer.complete) {
    const err = new Error(
      'Your business details are incomplete, so no email can lawfully be sent. Missing: ' +
      footer.missing.map((f) => f.label).join(', ')
    );
    err.status = 422;
    throw err;
  }

  const queued = [];
  const skipped = [];

  const stage = db.transaction(() => {
    for (const leadId of leadIds) {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      if (!lead) { skipped.push({ lead_id: leadId, reason: 'no such lead' }); continue; }
      const verdict = sendability(lead, { suppressed: isSuppressed(lead.email) });
      if (!verdict.allowed) {
        skipped.push({
          lead_id: leadId, name: lead.business_name,
          reason: REASONS[verdict.code] ?? verdict.code, detail: verdict.reason,
        });
        continue;
      }
      if (!looksLikeEmail(lead.email ?? '')) {
        skipped.push({ lead_id: leadId, name: lead.business_name, reason: 'no email address' }); continue;
      }
      const already = db.prepare(
        "SELECT id FROM send_queue WHERE lead_id = ? AND status = 'pending'"
      ).get(leadId);
      if (already) {
        skipped.push({ lead_id: leadId, name: lead.business_name, reason: 'already queued' }); continue;
      }

      const c = composeFor(leadId, templateId, { requireEmail: true, requireCompliance: true });
      const info = db.prepare(
        `INSERT INTO send_queue (lead_id, template_id, to_email, subject, body, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      ).run(leadId, templateId, lead.email, c.subject, c.body, nowIso());
      queued.push({ id: Number(info.lastInsertRowid), lead, subject: c.subject, body: c.body });
    }
  });
  stage();

  // Deliverability checks run after staging so the queue reflects what was
  // asked for, and the Outbox can show exactly what is wrong with each one.
  const checked = await Promise.all(queued.map(async (q) => {
    const spam = getSetting('spam_check_enabled', '1') === '1'
      ? scoreDraft({ subject: q.subject, body: q.body }) : null;
    const address = getSetting('verify_addresses', '1') === '1'
      ? await checkAddress(q.lead.email) : null;
    const cooldown = domainCooldown(q.lead.email);

    const problems = [
      ...(spam?.blocked ? ['content'] : []),
      ...(address?.level === 'bad' ? ['address'] : []),
      ...(cooldown.ok ? [] : ['recent contact']),
    ];
    if (problems.length) {
      db.prepare('UPDATE send_queue SET error = ? WHERE id = ?')
        .run(`Held: ${problems.join(', ')}`, q.id);
    }
    return { id: q.id, spam, address, cooldown };
  }));

  res.status(201).json({
    queued: queued.length,
    skipped,
    checks: checked,
    held: checked.filter((c) => c.spam?.blocked || c.address?.level === 'bad' || !c.cooldown.ok).length,
    daily: capState(),
  });
}));

router.get('/queue', wrap((_req, res) => {
  const rows = db.prepare(`
    SELECT q.*, l.business_name, l.opted_out, l.status AS lead_status
      FROM send_queue q LEFT JOIN leads l ON l.id = q.lead_id
     ORDER BY CASE q.status WHEN 'pending' THEN 0 ELSE 1 END, q.id
  `).all().map((r) => ({ ...r, opted_out: r.opted_out === 1 }));

  res.json({
    queue: rows,
    pending: rows.filter((r) => r.status === 'pending'),
    policy: policyState(),
    daily: capState(),
    delay_min_seconds: settingInt('send_delay_min_seconds'),
    delay_max_seconds: settingInt('send_delay_max_seconds'),
    connected: isConnected(),
    email: connectedEmail(),
    active_send: activeSend,
  });
}));

router.delete('/queue/:id', wrap((req, res) => {
  const info = db.prepare("DELETE FROM send_queue WHERE id = ? AND status = 'pending'").run(req.params.id);
  if (info.changes === 0) throw notFound('No pending queue item with that id');
  res.status(204).end();
}));

router.post('/queue/clear', wrap((_req, res) => {
  const info = db.prepare("DELETE FROM send_queue WHERE status = 'pending'").run();
  res.json({ removed: info.changes });
}));

/* ----------------------------------------------------------------- send */

/**
 * The send loop. Runs one message at a time with a delay between, re-checking
 * opt-out and the daily cap immediately before each send so that neither can
 * be bypassed by a stale review screen.
 */
async function runSend(queueIds, delayMin, delayMax) {
  const settings = { footer: buildFooter(), optOut: optOutMailto() };
  const fromName = getSetting('biz_name') ?? getSetting('biz_contact_name');
  const replyTo = getSetting('biz_email');

  for (const queueId of queueIds) {
    if (activeSend?.cancelled) break;

    const item = db.prepare('SELECT * FROM send_queue WHERE id = ?').get(queueId);
    if (!item || item.status !== 'pending') continue;

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(item.lead_id);
    const fail = (reason, status = 'skipped') => {
      db.prepare('UPDATE send_queue SET status = ?, error = ? WHERE id = ?').run(status, reason, queueId);
      activeSend.skipped++;
      activeSend.done++;
    };

    // Re-check every guard at the last possible moment, so an opt-out or a
    // reclassification between review and send is honoured.
    if (!lead) { fail('lead was deleted'); continue; }
    const verdict = sendability(lead, { suppressed: isSuppressed(item.to_email) });
    if (!verdict.allowed) { fail(verdict.reason); continue; }
    if (!looksLikeEmail(item.to_email)) { fail('no usable email address'); continue; }
    if (!settings.footer.complete) { fail('business identity details are incomplete'); continue; }

    const { remaining } = capState();
    if (remaining <= 0) {
      // Stop without touching this item: it stays pending for tomorrow rather
      // than being consumed as a skip.
      activeSend.stopped_reason = 'Daily cap reached — everything left is still queued.';
      break;
    }

    let sent = null;
    try {
      const raw = buildRawMessage({
        to: item.to_email,
        from: connectedEmail() ?? undefined,
        fromName,
        replyTo,
        subject: item.subject,
        body: item.body,
        // Off below bulk volumes: the header makes Gmail draw an
        // "Unsubscribe" chip, which files the message as a campaign. The
        // opt-out line in the body does the same job and earns a reply.
        listUnsubscribe: getSetting('list_unsubscribe_enabled', '0') === '1'
          ? settings.optOut : null,
      });
      sent = await sendRaw(raw);
    } catch (err) {
      db.prepare("UPDATE send_queue SET status = 'failed', error = ? WHERE id = ?")
        .run(err.message, queueId);
      activeSend.failed++;
      activeSend.done++;
      // A rejected token or an exhausted daily allowance will not fix itself.
      if (err instanceof GmailError && ['REAUTH_NEEDED', 'DAILY_LIMIT', 'NOT_CONNECTED'].includes(err.code)) {
        activeSend.stopped_reason = err.message;
        break;
      }
      if (delayMax > 0 && !activeSend?.cancelled) {
        const wait = delayMin + Math.random() * (delayMax - delayMin);
        await sleep(Math.round(wait * 1000));
      }
      continue;
    }

    // The message has left. Bookkeeping must not be able to turn a delivered
    // email into a "failed" one, so it is outside the send's catch.
    try {
      const at = nowIso();
      db.transaction(() => {
        db.prepare(
          `UPDATE send_queue SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?`
        ).run(at, queueId);
        db.prepare(
          `INSERT INTO email_log
             (lead_id, template_id, lead_name, to_email, subject_snapshot, body_snapshot,
              sent_at, channel, provider_message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'gmail', ?)`
        ).run(lead.id, item.template_id, lead.business_name, item.to_email,
              item.subject, item.body, at, sent.id);
        db.prepare(
          `UPDATE leads SET last_contacted_at = ?,
             status = CASE WHEN status = 'new' THEN 'sent' ELSE status END
           WHERE id = ?`
        ).run(at, lead.id);
      })();

      activeSend.sent++;
      activeSend.done++;
    } catch (err) {
      // Record it as sent regardless -- it was -- and surface the bookkeeping
      // failure rather than losing the fact of the send.
      console.error('[gmail] send succeeded but logging failed:', err);
      db.prepare("UPDATE send_queue SET status = 'sent', sent_at = ?, error = ? WHERE id = ?")
        .run(nowIso(), `sent, but logging failed: ${err.message}`, queueId);
      activeSend.sent++;
      activeSend.done++;
    }

    // A randomised gap, never a fixed interval: an exact cadence is the
    // clearest signal that a program rather than a person is sending.
    if (delayMax > 0 && !activeSend?.cancelled) {
      const wait = delayMin + Math.random() * (delayMax - delayMin);
      await sleep(Math.round(wait * 1000));
    }
  }

  if (activeSend) {
    activeSend.finished_at = nowIso();
    activeSend.running = false;
    const finished = activeSend;
    // Keep the result visible briefly so the UI can show the outcome.
    setTimeout(() => { if (activeSend === finished) activeSend = null; }, 60_000);
  }
}

/**
 * POST /api/gmail/send — the one explicit confirmation.
 * `confirm` must be true and `expected_count` must match what the review
 * screen showed, so a stale page can never send more than was reviewed.
 */
router.post('/send', wrap((req, res) => {
  if (!isConnected()) throw new GmailError('Connect your Gmail account first.', { status: 401, code: 'NOT_CONNECTED' });
  if (activeSend?.running) throw conflict('A send is already running.');
  if (!bool(req.body.confirm)) throw badRequest('Sending requires explicit confirmation.');

  const requested = Array.isArray(req.body.queue_ids)
    ? req.body.queue_ids.map(Number).filter(Number.isFinite) : null;

  const pending = db.prepare("SELECT id FROM send_queue WHERE status = 'pending' ORDER BY id")
    .all().map((r) => r.id);
  const ids = requested ? pending.filter((id) => requested.includes(id)) : pending;
  if (ids.length === 0) throw badRequest('Nothing pending to send.');

  const expected = int(req.body.expected_count);
  if (expected !== null && expected !== ids.length) {
    throw conflict(
      `The queue changed since you reviewed it — you confirmed ${expected} email(s) but ` +
      `${ids.length} are pending now. Review again before sending.`
    );
  }

  const win = windowState();
  if (!win.open) {
    throw badRequest(
      `${win.reason} Mail arriving outside working hours reads as automated. ` +
      'Change the window under Settings if you mean to send now.'
    );
  }

  const { cap, used, remaining, limited_by_warmup, warmup } = capState();
  if (remaining <= 0) {
    throw badRequest(
      limited_by_warmup
        ? `Warm-up limit of ${cap} reached for today (day ${warmup.day} of sending). ` +
          'It rises each week. Raising it now is the fastest way to get an account flagged.'
        : `Daily cap of ${cap} reached (${used} sent today). Try again tomorrow, or raise the cap in Settings.`
    );
  }

  const toSend = ids.slice(0, remaining);
  const delayMin = settingInt('send_delay_min_seconds');
  const delayMax = Math.max(settingInt('send_delay_max_seconds'), delayMin);

  activeSend = {
    id: randomUUID(),
    running: true,
    cancelled: false,
    total: toSend.length,
    done: 0, sent: 0, failed: 0, skipped: 0,
    delay_min_seconds: delayMin,
    delay_max_seconds: delayMax,
    started_at: nowIso(),
    stopped_reason: toSend.length < ids.length
      ? `Only ${toSend.length} of ${ids.length} will go today — the daily cap allows ${remaining} more.`
      : null,
  };

  runSend(toSend, delayMin, delayMax);

  res.status(202).json({ run: activeSend, will_send: toSend.length, queued_total: ids.length });
}));

router.get('/send/status', wrap((_req, res) => {
  res.json({
    active_send: activeSend,
    daily: capState(),
    recent: db.prepare(`
      SELECT q.*, l.business_name FROM send_queue q LEFT JOIN leads l ON l.id = q.lead_id
       WHERE q.status != 'pending' ORDER BY q.id DESC LIMIT 50
    `).all(),
  });
}));

router.post('/send/cancel', wrap((_req, res) => {
  if (!activeSend?.running) throw badRequest('Nothing is sending.');
  activeSend.cancelled = true;
  res.json({ cancelling: true });
}));

export default router;

/**
 * Finding out what actually happened to the messages Resend accepted.
 *
 * Resend's POST /emails returns 200 the moment the message is queued, not when
 * it lands. Everything the tool knew before that point stopped there: a 200
 * became a "sent" row and every failure afterwards — a hard bounce, a spam
 * complaint, a receiving-server block — was invisible. On a brand-new domain
 * that gap is not an inconvenience, it is how a reputation collapse becomes
 * unrecoverable.
 *
 * This module closes it by polling Resend for each unresolved send's last
 * event, writing the outcome back into email_log, and — the part that changes
 * future behaviour — adding a bouncing or complaining address to the
 * suppression list at once, so a broken address is a one-time cost and not a
 * recurring one. server/index.js runs it from the same 5-minute scheduler as
 * the daily hunt, and it is safe to invoke often: the SQL below only pulls
 * rows still in flight, and each GET /emails/{id} is a free lookup.
 *
 * The classification is DELIBERATELY BLUNT. There is no hard/soft split and
 * no three-strikes rule. This is one-shot cold outreach: the only thing
 * suppression forbids is a SECOND cold email to a mailbox that just rejected
 * the first, which is never wanted. A mailbox that was merely full and gets
 * suppressed costs one prospect — a cheaper mistake than the alternative.
 */
import { db } from '../db.js';
import { getEmail, ResendError } from './resend.js';
import { suppress } from './suppression.js';

/** Look at nothing older than this — Resend does not keep events forever. */
const LOOKBACK_HOURS = 72;
/** Room to breathe under Resend's 2 req/s ceiling. */
const REQUEST_GAP_MS = 500;
/** One sweep never spends more than this. */
const MAX_PER_SWEEP = 40;

/** Events that mean "the message got where it was going, no more to check". */
const TERMINAL = new Set(['delivered', 'bounced', 'complained', 'unknown', 'canceled']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/**
 * The rows whose outcome we do not yet know. A row is a candidate while
 *
 *   - it went through Resend (we can look it up)
 *   - it left within the lookback window (Resend still has it)
 *   - its state is not yet terminal — including NULL, because the very first
 *     sweep after a send has never been polled at all
 */
const pendingQuery = () => db.prepare(`
  SELECT id, lead_id, lead_name, to_email, provider_message_id
    FROM email_log
   WHERE provider = 'resend'
     AND provider_message_id IS NOT NULL
     AND sent_at >= datetime('now', ?)
     AND (delivery_state IS NULL
          OR delivery_state IN ('queued', 'sent', 'delivery_delayed'))
   ORDER BY sent_at DESC
   LIMIT ?
`);

const writeState = db.prepare(
  `UPDATE email_log SET delivery_state = ?, delivery_checked_at = ? WHERE id = ?`
);

/**
 * Poll Resend for every unresolved send in the window and write the outcome
 * back. Returns a small summary the scheduler can log.
 *
 * A bounce or a complaint is treated as a request never to write again:
 * the address goes onto the suppression list, and a complaint also marks
 * the lead opted-out, which is an absolute block in server/lib/pecr.js.
 *
 * Only the address is suppressed. Suppressing a whole domain on one junk mark
 * from one mailbox in, say, a 40-person firm would treat one person's
 * annoyance as the company's decision, and suppress() has no expiry, so a
 * domain-wide entry is permanent.
 */
export async function reconcile({ limit = MAX_PER_SWEEP } = {}) {
  const rows = pendingQuery().all(`-${LOOKBACK_HOURS} hours`, limit);
  const summary = { checked: 0, delivered: 0, bounced: 0, complained: 0,
    delayed: 0, unknown: 0, errors: 0 };

  for (const row of rows) {
    try {
      const { last_event } = await getEmail(row.provider_message_id);
      writeState.run(last_event, nowIso(), row.id);
      summary.checked++;

      switch (last_event) {
        case 'delivered':   summary.delivered++; break;
        case 'delivery_delayed': summary.delayed++; break;
        case 'unknown':     summary.unknown++; break;
        case 'bounced':
          summary.bounced++;
          suppress(row.to_email, {
            businessName: row.lead_name,
            reason: 'bounced — the mailbox rejected it',
          });
          break;
        case 'complained':
          summary.complained++;
          suppress(row.to_email, {
            businessName: row.lead_name,
            reason: 'marked the email as spam',
          });
          if (row.lead_id) {
            db.prepare('UPDATE leads SET opted_out = 1 WHERE id = ?').run(row.lead_id);
          }
          break;
        default:
          // 'queued', 'sent', or anything Resend adds later — we wrote the
          // string, we will look again next sweep. If it never turns
          // terminal within the lookback window it drops out on its own.
          break;
      }
    } catch (err) {
      summary.errors++;
      if (err instanceof ResendError && err.code === 'RATE_LIMITED') break;
      // Any other single-row failure is not worth aborting the sweep for.
    }
    if (rows.length > 1) await sleep(REQUEST_GAP_MS);
  }

  return summary;
}

/**
 * How much bad news the sending domain has had in the last week — the
 * feedback that decides whether to keep sending.
 *
 * Only outcomes that are certain count. 'unknown' does not: it is what a 404
 * on GET /emails/{id} returns, i.e. Resend has forgotten a message we cannot
 * confirm was bad, and treating that as a complaint would halt sending every
 * time Resend's retention window rolled over.
 */
export function feedbackState({ windowDays = 7 } = {}) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN delivery_state = 'bounced'    THEN 1 ELSE 0 END) AS bounced,
      SUM(CASE WHEN delivery_state = 'complained' THEN 1 ELSE 0 END) AS complained,
      COUNT(*) AS sent
      FROM email_log
     WHERE provider = 'resend'
       AND sent_at >= datetime('now', ?)
  `).get(`-${windowDays} days`);
  return {
    bounced: Number(row?.bounced ?? 0),
    complained: Number(row?.complained ?? 0),
    sent: Number(row?.sent ?? 0),
    window_days: windowDays,
  };
}

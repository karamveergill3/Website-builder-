/**
 * When it is sensible to send, and how much.
 *
 * The 500/day Gmail limit was never the constraint that mattered. What gets a
 * mailbox throttled or suspended is a pattern that looks automated: a standing
 * start at full volume, an exact cadence, mail at three in the morning,
 * several messages to the same company in a week. These rules exist to make
 * the sending look like a person working through a list, because at this
 * volume that is the whole of the defence.
 *
 * Two things now decide the cap instead of one. The WARM-UP ramp is a
 * time-since-first-send climb from a low ceiling, so a new domain does not
 * open at 25/day. The FEEDBACK HALT stops sending outright when the domain
 * has been telling us — via bounces the reconciler polls back — that
 * something is already going wrong. Both are enforced by capState.
 *
 * Every figure here is a judgement call, not a published number. The
 * reasoning is in docs/DELIVERABILITY.md.
 */
import { db, getSetting } from '../db.js';
import { feedbackState } from './delivery.js';

/**
 * Days-since-first-send to the most this tool will send that day. A new
 * mailbox that opens at 25/day reads as a bulk tool; one that climbs over a
 * fortnight reads as a person whose workload grew.
 */
export const WARMUP = [
  { fromDay: 0,  cap: 5 },
  { fromDay: 7,  cap: 10 },
  { fromDay: 14, cap: 15 },
  { fromDay: 21, cap: 20 },
  { fromDay: 28, cap: null },   // null = the user's own cap applies
];

const num = (key, fallback) => {
  const n = Number(getSetting(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
};
const flag = (key, fallback) => {
  const v = getSetting(key, fallback ? '1' : '0');
  return v === '1' || v === 'true';
};

/**
 * The domain the tool sends FROM right now — the answer to "whose reputation
 * am I building?". Everything that anchors on domain history (the warm-up
 * ramp, the sent-today counter) reads this rather than the email_log's
 * channel column, because the channel column carries backend identity ('gmail'
 * vs 'resend') and moving backends never restarts a reputation, but moving
 * DOMAINS always does.
 */
export function sendingDomain() {
  const addr = String(getSetting('biz_email') ?? '').trim().toLowerCase();
  return addr.includes('@') ? addr.split('@')[1] : null;
}

/**
 * The earliest send on record from the current domain. Rows without a
 * from_domain — everything before migration 044 — never match, which is the
 * point: switching domains restarts the ramp at day 0 for the new one
 * rather than reading a decade of Gmail history as "already warmed up".
 */
export function firstSendAt() {
  const domain = sendingDomain();
  if (!domain) return null;
  const row = db.prepare(
    "SELECT MIN(sent_at) AS at FROM email_log WHERE from_domain = ?"
  ).get(domain);
  return row?.at ?? null;
}

export function warmupState(now = new Date()) {
  if (!flag('warmup_enabled', true)) {
    return { active: false, day: null, cap: null };
  }
  const first = firstSendAt();
  if (!first) return { active: true, day: 0, cap: WARMUP[0].cap };

  const day = Math.floor((now - new Date(first)) / 86_400_000);
  const band = [...WARMUP].reverse().find((b) => day >= b.fromDay) ?? WARMUP[0];
  return { active: band.cap !== null, day, cap: band.cap };
}

/**
 * Sends today from the current sending domain. Any channel counts: the daily
 * cap is a reputation limit and a message copied out of the Outbox and sent
 * from the same mailbox by hand uses the same reputation. The channel filter
 * that used to be here was a Gmail-era leftover.
 */
export function sentToday(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const domain = sendingDomain();
  return db.prepare(
    `SELECT COUNT(*) n FROM email_log
      WHERE sent_at >= ?
        AND (from_domain = ? OR from_domain IS NULL)`
  ).get(start.toISOString(), domain ?? '').n;
}

/**
 * Is sending halted because of bad news the reconciler has brought back?
 *
 * The rule is simple by design: any complaint at all, or hard bounces at or
 * above `bounce_block_count` (default 3) inside the last 7 days. One settings
 * key — `delivery_ack_at` — clears it, but only for events that arrived
 * before that timestamp; a bounce after the ack re-arms it. So "resume
 * sending" is one radio button on the deliverability screen, and it does not
 * hide the next new problem.
 */
export function feedbackHalt() {
  const fb = feedbackState({ windowDays: 7 });
  const limit = num('bounce_block_count', 3);

  const ackAt = String(getSetting('delivery_ack_at', '') ?? '').trim();
  const newSince = ackAt
    ? db.prepare(
        `SELECT COUNT(*) n FROM email_log
          WHERE provider = 'resend'
            AND (delivery_state = 'bounced' OR delivery_state = 'complained')
            AND (delivery_checked_at > ? OR sent_at > ?)
            AND sent_at >= datetime('now', '-7 days')`
      ).get(ackAt, ackAt).n
    : (fb.bounced + fb.complained);

  if (newSince === 0) return { halted: false, ...fb, limit };

  if (fb.complained > 0) {
    return { halted: true, reason: 'A recipient marked one of your emails as spam. '
      + 'Sending is paused — check who, why, and clear the alert on the '
      + 'Deliverability screen.', ...fb, limit };
  }
  if (fb.bounced >= limit) {
    return { halted: true, reason: `${fb.bounced} hard bounces in the last week — `
      + 'sending is paused. Check where the addresses came from, then clear '
      + 'the alert on the Deliverability screen.', ...fb, limit };
  }
  return { halted: false, ...fb, limit };
}

/**
 * The effective cap: the LOWEST of the user's setting, the warm-up band, and
 * zero if the feedback halt is on. Anything that reads capState() sees a cap
 * of 0 when the halt is active, so every gate in the send path refuses
 * without needing to know about the halt itself.
 */
export function capState(now = new Date()) {
  const userCap = num('daily_cap', 25);
  const warm = warmupState(now);
  const halt = feedbackHalt();

  const rawCap = warm.cap === null ? userCap : Math.min(userCap, warm.cap);
  const cap = halt.halted ? 0 : rawCap;
  const used = sentToday(now);

  return {
    cap, used, remaining: Math.max(cap - used, 0),
    user_cap: userCap,
    warmup: warm,
    halt,
    limited_by_warmup: warm.cap !== null && warm.cap < userCap,
    limited_by_halt: halt.halted,
  };
}

/**
 * Whether now is inside the sending window. A cold commercial email arriving
 * at 3am reads as automated to the recipient as much as to the filter.
 */
export function windowState(now = new Date()) {
  if (!flag('window_enabled', true)) return { open: true, enforced: false };

  const startH = num('window_start_hour', 9);
  const endH = num('window_end_hour', 17);
  const weekdaysOnly = flag('window_weekdays_only', true);

  const day = now.getDay();               // 0 Sun … 6 Sat
  const hour = now.getHours() + now.getMinutes() / 60;

  if (weekdaysOnly && (day === 0 || day === 6)) {
    return { open: false, enforced: true, reason: 'Weekend — sending resumes Monday.', startH, endH };
  }
  if (hour < startH || hour >= endH) {
    return {
      open: false, enforced: true, startH, endH,
      reason: `Outside the sending window (${startH}:00–${endH}:00).`,
    };
  }
  return { open: true, enforced: true, startH, endH };
}

/**
 * Don't write to the same company twice in quick succession. Two emails to
 * different people at one domain in a week is how a complaint gets made.
 *
 * Any channel counts — a hand-sent email a fortnight ago is a live memory in
 * the recipient's inbox, and a second cold approach to the same domain does
 * not become new information just because we sent this one through a
 * different backend.
 */
export function domainCooldown(email, now = new Date()) {
  const days = num('domain_cooldown_days', 14);
  if (days <= 0) return { ok: true };

  const domain = String(email ?? '').toLowerCase().split('@')[1];
  if (!domain) return { ok: true };

  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const row = db.prepare(
    `SELECT to_email, sent_at FROM email_log
      WHERE sent_at >= ? AND lower(to_email) LIKE ?
      ORDER BY sent_at DESC LIMIT 1`
  ).get(since, `%@${domain}`);

  if (!row) return { ok: true, domain };
  return {
    ok: false, domain, days, last: row.sent_at,
    reason: `You wrote to ${row.to_email} within the last ${days} days.`,
  };
}

/** Everything the Outbox needs to explain what will and won't go out. */
export function policyState(now = new Date()) {
  return {
    daily: capState(now),
    window: windowState(now),
    domain_cooldown_days: num('domain_cooldown_days', 14),
    delay_min_seconds: num('send_delay_min_seconds', 120),
    delay_max_seconds: num('send_delay_max_seconds', 420),
    first_send_at: firstSendAt(),
    sending_domain: sendingDomain(),
  };
}

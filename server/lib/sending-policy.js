/**
 * When it is sensible to send, and how much.
 *
 * The 500/day Gmail limit is not the constraint that matters. What gets a
 * personal account throttled or suspended is a pattern that looks automated:
 * a standing start at full volume, an exact cadence, mail at three in the
 * morning, several messages to the same company in a week. These rules exist
 * to make the sending look like a person working through a list, because at
 * this volume that is the whole of the defence.
 *
 * Every figure here is a judgement call, not a published Google number.
 * The reasoning is in docs/DELIVERABILITY.md.
 */
import { db, getSetting } from '../db.js';

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

/** The first Gmail send on record, which anchors the ramp. */
export function firstSendAt() {
  const row = db.prepare(
    "SELECT MIN(sent_at) AS at FROM email_log WHERE channel = 'gmail'"
  ).get();
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

/** Gmail sends since local midnight. */
export function sentToday(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return db.prepare(
    "SELECT COUNT(*) n FROM email_log WHERE channel = 'gmail' AND sent_at >= ?"
  ).get(start.toISOString()).n;
}

/** The effective cap: the lower of the user's setting and the warm-up band. */
export function capState(now = new Date()) {
  const userCap = num('daily_cap', 25);
  const warm = warmupState(now);
  const cap = warm.cap === null ? userCap : Math.min(userCap, warm.cap);
  const used = sentToday(now);
  return {
    cap, used, remaining: Math.max(cap - used, 0),
    user_cap: userCap,
    warmup: warm,
    limited_by_warmup: warm.cap !== null && warm.cap < userCap,
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
 */
export function domainCooldown(email, now = new Date()) {
  const days = num('domain_cooldown_days', 14);
  if (days <= 0) return { ok: true };

  const domain = String(email ?? '').toLowerCase().split('@')[1];
  if (!domain) return { ok: true };

  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const row = db.prepare(
    `SELECT to_email, sent_at FROM email_log
      WHERE channel = 'gmail' AND sent_at >= ? AND lower(to_email) LIKE ?
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
  };
}

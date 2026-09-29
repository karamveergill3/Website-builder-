/**
 * WhatsApp follow-ups: who is due one, and what it says.
 *
 * Someone messaged on WhatsApp who hasn't answered is due a follow-up a few
 * days after the last message (3 by default, Settings), up to a set number of
 * times (2 by default). The first follow-up carries a mock up of their own
 * site, built from what we know of them, rather than another offer to make
 * one; the next checks they saw it. After that they are left alone.
 *
 * Nothing here sends. The site only ever opens WhatsApp with the text typed
 * in; a follow-up is a reminder on the WhatsApp screen and a message ready to
 * go, and the rep sends it.
 *
 * "Due" is worked out when asked, from the send record, the way a call-back
 * is: no job has to run for a reminder to appear, and nothing can go stale.
 * A reply, an opt-out, a "we've got a site" or a lost lead stops them, since
 * each moves the lead off 'sent'.
 */
import { db, getSetting } from '../db.js';
import { STARTERS } from './starters.js';

const DAY = 86_400_000;

/** The Settings: every how many days, and how many at most (0 turns them off). */
export function followUpRules() {
  const days = Number(getSetting('followup_days', '3'));
  const max = Number(getSetting('followup_max', '2'));
  return {
    days: Number.isFinite(days) && days >= 1 ? days : 3,
    max: Number.isFinite(max) && max >= 0 ? Math.floor(max) : 2,
  };
}

/** Still waiting on an answer, and nothing says to leave them be. */
const waiting = (lead) => lead.status === 'sent'
  && !(lead.opted_out === 1 || lead.opted_out === true)
  && lead.has_website !== 1;

/**
 * Where one lead stands, from its last WhatsApp and how many follow-ups it
 * has had. `state` is one of:
 *   due       a follow-up is due now
 *   waiting   one will be, on `at`
 *   done      it has had as many as Settings allows
 *   off       not waiting on them (they replied, were won or lost, opted
 *             out, have a site), or follow-ups are turned off
 * Null when nothing has gone to them on WhatsApp.
 */
export function followUpState(lead, history, { now = new Date(), rules = followUpRules() } = {}) {
  if (!history?.last_at) return null;
  const sent = Number(history.follow_ups ?? 0);
  const left = Math.max(0, rules.max - sent);
  const at = new Date(Date.parse(history.last_at) + rules.days * DAY).toISOString();
  let state;
  if (!waiting(lead) || rules.max === 0) state = 'off';
  else if (left === 0) state = 'done';
  else state = at <= now.toISOString() ? 'due' : 'waiting';
  return {
    state,
    due: state === 'due',
    at: state === 'due' || state === 'waiting' ? at : null,
    sent,
    left,
    step: sent + 1,
    last_at: history.last_at,
  };
}

/** A lead's WhatsApp sends in one query: the latest, and how many were follow-ups. */
export function whatsAppHistory(leadId) {
  return db.prepare(
    `SELECT MAX(confirmed_sent_at) AS last_at,
            SUM(CASE WHEN kind = 'follow_up' THEN 1 ELSE 0 END) AS follow_ups
       FROM outreach_events
      WHERE lead_id = ? AND channel = 'whatsapp' AND confirmed_sent_at IS NOT NULL`
  ).get(leadId);
}

/** followUpState for one lead, reading its history. */
export function followUpFor(lead, opts) {
  return followUpState(lead, whatsAppHistory(lead.id), opts);
}

/**
 * Every lead with a follow-up due now, in one query: [{ id, assigned_to, at }].
 * For the count on the WhatsApp screen and its tab.
 */
export function dueFollowUps({ now = new Date(), rules = followUpRules() } = {}) {
  if (rules.max === 0) return [];
  const rows = db.prepare(
    `SELECT l.id, l.assigned_to, l.status, l.opted_out, l.has_website,
            MAX(oe.confirmed_sent_at) AS last_at,
            SUM(CASE WHEN oe.kind = 'follow_up' THEN 1 ELSE 0 END) AS follow_ups
       FROM leads l
       JOIN outreach_events oe
         ON oe.lead_id = l.id AND oe.channel = 'whatsapp' AND oe.confirmed_sent_at IS NOT NULL
      WHERE l.status = 'sent' AND l.opted_out = 0 AND COALESCE(l.has_website, 0) != 1
      GROUP BY l.id`
  ).all();
  return rows
    .map((r) => ({ r, f: followUpState(r, r, { now, rules }) }))
    .filter(({ f }) => f?.due)
    .map(({ r, f }) => ({ id: r.id, assigned_to: r.assigned_to ?? null, at: f.at }));
}

/** Why a follow-up can't go now, in words for the rep. */
export function notDueReason(f) {
  if (!f) return 'Nothing has gone to them on WhatsApp yet, so there is nothing to follow up.';
  if (f.state === 'done') {
    return `They've had ${f.sent} follow-up${f.sent === 1 ? '' : 's'} already, the most Settings allows.`;
  }
  if (f.state === 'waiting') {
    const day = new Date(f.at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    return `Their next follow-up is due on ${day}.`;
  }
  return 'They have replied, or are marked won, lost or not to be contacted, so no follow-up is due.';
}

/** The follow-up templates, first and later, as shipped (lib/starters.js). */
export const FOLLOW_UP_NAMES = ['Follow-up — WhatsApp', 'Follow-up 2 — WhatsApp'];

/**
 * The template for follow-up number `step`: the first shows them the mock
 * up, every later one checks they saw it. The saved copy (so wording edited
 * on the Templates screen is used), else the shipped one if it was deleted.
 */
export function followUpTemplate(step) {
  const names = step <= 1 ? [FOLLOW_UP_NAMES[0]] : [FOLLOW_UP_NAMES[1], FOLLOW_UP_NAMES[0]];
  for (const name of names) {
    const saved = db.prepare(
      "SELECT * FROM templates WHERE name = ? AND channel = 'whatsapp'"
    ).get(name);
    if (saved) return saved;
  }
  return STARTERS.find((s) => s.name === names[0]);
}

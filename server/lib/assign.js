/**
 * Sharing the daily hunt out across the team.
 *
 * Each rep gets their own share of the day's finds (e.g. 5 each of a 15/day
 * target). Rather than a rigid rota — which would dump leads on whoever is on
 * holiday — the next find goes to whichever active rep is holding the FEWEST
 * un-worked ('new') leads right now, ties broken by lowest id so the order is
 * stable. On an empty board that deals evenly, 5/5/5; as reps clear their new
 * leads it keeps topping up whoever is emptiest, so nobody drowns and nobody
 * starves.
 */
import { db } from '../db.js';

/** Active users eligible to receive leads, lowest id first. */
export function rotationUserIds() {
  return db.prepare('SELECT id FROM users WHERE active = 1 ORDER BY id')
    .all().map((r) => r.id);
}

/** How many un-worked ('new') leads each active rep currently holds. */
export function newLeadCounts() {
  const counts = new Map(rotationUserIds().map((id) => [id, 0]));
  for (const row of db.prepare(
    `SELECT assigned_to AS id, COUNT(*) AS n FROM leads
      WHERE status = 'new' AND assigned_to IS NOT NULL GROUP BY assigned_to`
  ).all()) {
    if (counts.has(row.id)) counts.set(row.id, row.n);
  }
  return counts;
}

/**
 * The rep who should get the next auto-found lead — the active rep with the
 * fewest un-worked leads. Returns null when there are no active users, so the
 * lead is simply filed unassigned rather than the hunt failing.
 */
export function nextAssignee() {
  const counts = newLeadCounts();
  let best = null;
  let bestN = Infinity;
  for (const [id, n] of counts) {
    if (n < bestN) { bestN = n; best = id; }
  }
  return best;
}

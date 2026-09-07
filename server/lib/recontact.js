/**
 * One business, one approach.
 *
 * The tool finds twenty-odd prospects a day and offers four ways to contact
 * each of them. Without a memory that outlives the lead row, the same roofer
 * gets found on Monday, emailed on Tuesday, WhatsApped on Wednesday by a user
 * who has forgotten, and found again on Thursday because the lead was
 * deleted in between. To the roofer that is not four channels — it is one
 * firm that will not leave him alone, and it is the fastest way to earn a
 * complaint under PECR reg 22 and lose the mailbox.
 *
 * So contact is recorded against the COMPANY, not the lead:
 *
 *   - company_ledger survives DELETE FROM leads, the way suppression_list
 *     does. Deleting a lead is how you say "not interested in this one",
 *     which is the opposite of "show it to me again tomorrow".
 *   - The key is the company number where we hold one, because that is the
 *     only identifier that is actually stable. Two lead rows for one real
 *     business — one from a Places import, one from the register — share a
 *     key and therefore share a contact history.
 *
 * What this deliberately does NOT block: a reply. Once a prospect has written
 * back the conversation is theirs as much as ours, and refusing to let the
 * owner answer would be absurd. The block is on repeating a COLD approach.
 */
import { db } from '../db.js';
import { nowIso } from './http.js';
import { normaliseName } from './companies-house.js';

/** Statuses that mean the prospect engaged, so further contact is a reply. */
export const IN_CONVERSATION = ['replied', 'won'];

/**
 * A stable identity for a business.
 *
 * A company number is the only identifier that survives a rename, a change of
 * trading name and a second import, so it wins whenever we hold one. The
 * fallback is a normalised name plus town, which is weaker — two genuinely
 * different firms called "Ace Plumbing" in one town would collide — but the
 * failure is that one of them does not get contacted, which is far cheaper
 * than contacting the same one twice.
 *
 * Returns null when there is not enough to identify anything, and a caller
 * that gets null must not treat it as "never contacted": see ledgerFor().
 */
export function companyKey(lead = {}) {
  const number = String(lead.company_number ?? '').trim().toUpperCase();
  if (number) return `ch:${number}`;
  return nameKey(lead);
}

/**
 * The weaker key: normalised trading name plus town.
 *
 * Every row carries this as well as its primary key, because the two funnels
 * know different things. The register gives a company number and a registered
 * name; Places gives a trading name and a town and never learns a number.
 * Keyed on one alone the two are blind to each other, and the same business
 * arrives down both as two independently contactable leads.
 */
export function nameKey(lead = {}) {
  const name = normaliseName(lead.business_name ?? lead.registered_name ?? '');
  if (!name) return null;
  return `nm:${name}|${normaliseName(lead.location ?? '')}`;
}

/**
 * The ledger row for a lead, by either key.
 *
 * The number is tried first because it is the identifier that actually
 * survives a rename. The name key is the fallback, and it is what lets a
 * Places import recognise a company the register filed last week.
 */
export function ledgerFor(lead) {
  const key = companyKey(lead);
  if (key) {
    const hit = db.prepare('SELECT * FROM company_ledger WHERE company_key = ?').get(key);
    if (hit) return hit;
  }

  const nk = nameKey(lead);
  if (!nk) return null;

  // The name key is a guess, so it must not overrule the register. Two firms
  // can share a normalised name in one town — "Ace Plumbing" twice over — and
  // if both carry company numbers and the numbers differ, Companies House has
  // already told us they are different companies. Letting the weaker key win
  // there would silently drop a legitimate prospect and never say why.
  const mine = String(lead.company_number ?? '').trim().toUpperCase();
  const rows = db.prepare(
    'SELECT * FROM company_ledger WHERE name_key = ? ORDER BY contacted_at DESC'
  ).all(nk);
  for (const row of rows) {
    const theirs = String(row.company_number ?? '').trim().toUpperCase();
    if (mine && theirs && mine !== theirs) continue;
    return row;
  }
  return null;
}

/**
 * File a company as found. Idempotent: a company already in the ledger keeps
 * its original found_at and, importantly, its contact history.
 */
export function recordFound(lead) {
  const key = companyKey(lead);
  if (!key) return null;

  // A row already reachable by the other key is the same company. Filling in
  // what it was missing is right; a second row for it is exactly the split
  // identity this table exists to close.
  const existing = ledgerFor(lead);
  if (existing) {
    db.prepare(
      `UPDATE company_ledger SET
         company_number = COALESCE(company_number, @number),
         business_name  = COALESCE(business_name, @name),
         location       = COALESCE(location, @town),
         name_key       = COALESCE(name_key, @nk)
       WHERE company_key = @existing`
    ).run({
      number: lead.company_number ?? null,
      name: lead.business_name ?? null,
      town: lead.location ?? null,
      nk: nameKey(lead),
      existing: existing.company_key,
    });
    return existing.company_key;
  }

  db.prepare(
    `INSERT INTO company_ledger
       (company_key, company_number, business_name, location, found_at, name_key)
     VALUES (@key, @number, @name, @town, @now, @nk)
     ON CONFLICT(company_key) DO UPDATE SET
       company_number = COALESCE(company_ledger.company_number, excluded.company_number),
       business_name  = COALESCE(company_ledger.business_name, excluded.business_name),
       location       = COALESCE(company_ledger.location, excluded.location),
       name_key       = COALESCE(company_ledger.name_key, excluded.name_key)`
  ).run({
    key,
    number: lead.company_number ?? null,
    name: lead.business_name ?? null,
    town: lead.location ?? null,
    nk: nameKey(lead),
    now: nowIso(),
  });
  return key;
}

/**
 * File a company as contacted, on a named channel.
 *
 * Called from every path that stamps leads.last_contacted_at, so the ledger
 * cannot drift from the lead. The INSERT half covers a lead contacted before
 * it was ever filed as found — a hand-entered one, say.
 */
export function recordContact(lead, channel, at = nowIso()) {
  const key = companyKey(lead);
  if (!key) return null;

  // Same rule as recordFound: stamp the row we already have, whichever key
  // found it, rather than opening a second history for one business.
  const existing = ledgerFor(lead);
  if (existing) {
    db.prepare(
      `UPDATE company_ledger SET
         contacted_at    = @at,
         last_channel    = @channel,
         times_contacted = times_contacted + 1,
         company_number  = COALESCE(company_number, @number),
         business_name   = COALESCE(business_name, @name),
         name_key        = COALESCE(name_key, @nk)
       WHERE company_key = @existing`
    ).run({
      at,
      channel: channel ?? null,
      number: lead.company_number ?? null,
      name: lead.business_name ?? null,
      nk: nameKey(lead),
      existing: existing.company_key,
    });
    return existing.company_key;
  }

  db.prepare(
    `INSERT INTO company_ledger
       (company_key, company_number, business_name, location,
        found_at, contacted_at, last_channel, times_contacted, name_key)
     VALUES (@key, @number, @name, @town, @at, @at, @channel, 1, @nk)
     ON CONFLICT(company_key) DO UPDATE SET
       contacted_at    = @at,
       last_channel    = @channel,
       times_contacted = company_ledger.times_contacted + 1,
       company_number  = COALESCE(company_ledger.company_number, excluded.company_number),
       business_name   = COALESCE(company_ledger.business_name, excluded.business_name)`
  ).run({
    key,
    number: lead.company_number ?? null,
    name: lead.business_name ?? null,
    town: lead.location ?? null,
    channel: channel ?? null,
    nk: nameKey(lead),
    at,
  });
  return key;
}

/** Has this company ever been approached, on any channel? */
export function alreadyContacted(lead) {
  const row = ledgerFor(lead);
  return Boolean(row?.contacted_at);
}

/**
 * Whether a cold approach to this lead is allowed right now.
 *
 * `allowRepeat` is the deliberate override. It exists because "never contact
 * twice" is not quite what anyone wants — the owner sometimes has a real
 * reason to go again — and a rule with no escape hatch gets worked around in
 * ways that leave no record at all. Every override still lands in the ledger,
 * so times_contacted tells the truth.
 */
export function recontactCheck(lead = {}, { allowRepeat = false } = {}) {
  if (IN_CONVERSATION.includes(lead.status)) {
    return { allowed: true, code: 'IN_CONVERSATION' };
  }

  const row = ledgerFor(lead);

  // No key at all: a lead with neither a company number nor a name. The lead
  // stamp is the only history we have, so fall back to it rather than
  // reporting a clean sheet we cannot actually vouch for.
  if (!row && !companyKey(lead)) {
    if (lead.last_contacted_at) {
      return allowRepeat
        ? { allowed: true, code: 'OVERRIDDEN', previous: lead.last_contacted_at }
        : {
          allowed: false,
          code: 'ALREADY_CONTACTED',
          previous: lead.last_contacted_at,
          reason: `Already contacted on ${day(lead.last_contacted_at)}.`,
        };
    }
    return { allowed: true, code: 'UNIDENTIFIED' };
  }

  // The ledger is the record, but a lead stamped as contacted before this
  // table existed has no row. Honour the older evidence too.
  const previous = row?.contacted_at ?? lead.last_contacted_at ?? null;
  if (!previous) return { allowed: true, code: 'NEW' };

  if (allowRepeat) return { allowed: true, code: 'OVERRIDDEN', previous };

  const via = row?.last_channel ? ` by ${row.last_channel}` : '';
  return {
    allowed: false,
    code: 'ALREADY_CONTACTED',
    previous,
    channel: row?.last_channel ?? null,
    times: row?.times_contacted ?? 1,
    reason: `Already contacted${via} on ${day(previous)}. `
      + 'A second cold approach is what gets a complaint made.',
  };
}

/**
 * Company keys the hunt should not file again, as a Set for one bulk lookup.
 * A hunt page is up to 100 companies and runs against every trade and town,
 * so this must not be a query per company.
 */
export function knownCompanyNumbers() {
  const out = new Set();
  for (const r of db.prepare(
    'SELECT company_number FROM company_ledger WHERE company_number IS NOT NULL'
  ).all()) {
    out.add(String(r.company_number).trim().toUpperCase());
  }
  return out;
}

/** Ledger counts for the hunt screen. */
export function ledgerStats() {
  const row = db.prepare(
    `SELECT COUNT(*) AS companies,
            SUM(CASE WHEN contacted_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted
       FROM company_ledger`
  ).get();
  return { companies: row?.companies ?? 0, contacted: row?.contacted ?? 0 };
}

const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
};

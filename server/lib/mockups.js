/**
 * Building a mock up site for a lead, and finding the one already built.
 *
 * A mock up is a page written to data/mockups/<token>/ and served on an
 * unguessable link (/m/<token>/). It is built from what they told us in a
 * reply (their brief) when there is one, and otherwise from the lead alone:
 * the name, the trade and the town. That second kind is what goes with a
 * follow-up, so someone who never answered sees their own site rather than an
 * offer to make one.
 *
 * The build is quick and makes no network or model call (renderSite is plain
 * string work), so it can run inside a request.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting } from '../db.js';
import { nowIso } from './http.js';
import { renderSite, writeSite, newToken, PAGES, SINGLE_PAGE } from './site-builder.js';
import { briefForBuild } from './brief.js';
import { briefToApi } from './replies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// data/mockups unless MOCKUP_DIR says otherwise (the tests give each run its
// own, so a build in a test never lands among the real ones).
export const MOCKUP_ROOT = process.env.MOCKUP_DIR
  ? resolve(process.env.MOCKUP_DIR)
  : resolve(__dirname, '..', '..', 'data', 'mockups');

/**
 * Build a mock up for `lead` and file it. `briefRow` is the brief to build
 * from (a briefs row), or null to build from the lead alone. Returns
 * { id, token, layout, pages, brief }.
 */
export function buildMockup({ lead, briefRow = null, layout = 'single' }) {
  const brief = briefRow
    ? briefForBuild(briefToApi(briefRow), lead)
    : briefForBuild({ services: [], areas: [] }, lead);

  const token = newToken();
  const studio = getSetting('biz_name', 'this studio');
  // Built from the lead alone (for a follow-up), it has to read as a finished
  // page to someone who never asked for it: ready to show, not a form.
  const showcase = !briefRow;
  const files = renderSite(brief, {
    draftNote: showcase
      ? `Draft mockup for ${brief.business_name} — prepared by ${studio}. Your own photos, prices and reviews go in when it's built.`
      : `Draft mockup for ${brief.business_name} — prepared by ${studio}`,
    pages: layout,
    showcase,
  });
  try {
    writeSite(MOCKUP_ROOT, token, files);
  } catch (err) {
    throw new Error(`Could not write the mockup: ${err.message}`);
  }

  const pages = layout === 'multi' ? PAGES : SINGLE_PAGE;
  const info = db.prepare(
    `INSERT INTO mockups
       (lead_id, brief_id, token, business_name, trade, pages, palette, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lead.id, briefRow?.id ?? null, token, lead.business_name,
    brief.trade ?? lead.category ?? null,
    JSON.stringify(pages), JSON.stringify(brief.brand_colours ?? []), nowIso()
  );
  return { id: Number(info.lastInsertRowid), token, layout, pages, brief };
}

/** The lead's newest mock up that built, or null. The same one every screen shows. */
export function latestMockup(leadId) {
  return db.prepare(
    `SELECT id, token, generated_at FROM mockups
      WHERE lead_id = ? AND error IS NULL
      ORDER BY generated_at DESC, id DESC LIMIT 1`
  ).get(leadId) ?? null;
}

/**
 * The lead's mock up, built now if it has none. Reused rather than rebuilt,
 * so every follow-up carries the same link and no pile of copies builds up.
 * Built from their brief when they have replied with one.
 */
export function ensureMockup(lead) {
  const have = latestMockup(lead.id);
  if (have) return { ...have, built: false };
  const briefRow = db.prepare(
    'SELECT * FROM briefs WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(lead.id) ?? null;
  const made = buildMockup({ lead, briefRow });
  return { id: made.id, token: made.token, generated_at: nowIso(), built: true };
}

/** The full link to a mock up, from the address the team reaches this tool on. */
export function mockupLink(origin, token) {
  const base = /^https?:\/\/[^/\s]+$/i.test(String(origin ?? '')) ? origin : '';
  return `${base}/m/${token}/`;
}

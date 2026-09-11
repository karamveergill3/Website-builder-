import { Router } from 'express';
import { db } from '../db.js';
import { wrap, badRequest, notFound, nowIso, str, int } from '../lib/http.js';
import {
  configured, findCompany, advancedSearch, profile,
  isBodyCorporate, isTrading, AUTO_MATCH, CompaniesHouseError,
} from '../lib/companies-house.js';
import { resolveTrade, tradeList } from '../lib/sic.js';
import { recordFound } from '../lib/recontact.js';

const router = Router();

/**
 * Write a register entry onto a lead. Only a body corporate unblocks sending.
 *
 * Throws when another lead already holds this company number. That used to be
 * a silent success: two lead rows ended up "corporate" with the same number,
 * each independently emailable and each showing the owner no sign of the
 * other. Since migration 016 a partial UNIQUE index makes it an error, and
 * an error the caller can report is far better than two cold emails.
 */
function applyMatch(leadId, company, { note } = {}) {
  const corporate = isBodyCorporate(company.company_type) && isTrading(company);
  const number = String(company.company_number ?? '').trim().toUpperCase() || null;

  if (number) {
    const clash = db.prepare(
      'SELECT id, business_name FROM leads WHERE company_number = ? AND id != ?'
    ).get(number, leadId);
    if (clash) {
      const err = new Error(
        `Company ${number} is already on lead #${clash.id} (${clash.business_name}). `
        + 'Two leads for one company get contacted twice.'
      );
      err.status = 409;
      err.details = { existing_lead_id: clash.id, company_number: number };
      throw err;
    }
  }

  db.prepare(
    `UPDATE leads SET
       entity_type = @entity_type, company_number = @company_number,
       registered_name = @registered_name, registered_address = @registered_address,
       company_status = @company_status, company_type = @company_type,
       incorporated_on = @incorporated_on, sic_codes = @sic_codes,
       entity_note = @entity_note, checked_at = @now
     WHERE id = @id`
  ).run({
    id: leadId,
    // A register entry that is not a body corporate is positive evidence the
    // other way: it is a partnership or a branch, so it cannot be emailed.
    entity_type: corporate ? 'corporate' : 'individual',
    company_number: number,
    registered_name: company.company_name,
    registered_address: company.address_snippet ?? null,
    company_status: company.company_status,
    company_type: company.company_type,
    incorporated_on: company.date_of_creation ?? null,
    sic_codes: (company.sic_codes ?? []).join(',') || null,
    entity_note: note ?? `Companies House ${company.company_number}`,
    now: nowIso(),
  });
  // The lead now has a company number, which is the ledger's strong key. File
  // it so a later Places sweep or hunt page recognises this business.
  recordFound(db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId));
  return corporate;
}

router.get('/status', wrap((_req, res) => {
  res.json({
    configured: configured(),
    trades: tradeList(),
    auto_match_threshold: AUTO_MATCH,
    unchecked: db.prepare(
      "SELECT COUNT(*) n FROM leads WHERE entity_type = 'unknown' AND opted_out = 0"
    ).get().n,
  });
}));

router.get('/trade', wrap((req, res) => {
  res.json(resolveTrade(req.query.q));
}));

/** Look a single lead up, without writing anything. */
router.get('/lookup/:leadId', wrap(async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.leadId);
  if (!lead) throw notFound('Lead not found');

  const { candidates, auto } = await findCompany(lead.business_name, { location: lead.location });
  res.json({
    lead: { id: lead.id, business_name: lead.business_name, location: lead.location },
    candidates: candidates.map((c) => ({
      ...c,
      body_corporate: isBodyCorporate(c.company_type),
      trading: isTrading(c),
      sendable: isBodyCorporate(c.company_type) && isTrading(c),
    })),
    auto: auto ? auto.company_number : null,
  });
}));

/** Attach a chosen company to a lead. */
router.post('/attach', wrap(async (req, res) => {
  const leadId = int(req.body.lead_id);
  const number = str(req.body.company_number);
  if (!leadId || !number) throw badRequest('lead_id and company_number are required');

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw notFound('Lead not found');

  const company = await profile(number);
  if (!company) throw notFound(`No company ${number} on the register`);

  const corporate = applyMatch(leadId, company, { note: `Companies House ${number}, checked by hand` });
  res.json({
    lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId),
    company, sendable: corporate,
  });
}));

/** Mark a lead as checked and NOT a company — a sole trader. */
router.post('/mark-sole-trader', wrap((req, res) => {
  const leadId = int(req.body.lead_id);
  if (!leadId) throw badRequest('lead_id is required');
  const info = db.prepare(
    `UPDATE leads SET entity_type = 'individual', entity_note = ?, checked_at = ?
      WHERE id = ?`
  ).run('No Companies House match — treated as a sole trader', nowIso(), leadId);
  if (!info.changes) throw notFound('Lead not found');
  res.json({ lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) });
}));

/* ------------------------------------------------------------- bulk check */

let qualifyRun = null;

/**
 * Check every unclassified lead against the register. Only unambiguous
 * matches are applied; anything doubtful is left for a human.
 */
router.post('/qualify-all', wrap((req, res) => {
  if (!configured()) {
    throw new CompaniesHouseError('COMPANIES_HOUSE_API_KEY is not set.', { status: 503, code: 'NOT_CONFIGURED' });
  }
  if (qualifyRun?.running) throw badRequest('A check is already running.');

  const leads = db.prepare(
    `SELECT * FROM leads WHERE entity_type = 'unknown' AND opted_out = 0 ORDER BY id`
  ).all();
  if (!leads.length) throw badRequest('Nothing left to check.');

  qualifyRun = {
    running: true, total: leads.length, done: 0,
    matched: 0, sole_trader: 0, ambiguous: 0, failed: 0,
    started_at: nowIso(), finished_at: null, error: null,
  };

  (async () => {
    for (const lead of leads) {
      if (!qualifyRun.running) break;
      try {
        const { auto } = await findCompany(lead.business_name, { location: lead.location });
        if (auto) {
          applyMatch(lead.id, auto);
          qualifyRun.matched++;
        } else {
          qualifyRun.ambiguous++;
        }
      } catch (err) {
        qualifyRun.failed++;
        if (err instanceof CompaniesHouseError && !err.retryable && err.code !== 'PAGE_TOO_DEEP') {
          qualifyRun.error = err.message;
          break;
        }
      }
      qualifyRun.done++;
    }
    qualifyRun.running = false;
    qualifyRun.finished_at = nowIso();
    const done = qualifyRun;
    setTimeout(() => { if (qualifyRun === done) qualifyRun = null; }, 120_000);
  })();

  res.status(202).json({ run: qualifyRun });
}));

router.get('/qualify-all/status', wrap((_req, res) => res.json({ run: qualifyRun })));

router.post('/qualify-all/cancel', wrap((_req, res) => {
  if (qualifyRun) qualifyRun.running = false;
  res.json({ cancelled: true });
}));

/* -------------------------------------------------------------- discovery */

/**
 * Search the register directly by trade and town. Everything this returns is
 * an active body corporate, so it is qualified before it becomes a lead --
 * the opposite way round from searching a map and hoping.
 */
router.post('/discover', wrap(async (req, res) => {
  const trade = resolveTrade(req.body.trade);
  const location = str(req.body.location);
  if (!trade.codes.length && !location) {
    throw badRequest('Give a trade or a town. Try "roofers", or a SIC code such as 43910.');
  }

  const size = Math.min(Math.max(int(req.body.size, 100), 1), 500);
  const startIndex = Math.max(int(req.body.start_index, 0), 0);

  const { total, items } = await advancedSearch({
    sicCodes: trade.codes.join(','), location, size, startIndex,
  });

  const known = new Set(
    db.prepare('SELECT company_number FROM leads WHERE company_number IS NOT NULL')
      .all().map((r) => r.company_number)
  );

  res.json({
    trade,
    location: location ?? null,
    total,
    start_index: startIndex,
    companies: items.map((c) => ({
      ...c,
      body_corporate: isBodyCorporate(c.company_type),
      already_a_lead: known.has(c.company_number),
    })),
  });
}));

/** Turn chosen register entries into leads, already classified. */
router.post('/discover/import', wrap((req, res) => {
  const numbers = Array.isArray(req.body.company_numbers) ? req.body.company_numbers.map(String) : [];
  if (!numbers.length) throw badRequest('Tick at least one company.');

  const supplied = new Map(
    (Array.isArray(req.body.companies) ? req.body.companies : []).map((c) => [String(c.company_number), c])
  );
  const category = str(req.body.category);
  const imported = [];
  const skipped = [];

  db.transaction(() => {
    for (const number of numbers) {
      const c = supplied.get(number);
      if (!c) { skipped.push({ company_number: number, reason: 'not in the results' }); continue; }
      if (!isBodyCorporate(c.company_type)) {
        skipped.push({ company_number: number, reason: 'not a body corporate' }); continue;
      }
      if (db.prepare('SELECT id FROM leads WHERE company_number = ?').get(number)) {
        skipped.push({ company_number: number, reason: 'already a lead' }); continue;
      }

      const info = db.prepare(
        `INSERT INTO leads
           (business_name, category, location, status, source, opted_out, entity_type,
            company_number, registered_name, registered_address, company_status,
            company_type, incorporated_on, sic_codes, entity_note, checked_at, created_at)
         VALUES (@name, @category, @location, 'new', 'Companies House', 0, 'corporate',
                 @number, @name, @address, @status, @type, @inc, @sic, @note, @now, @now)`
      ).run({
        name: c.company_name,
        category: category ?? null,
        location: c.locality ?? null,
        number,
        address: c.address_snippet ?? null,
        status: c.company_status ?? null,
        type: c.company_type ?? null,
        inc: c.date_of_creation ?? null,
        sic: (c.sic_codes ?? []).join(',') || null,
        note: `Companies House ${number}`,
        now: nowIso(),
      });
      // File it in the company ledger, the same as every other import path
      // (the hunt, applyMatch, POST /api/leads). Without this, a company
      // imported here and then deleted before it was contacted would be
      // offered again by a later hunt — the ledger is what remembers it.
      recordFound(db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid));
      imported.push(Number(info.lastInsertRowid));
    }
  })();

  res.status(201).json({
    imported: imported.length,
    skipped,
    leads: imported.length
      ? db.prepare(`SELECT * FROM leads WHERE id IN (${imported.map(() => '?').join(',')})`).all(...imported)
      : [],
  });
}));

export default router;

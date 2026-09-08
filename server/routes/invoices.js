/**
 * Invoicing — clients, invoices, and monthly maintenance plans.
 *
 * All of this sits behind the login (mounted under the /api gate). The
 * client-facing invoice PAGE is served separately and publicly at /i/:token
 * (see index.js), the way a mockup preview is — a client has no account, so
 * they open an unguessable link, read the invoice and pay.
 */
import { Router } from 'express';
import { wrap, badRequest, notFound, str, int, bool } from '../lib/http.js';
import {
  createClient, listClients,
  createInvoice, getInvoice, listInvoices, markSent, markPaid, voidInvoice,
  createMaintenancePlan, listPlans, setPlanActive, billPlan, getPlan,
  ensurePlanToken, startPlanDirectDebit,
  toPence,
} from '../lib/invoicing.js';
import { configured as gcConfigured, createMandateFlow } from '../lib/gocardless.js';
import { db } from '../db.js';

const router = Router();

/* --------------------------------------------------------------- clients */

router.get('/clients', wrap((_req, res) => {
  res.json({ clients: listClients() });
}));

router.post('/clients', wrap((req, res) => {
  const client = createClient({
    name: req.body?.name,
    contact_name: req.body?.contact_name,
    email: req.body?.email,
    phone: req.body?.phone,
    address: req.body?.address,
    lead_id: int(req.body?.lead_id) ?? null,
  });
  res.status(201).json({ client });
}));

/**
 * Turn a won lead into a client in one step, copying what we already know.
 * Idempotent-ish: if a client already points at this lead, return it.
 */
router.post('/clients/from-lead/:leadId', wrap((req, res) => {
  const leadId = int(req.params.leadId);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw notFound('Lead not found');

  const existing = db.prepare('SELECT * FROM clients WHERE lead_id = ?').get(leadId);
  if (existing) return res.json({ client: existing, existed: true });

  const client = createClient({
    name: lead.business_name,
    email: lead.email,
    phone: lead.phone,
    address: lead.registered_address ?? lead.location,
    lead_id: leadId,
  });
  res.status(201).json({ client });
}));

/* --------------------------------------------------------------- invoices */

/** Lines come as [{ description, qty, unit_pounds }] from the UI. */
function parseLines(body) {
  const raw = Array.isArray(body?.lines) ? body.lines : [];
  return raw.map((l) => ({
    description: str(l.description),
    qty: int(l.qty) ?? 1,
    unit_pence: l.unit_pence != null ? int(l.unit_pence) : toPence(l.unit_pounds),
  }));
}

router.get('/', wrap((req, res) => {
  res.json({
    invoices: listInvoices({
      status: str(req.query.status) ?? undefined,
      client_id: int(req.query.client_id) ?? undefined,
    }),
  });
}));

router.post('/', wrap((req, res) => {
  // A client can be named inline (common: straight after winning the lead) or
  // referenced by id.
  let clientId = int(req.body?.client_id);
  if (!clientId && req.body?.client) {
    clientId = createClient(req.body.client).id;
  }
  if (!clientId) throw badRequest('Pick or enter a client.');

  const invoice = createInvoice({
    client_id: clientId,
    kind: str(req.body?.kind) ?? 'build',
    lines: parseLines(req.body),
    notes: str(req.body?.notes),
    due_at: str(req.body?.due_at),
    deposit_pounds: str(req.body?.deposit_pounds),
    created_by: req.user?.id ?? null,
  });
  res.status(201).json({ invoice });
}));

router.get('/:id', wrap((req, res) => {
  const invoice = getInvoice(int(req.params.id));
  if (!invoice) throw notFound('Invoice not found');
  res.json({ invoice });
}));

router.post('/:id/sent', wrap((req, res) => {
  res.json({ invoice: markSent(int(req.params.id)) });
}));

router.post('/:id/paid', wrap((req, res) => {
  res.json({ invoice: markPaid(int(req.params.id), str(req.body?.method) ?? 'other') });
}));

router.post('/:id/void', wrap((req, res) => {
  res.json({ invoice: voidInvoice(int(req.params.id)) });
}));

router.delete('/:id', wrap((req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(int(req.params.id));
  if (!inv) throw notFound('Invoice not found');
  // Only a draft can be hard-deleted; anything sent is a financial record and
  // is voided instead, so the number is never silently reused.
  if (inv.status !== 'draft') {
    throw badRequest('Only a draft can be deleted. Void a sent invoice instead.');
  }
  db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
  res.status(204).end();
}));

/* ------------------------------------------------------- maintenance plans */

router.get('/maintenance/plans', wrap((_req, res) => {
  res.json({ plans: listPlans() });
}));

router.post('/maintenance/plans', wrap((req, res) => {
  let clientId = int(req.body?.client_id);
  if (!clientId && req.body?.client) clientId = createClient(req.body.client).id;
  if (!clientId) throw badRequest('Pick or enter a client.');
  const plan = createMaintenancePlan({
    client_id: clientId,
    monthly_pounds: req.body?.monthly_pounds,
    description: str(req.body?.description),
    started_on: str(req.body?.started_on),
  });
  res.status(201).json({ plan });
}));

router.post('/maintenance/plans/:id/active', wrap((req, res) => {
  res.json({ plan: setPlanActive(int(req.params.id), bool(req.body?.active)) });
}));

/** Raise this month's invoice for a plan. */
router.post('/maintenance/plans/:id/bill', wrap((req, res) => {
  const invoice = billPlan(int(req.params.id), { created_by: req.user?.id ?? null });
  res.status(201).json({ invoice });
}));

/**
 * Set a plan up for Direct Debit (GoCardless). Creates an authorisation flow
 * and hands back the link to send the client. They fill in their bank details
 * on GoCardless's own page; on their return we finish the mandate and start the
 * monthly collection (see GET /dd/:token/return in index.js). Env-gated: with
 * no GOCARDLESS_ACCESS_TOKEN set, the option never appears in the UI and this
 * route says so plainly.
 */
router.post('/maintenance/plans/:id/direct-debit', wrap(async (req, res) => {
  if (!gcConfigured()) {
    throw badRequest('Direct Debit is not connected. Add GOCARDLESS_ACCESS_TOKEN in .env.');
  }
  const plan = getPlan(int(req.params.id));
  if (!plan) throw notFound('Plan not found');
  if (plan.dd_status === 'active') throw badRequest('This plan is already on Direct Debit.');

  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
    || (req.secure ? 'https' : 'http');
  const base = `${proto}://${req.get('host')}`;
  const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(plan.client_id);

  const token = ensurePlanToken(plan.id);
  const flow = await createMandateFlow({
    returnUrl: `${base}/dd/${token}/return`,
    exitUrl: `${base}/dd/${token}/return`,
    name: client?.name,
  });
  startPlanDirectDebit(plan.id, { billingRequestId: flow.billingRequestId });
  res.json({ authorisation_url: flow.authorisationUrl });
}));

export default router;

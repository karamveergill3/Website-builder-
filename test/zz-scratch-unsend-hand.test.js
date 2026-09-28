import test from 'node:test';
const { get, post, patch, teardown, nextCompanyNumber } = await import('./helpers.js');
const { db } = await import('../server/db.js');
test.after(teardown);
test('hand-marked then replied then WA then Not sent', async () => {
  const out = [];
  const lead = (await post('/api/leads', { business_name: 'Acme Roofing', phone: '07700 900123',
    entity_type: 'corporate', company_number: nextCompanyNumber(), category: 'roofers', location: 'Leeds' })).body.lead;
  let r = await patch(`/api/leads/${lead.id}`, { status: 'sent' });
  const T0 = r.body.lead.last_contacted_at;
  out.push(['after hand sent', r.body.lead.status, T0, db.prepare('SELECT contacted_at,last_channel,times_contacted FROM company_ledger').all()]);
  r = await patch(`/api/leads/${lead.id}`, { status: 'replied' });
  out.push(['replied', r.body.lead.status, r.body.lead.last_contacted_at]);
  await new Promise(r => setTimeout(r, 20));
  const p = await post('/api/outreach/prepare', { lead_id: lead.id, channel: 'whatsapp', text: 'hi' });
  out.push(['prepare', p.status, p.body.error]);
  const s = await post(`/api/outreach/${p.body.event_id}/sent`, {});
  const l1 = db.prepare('SELECT status,last_contacted_at FROM leads WHERE id=?').get(lead.id);
  out.push(['after WA', l1, db.prepare('SELECT contacted_at,last_channel,times_contacted FROM company_ledger').all()]);
  const u = await post(`/api/leads/${lead.id}/whatsapp-unsend`, {});
  out.push(['after unsend', u.status, u.body.lead.status, u.body.lead.last_contacted_at, u.body.lead.contacted_at, u.body.lead.contacted_via, u.body.lead.can_contact,
    db.prepare('SELECT contacted_at,last_channel,times_contacted FROM company_ledger').all()]);
  // later marked lost
  r = await patch(`/api/leads/${lead.id}`, { status: 'lost' });
  out.push(['lost', r.body.lead.contacted_at, r.body.lead.contacted_via, r.body.lead.can_contact, r.body.lead.contact_block_reason]);
  process.stderr.write('RESULT ' + JSON.stringify(out, null, 1) + '\n');
});

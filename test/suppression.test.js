import test from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, del, put, IDENTITY, teardown } from './helpers.js';

test.after(teardown);

const corp = (over = {}) => ({
  business_name: 'Suppress Test Ltd', entity_type: 'corporate',
  company_number: '01234567', email: 'a@suppresstest.co.uk', ...over,
});

test('an opt-out is recorded against the address and survives deleting the lead', async () => {
  await put('/api/settings', IDENTITY);
  const tpl = (await post('/api/templates', { name: 'S', subject: 's', body: 'b' })).body.template;

  const lead = (await post('/api/leads', corp({ email: 'stop@example.co.uk' }))).body.lead;
  assert.equal(lead.can_email, true);

  await patch(`/api/leads/${lead.id}`, { opted_out: true });
  assert.equal((await get('/api/leads/stats')).body.suppressed, 1);

  // Delete the lead entirely, as if tidying up.
  await del(`/api/leads/${lead.id}`);

  // Re-import the same business, exactly as a later Places sweep would.
  const again = (await post('/api/leads', corp({
    business_name: 'Suppress Test Ltd', email: 'stop@example.co.uk',
  }))).body.lead;

  assert.equal(again.suppressed, true, 'the address is still suppressed');
  assert.equal(again.can_email, false);
  assert.equal(again.block_code, 'SUPPRESSED');

  // And every send path refuses it.
  assert.equal((await get(`/api/emails/preview?lead_id=${again.id}&template_id=${tpl.id}`)).status, 400);
  assert.equal((await post('/api/emails/log', { lead_id: again.id, template_id: tpl.id })).status, 400);

  await del(`/api/leads/${again.id}`);
  await del(`/api/templates/${tpl.id}`);
});

test('the suppression list is readable and an entry can be lifted', async () => {
  const lead = (await post('/api/leads', corp({ email: 'lift@example.co.uk' }))).body.lead;
  await patch(`/api/leads/${lead.id}`, { opted_out: true });

  const listed = (await get('/api/suppression')).body.entries;
  assert.ok(listed.some((e) => e.email === 'lift@example.co.uk'));

  assert.equal((await del('/api/suppression/lift@example.co.uk')).status, 204);
  const after = (await get('/api/suppression')).body.entries;
  assert.equal(after.some((e) => e.email === 'lift@example.co.uk'), false);

  await del(`/api/leads/${lead.id}`);
});

test('stats count what is lawfully emailable, not merely what has an address', async () => {
  const made = [];
  made.push((await post('/api/leads', corp({ business_name: 'Good Ltd', email: 'a@goodltd.co.uk' }))).body.lead);
  made.push((await post('/api/leads', corp({ business_name: 'Sole Trader Dave', entity_type: 'individual', email: 'b@dave.co.uk' }))).body.lead);
  made.push((await post('/api/leads', corp({ business_name: 'Unchecked Ltd', entity_type: 'unknown', email: 'c@unchecked.co.uk' }))).body.lead);
  made.push((await post('/api/leads', corp({ business_name: 'Gmail Ltd', email: 'd@gmail.com' }))).body.lead);

  const stats = (await get('/api/leads/stats')).body;
  assert.equal(stats.emailable, 1, 'only the classified company on its own domain');
  assert.equal(stats.unclassified >= 1, true);
  assert.equal(stats.individual >= 1, true);

  for (const l of made) await del(`/api/leads/${l.id}`);
});

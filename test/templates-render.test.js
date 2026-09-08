/**
 * The message on screen is the message that gets sent.
 *
 * Two things this proves. First, that the tool ships with wording so a fresh
 * install is not staring at an empty box with sixty leads behind it. Second —
 * the one that actually bit — that a template is filled in for the specific
 * company, by ONE renderer on the server, not a copy of it in the browser
 * that can drift token by token until the preview and the send disagree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { get, post, put, teardown, nextCompanyNumber } = await import('./helpers.js');
const { db } = await import('../server/db.js');
const { STARTERS } = await import('../server/lib/starters.js');

const uniq = () => Math.random().toString(36).slice(2, 8);

async function makeLead(over = {}) {
  const r = await post('/api/leads', {
    business_name: `Render Test ${uniq()}`,
    category: 'roofers',
    location: 'Stafford',
    phone: '07700 900123',
    entity_type: 'corporate',
    company_number: nextCompanyNumber(),
    ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}

/* ------------------------------------------------------------- shipped */

test('the starters are seeded, one first message per channel', async () => {
  const { templates } = (await get('/api/templates')).body;
  for (const s of STARTERS) {
    assert.ok(templates.some((t) => t.name === s.name && t.channel === s.channel),
      `"${s.name}" (${s.channel}) should have been seeded`);
  }
  for (const channel of ['email', 'whatsapp', 'sms']) {
    assert.ok(templates.some((t) => t.channel === channel && /^first/i.test(t.name)),
      `a first-message template for ${channel}`);
  }
});

test('a WhatsApp/SMS starter names its sender in the body, since nothing is appended', () => {
  for (const s of STARTERS.filter((x) => x.channel !== 'email')) {
    assert.match(s.body, /\{\{my_/,
      `${s.name} must identify the sender in the body`);
    assert.match(s.body.toLowerCase(), /stop|say|won't (write|text|message)|opt/,
      `${s.name} must offer a way to opt out`);
  }
});

test('restoring starters is idempotent and never clobbers an edit', async () => {
  const first = (await post('/api/templates/starters', {})).body;
  assert.equal(first.added, 0, 'they are already there from the seed');

  // Delete one, edit another, then restore: the deleted one comes back, the
  // edited one is untouched.
  const { templates } = (await get('/api/templates')).body;
  const wa = templates.find((t) => t.name === 'First message — WhatsApp');
  const email = templates.find((t) => t.name === 'First message — email');
  await put(`/api/templates/${email.id}`, { ...email, body: 'MY OWN WORDS {{business}}' });
  db.prepare('DELETE FROM templates WHERE id = ?').run(wa.id);

  const res = (await post('/api/templates/starters', {})).body;
  assert.equal(res.added, 1, 'only the deleted one comes back');
  const after = (await get('/api/templates')).body.templates;
  assert.ok(after.some((t) => t.name === 'First message — WhatsApp'));
  assert.equal(after.find((t) => t.id === email.id).body, 'MY OWN WORDS {{business}}',
    'the edited one is left exactly as it was');
});

/* -------------------------------------------------------------- render */

test('render fills the business in, for the lead you name', async () => {
  await put('/api/settings', {
    biz_contact_name: 'Karam', biz_name: 'Keylo Studios', biz_phone: '07305 166185',
    biz_address: '1 Test St, Stafford ST18 9AB', biz_email: 'hello@keylo.example',
  });
  const lead = await makeLead({ business_name: 'Acme Roofing Ltd', location: 'Cannock' });
  const tpl = (await get('/api/templates')).body.templates
    .find((t) => t.name === 'First message — WhatsApp');

  const r = (await get(`/api/templates/${tpl.id}/render?lead_id=${lead.id}`)).body;
  assert.match(r.body, /Acme Roofing Ltd/, 'the prospect');
  assert.match(r.body, /Cannock/, 'their town');
  assert.match(r.body, /Karam|Keylo Studios/, 'the sender, from Settings');
  assert.ok(!/\{\{/.test(r.body), 'no unfilled tokens left in a fully-configured render');
  assert.deepEqual(r.empty, [], 'nothing rendered blank');
});

test('render is scoped to the named lead, so two companies get two messages', async () => {
  const a = await makeLead({ business_name: 'Alpha Ltd' });
  const b = await makeLead({ business_name: 'Bravo Ltd' });
  const tpl = (await get('/api/templates')).body.templates
    .find((t) => t.channel === 'whatsapp');

  const ra = (await get(`/api/templates/${tpl.id}/render?lead_id=${a.id}`)).body;
  const rb = (await get(`/api/templates/${tpl.id}/render?lead_id=${b.id}`)).body;
  assert.match(ra.body, /Alpha Ltd/);
  assert.match(rb.body, /Bravo Ltd/);
  assert.ok(!ra.body.includes('Bravo'), 'no cross-contamination');
});

test('render reports the tokens it could not fill', async () => {
  await put('/api/settings', { biz_website: '' });
  const lead = await makeLead();
  // A template that leans on the website line.
  const created = (await post('/api/templates', {
    name: `Site push ${uniq()}`, channel: 'whatsapp', subject: '',
    body: 'See {{my_website}} — {{business}}',
  })).body.template;

  const r = (await get(`/api/templates/${created.id}/render?lead_id=${lead.id}`)).body;
  assert.ok(r.empty.includes('my_website'), 'the blank sender field is named');
  assert.match(r.body, /See  —/, 'and it renders empty rather than as a token');
});

test('render 404s for an unknown lead or template', async () => {
  const lead = await makeLead();
  const tpl = (await get('/api/templates')).body.templates[0];
  assert.equal((await get(`/api/templates/${tpl.id}/render?lead_id=999999`)).status, 404);
  assert.equal((await get(`/api/templates/999999/render?lead_id=${lead.id}`)).status, 404);
  assert.equal((await get(`/api/templates/${tpl.id}/render`)).status, 400);
});

test.after(teardown);

/* ------------------------------------------------- trade-tailored openers */

test('a lead carries its sector, so the right opener can pick itself', async () => {
  const salon = await makeLead({ category: 'nail bar' });
  const trade = await makeLead({ category: 'roofers' });
  const other = await makeLead({ category: 'cafe' });

  const byId = Object.fromEntries(
    (await get('/api/leads')).body.leads.map((l) => [l.id, l])
  );
  assert.equal(byId[salon.id].sector_label, 'Salons & beauty');
  assert.equal(byId[trade.id].sector_label, 'Trades');
  assert.equal(byId[other.id].sector_label, null, 'the rest use the generic opener');
});

test('the salon and trades WhatsApp openers are seeded and read naturally', async () => {
  const names = (await get('/api/templates')).body.templates
    .filter((t) => t.channel === 'whatsapp').map((t) => t.name);
  assert.ok(names.includes('First message — WhatsApp · Salons & beauty'));
  assert.ok(names.includes('First message — WhatsApp · Trades'));

  // The generic opener no longer jams the raw trade word in — it reads for any
  // trade, salons and cafés included.
  const wa = (await get('/api/templates')).body.templates
    .find((t) => t.name === 'First message — WhatsApp');
  assert.ok(!wa.body.includes('{{category}}'), 'the generic opener drops the fragile trade word');
});


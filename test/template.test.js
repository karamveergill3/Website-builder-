import test from 'node:test';
import assert from 'node:assert/strict';
import {
  render, renderTemplate, leadContext, senderContext, unknownPlaceholders,
} from '../server/lib/template.js';

const LEAD = {
  business_name: 'Hillside Roofing', category: 'roofers', location: 'Otley',
  phone: '01943 000000', email: 'a@b.example',
};

test('fills the three canonical placeholders', () => {
  const out = render('{{business}} — {{category}} in {{location}}', leadContext(LEAD));
  assert.equal(out, 'Hillside Roofing — roofers in Otley');
});

test('tolerates whitespace and mixed case inside the braces', () => {
  assert.equal(render('{{ Business }}', leadContext(LEAD)), 'Hillside Roofing');
});

test('missing lead fields render empty, not "null"', () => {
  const out = render('[{{location}}]', leadContext({ business_name: 'X' }));
  assert.equal(out, '[]');
});

test('unknown placeholders survive so a typo is visible in the preview', () => {
  assert.equal(render('{{buisness}}', leadContext(LEAD)), '{{buisness}}');
  assert.deepEqual(unknownPlaceholders('{{buisness}} {{business}}'), ['buisness']);
});

test('renderTemplate fills both subject and body', () => {
  const r = renderTemplate({ subject: 'Hi {{business}}', body: 'in {{location}}' }, LEAD);
  assert.equal(r.subject, 'Hi Hillside Roofing');
  assert.equal(r.body, 'in Otley');
});

test('first_name is the first word of the business name', () => {
  assert.equal(leadContext({ business_name: 'Dave Smith Plumbing' }).first_name, 'Dave');
});

test('a null template string renders as empty', () => {
  assert.equal(render(null, leadContext(LEAD)), '');
});

test('emptyPlaceholders names the tokens this lead leaves blank', async () => {
  const { emptyPlaceholders } = await import('../server/lib/template.js');
  const tpl = { subject: 'Hi {{business}}', body: '{{category}} in {{location}}' };

  assert.deepEqual(emptyPlaceholders(tpl, LEAD), []);
  assert.deepEqual(
    emptyPlaceholders(tpl, { business_name: 'X', category: 'roofers' }),
    ['location']
  );
  assert.deepEqual(
    emptyPlaceholders(tpl, { business_name: 'X' }).sort(),
    ['category', 'location']
  );
});

test('emptyPlaceholders ignores tokens the template does not use', async () => {
  const { emptyPlaceholders } = await import('../server/lib/template.js');
  assert.deepEqual(emptyPlaceholders({ subject: 'Hi', body: 'there' }, {}), []);
});

/* ------------------------------------------------------------- sender half */

const ME = {
  biz_contact_name: 'Karam', biz_name: 'Keylo Studios',
  biz_phone: '07305 166185', biz_email: 'hello@keylo.example',
  biz_website: 'keylo.example',
};

test('senderContext maps the biz_* settings to my_* tokens', () => {
  const ctx = senderContext(ME);
  assert.equal(ctx.my_name, 'Karam');
  assert.equal(ctx.my_business, 'Keylo Studios');
  assert.equal(ctx.my_phone, '07305 166185');
  assert.equal(ctx.my_email, 'hello@keylo.example');
  assert.equal(ctx.my_website, 'keylo.example');
});

test('a message can name both the prospect and the sender', () => {
  // The whole reason WhatsApp/SMS templates carry {{my_*}}: no footer is
  // appended, so the identification has to be in the body.
  const r = renderTemplate(
    { subject: '', body: "Hi {{business}}, it's {{my_name}} from {{my_business}}" },
    LEAD, ME
  );
  assert.equal(r.body, "Hi Hillside Roofing, it's Karam from Keylo Studios");
});

test('a blank sender setting renders empty, and emptyPlaceholders flags it', async () => {
  const { emptyPlaceholders } = await import('../server/lib/template.js');
  const tpl = { subject: '', body: 'from {{my_name}}' };
  assert.equal(renderTemplate(tpl, LEAD, {}).body, 'from ');
  assert.deepEqual(emptyPlaceholders(tpl, LEAD, {}), ['my_name']);
  assert.deepEqual(emptyPlaceholders(tpl, LEAD, ME), []);
});


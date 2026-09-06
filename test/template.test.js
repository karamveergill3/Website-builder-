import test from 'node:test';
import assert from 'node:assert/strict';
import { render, renderTemplate, leadContext, unknownPlaceholders } from '../server/lib/template.js';

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

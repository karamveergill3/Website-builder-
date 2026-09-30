/**
 * Names and towns as a person writes them, not as Companies House stores them.
 * "I came across HILLSIDE ROOFING LTD in STOKE-ON-TRENT" reads as copied off a
 * register by a machine; the first message and the mock up must not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { businessName, registeredName, placeName } = await import('../server/lib/names.js');
const { renderTemplate } = await import('../server/lib/template.js');
const { STARTERS } = await import('../server/lib/starters.js');

test('a name in capitals is written as the owner would say it', () => {
  assert.equal(businessName('HILLSIDE ROOFING LTD'), 'Hillside Roofing');
  assert.equal(businessName("JOHN'S PLUMBING LIMITED"), "John's Plumbing");
  assert.equal(businessName('MJ ELECTRICAL LTD'), 'MJ Electrical');
  assert.equal(businessName('HAIR ON THE HILL LTD'), 'Hair on the Hill');
  assert.equal(businessName("O'NEILL BUILDERS LTD"), "O'Neill Builders");
  assert.equal(businessName('ONE TO LEARN CIC'), 'One to Learn CIC');
  assert.equal(businessName('SMITH-JONES DECORATING LTD'), 'Smith-Jones Decorating');
  assert.equal(registeredName('HILLSIDE ROOFING LTD'), 'Hillside Roofing Ltd');
});

test('a name someone typed or styled is left exactly as it is', () => {
  for (const n of ['McKinnon Roofing Ltd', 'Snapshot Co Ltd', 'Perfect Paws Burton Ltd', 'iFix Phones']) {
    assert.equal(businessName(n), n);
    assert.equal(registeredName(n), n);
  }
});

test('a town as it is signposted', () => {
  assert.equal(placeName('STOKE-ON-TRENT'), 'Stoke-on-Trent');
  assert.equal(placeName('Stoke-On-Trent'), 'Stoke-on-Trent');
  assert.equal(placeName('BURTON UPON TRENT'), 'Burton upon Trent');
  assert.equal(placeName('NEWCASTLE-UNDER-LYME'), 'Newcastle-under-Lyme');
  assert.equal(placeName("KING'S LYNN"), "King's Lynn");
  assert.equal(placeName('Wolverhampton'), 'Wolverhampton');
});

test('the first WhatsApp and the follow-up read like a person wrote them', () => {
  const lead = { business_name: 'HILLSIDE ROOFING LTD', location: 'STOKE-ON-TRENT', category: 'roofer', mockup_link: 'https://x.example/m/1/' };
  const first = renderTemplate(STARTERS.find((s) => s.name === 'First message — WhatsApp'), lead, { biz_name: 'Keylo Studios' }, { name: 'Javier' });
  assert.match(first.body, /I came across Hillside Roofing in Stoke-on-Trent/);
  const follow = renderTemplate(STARTERS.find((s) => s.name === 'Follow-up — WhatsApp'), lead, { biz_name: 'Keylo Studios' }, { name: 'Javier' });
  assert.match(follow.body, /a website for Hillside Roofing,/);
  assert.doesNotMatch(first.body + follow.body, /HILLSIDE|STOKE-ON-TRENT/);
});

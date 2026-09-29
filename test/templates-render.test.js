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
    assert.match(s.body, /\{\{my_name\}\}/, `${s.name} must identify the sender in the body`);
    assert.match(s.body, /\{\{my_business\}\}/, `${s.name} must name the business sending it`);
  }
  // A WhatsApp or a text is answered on the number it came from, and a "no"
  // or "stop" pasted into the tool opts them out, so both end their ask on
  // "No pressure at all." and nothing says "I won't message again" (Keylo's call).
  for (const s of STARTERS.filter((x) => x.channel === 'whatsapp')) {
    assert.match(s.body, /No pressure at all\.\n/, `${s.name} ends its ask on "No pressure at all."`);
  }
  for (const s of STARTERS.filter((x) => x.channel === 'sms')) {
    assert.match(s.body, /No pressure at all\.$/, `${s.name} ends on "No pressure at all."`);
  }
  for (const s of STARTERS) {
    assert.ok(!/won'?t (message|text) again/i.test(s.body), `${s.name} never says it won't message again`);
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
  const other = await makeLead({ category: 'accountant' });

  const byId = Object.fromEntries(
    (await get('/api/leads')).body.leads.map((l) => [l.id, l])
  );
  assert.equal(byId[salon.id].sector_label, 'Salons & beauty');
  assert.equal(byId[trade.id].sector_label, 'Trades');
  assert.equal(byId[other.id].sector_label, null, 'an unrecognised trade uses the generic opener');
});

test('no opener claims "proven to boost sales by 40%", shipped or saved', async () => {
  for (const s of STARTERS) assert.doesNotMatch(s.body, /boost sales|proven to/i, s.name);
  for (const t of (await get('/api/templates')).body.templates) {
    assert.doesNotMatch(t.body, /boost sales|proven to/i, `${t.name} (as saved)`);
  }
});

test('the WhatsApp opener reads exactly as Keylo sends it, for a window cleaner', async () => {
  const { renderTemplate } = await import('../server/lib/template.js');
  const { pitchFor } = await import('../server/lib/pitch-match.js');
  const opener = STARTERS.find((s) => s.name === 'First message — WhatsApp');
  const own = pitchFor('window cleaner');
  const r = renderTemplate(
    opener,
    { business_name: 'Barlows Window Services', location: 'Stoke-On-Trent', category: 'window cleaner' },
    { biz_name: 'keylo studios' },
    { name: 'javier aydogan' },
  );
  assert.equal(r.body, [
    "Hi, my name is Javier and I'm from Keylo Studios. I came across Barlows Window Services in Stoke-on-Trent and noticed you don't have a website yet, so I thought I'd get in touch.",
    '',
    own.pitch,
    '',
    "I'd be happy to put together a free mock up for Barlows Window Services so you can see how it could look, with no cost and no obligation.",
    '',
    'Would you like me to do that for you? No pressure at all.',
    '',
    own.close,
    'Javier, Keylo Studios',
  ].join('\n'));
});

test('the sales claim comes out of a saved opener, and nothing else changes', async () => {
  const { withoutSalesLine: out } = await import('../server/lib/starters.js');
  const line = 'Having a website is proven to boost sales by 40%.';
  // As shipped: a paragraph of its own, so the paragraph goes.
  assert.equal(
    out(`Hi, it is Karam.\n\nWe build sites.\n\n${line}\n\nFancy a free mock up? Just say.\n\nKaram`),
    'Hi, it is Karam.\n\nWe build sites.\n\nFancy a free mock up? Just say.\n\nKaram',
  );
  // Written into someone's own paragraph: their words stay.
  assert.equal(out(`We build sites. ${line} Honestly.`), 'We build sites. Honestly.');
  assert.equal(out(`We build sites.\n${line}\nFancy one?`), 'We build sites.\nFancy one?');
  // However it was edited, the whole sentence goes and nothing is left of it.
  assert.equal(out('A\n\nHaving a website is proven to boost sales by 40%!\n\nB'), 'A\n\nB');
  assert.equal(out(`A\n\n${line} 📈\n\nB`), 'A\n\nB');
  assert.equal(out(`• ${line}\n• Second point.`), '• Second point.');
  assert.equal(out("Hi.\n\nHaving a website is proven to boost sales by 40%, so let's talk.\n\nBye"), 'Hi.\n\nBye');
  assert.equal(out('Did you know having a website is proven to boost sales by 40%? Mad.'), 'Mad.');
  assert.equal(out(`Hi.\n\n${line}\n${line} ${line}\n\nBye`), 'Hi.\n\nBye', 'every copy');
  assert.equal(out(`It is 4.5 stars. ${line} Honest.`), 'It is 4.5 stars. Honest.');
  // Nothing to take out: left exactly as it is, spacing and all.
  const plain = 'Hi.\n\n  Spaced   as they like.\n\n\n\nKaram 4.5 stars!!';
  assert.equal(out(plain), plain);
  assert.equal(out(`A\n\n${line}\n\nB\n\n\n\nC`), 'A\n\nB\n\n\n\nC', 'blank lines elsewhere are theirs');
});

test('one WhatsApp opener, with a different middle for every kind of business', async () => {
  const { renderTemplate } = await import('../server/lib/template.js');
  const opener = (await get('/api/templates')).body.templates
    .find((t) => t.name === 'First message — WhatsApp');
  assert.ok(opener, 'the opener is seeded');
  const as = (category) => renderTemplate(opener,
    { business_name: 'Test Business', location: 'Leeds', category }, { biz_name: 'Keylo Studios' },
    { name: 'Cailan Jassal' }).body;
  const bodies = ['roofers', 'dog groomers', 'dog walker', 'barbers', 'cafe', 'locksmith',
    'window cleaner', 'garage', 'accountant'].map(as);
  assert.equal(new Set(bodies).size, bodies.length, 'each business reads differently');
  for (const b of bodies) {
    assert.match(b, /That's exactly what we build/);
    assert.ok(!/we build simple|\bsimple\b/i.test(b), 'never "simple"');
    assert.ok(!b.includes('Jassal'), 'first name only');
    assert.ok(!/\{\{/.test(b), 'nothing left unfilled');
  }
});

test('the sector copies of the opener are retired', async () => {
  const names = (await get('/api/templates')).body.templates.map((t) => t.name);
  assert.ok(!names.some((n) => /First message — WhatsApp ·/.test(n)));
});

test('a saved sector copy is removed only if nobody edited it', async () => {
  const { RETIRED_OPENERS, withTradePitch } = await import('../server/lib/starters.js');
  const trades = RETIRED_OPENERS['First message — WhatsApp · Trades'];
  const converted = withTradePitch(trades);
  assert.match(converted, /\{\{trade_pitch\}\}/);
  assert.match(converted, /\{\{trade_close\}\}\n\{\{my_name\}\}, \{\{my_business\}\}$/);
  const edited = trades.replace('Cheers, and all the best with the work.', 'Speak soon.');
  assert.ok(withTradePitch(edited).includes('Speak soon.'), 'an edited sign-off is kept');
});

test('saved openers are brought up to date, but an edited paragraph is kept', async () => {
  const { withNewWording, withShortClose } = await import('../server/lib/starters.js');
  const old = [
    "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} while looking around {{location}} and noticed you don't have a website yet, so I thought I'd reach out and say hello.",
    'We build simple, great looking one page websites for local businesses. Just a clear page with what you do, a few photos, and a button so people can call or message you straight from their phone.',
    'My own paragraph that I wrote myself.',
    "Would that be something you'd like me to do for you? No pressure at all, and if it's not for you, just say and I won't message again.",
  ].join('\n\n');
  const now = withNewWording(withShortClose(old));
  assert.ok(!now.includes('We build simple'));
  assert.ok(!now.includes('say hello'));
  assert.ok(now.includes('My own paragraph that I wrote myself.'), 'their edit stays');
  assert.ok(now.endsWith('Would you like me to do that for you? No pressure at all.'));
});

test('"I won\'t message again" comes out of every saved template, and nothing else does', async () => {
  const { withoutNoMessageAgain } = await import('../server/lib/starters.js');
  const cases = [
    ["Would you like me to do that for you? No pressure at all, and if it's not for you, just say and I won't message again.",
      'Would you like me to do that for you? No pressure at all.'],
    ["Hi, I'm {{my_name}} from {{my_business}}. I came across {{business}} and noticed you don't have a website yet, and I'd be happy to build you a free one page mock up to look at, with no obligation. Would you like me to put one together? If it's not for you, just say and I won't message again.",
      "Hi, I'm {{my_name}} from {{my_business}}. I came across {{business}} and noticed you don't have a website yet, and I'd be happy to build you a free one page mock up to look at, with no obligation. Would you like me to put one together? No pressure at all."],
    ["Would you like one?\n\n(If now isn't the right time or it's not for you, no worries at all, just let me know and I won't message again.)\n\nCheers,\n{{my_name}}",
      'Would you like one?\n\nCheers,\n{{my_name}}'],
    ['Hi, is this {{business}}? I build sites. Reply STOP and I won’t text again.', 'Hi, is this {{business}}? I build sites.'],
    ['Fancy a chat? Honestly, I won’t message you again after this. Cheers', 'Fancy a chat? Cheers'],
  ];
  for (const [before, after] of cases) assert.equal(withoutNoMessageAgain(before), after, before);
  const untouched = 'Hi {{business}}, a free mock up? No pressure at all.\n\nThanks,\n{{my_name}}';
  assert.equal(withoutNoMessageAgain(untouched), untouched);
});

test('the email footer asks them to reply, without "I won\'t write again"', async () => {
  const { DEFAULT_OPTOUT_LINE } = await import('../server/lib/compliance.js');
  assert.equal(DEFAULT_OPTOUT_LINE, "If this isn't something you'd find useful, just reply and let me know.");
  assert.ok(!/again/i.test(DEFAULT_OPTOUT_LINE));
});

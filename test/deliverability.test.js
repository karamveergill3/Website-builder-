import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDraft } from '../server/lib/deliverability.js';
import { checkAddress, domainOf } from '../server/lib/addresses.js';

const GOOD = {
  subject: 'Website for Hillside Roofing?',
  body: `Hi,

I was looking for roofers in Otley and came across Hillside Roofing, but couldn't find a website for you.

I build simple one-page sites for local trades — what you do, the areas you cover, a few photos, and a button that dials you straight from a phone.

Happy to mock something up so you can see it, free and no obligation. Worth a look?

Best,
Karamveer`,
};

/* ------------------------------- draft scoring ---------------------------- */

test('a well-formed cold email scores clean', () => {
  const r = scoreDraft(GOOD);
  assert.equal(r.level, 'ok');
  assert.equal(r.blocked, false);
  assert.deepEqual(r.checks, []);
});

test('a plain greeting is not mistaken for a broken mail merge', () => {
  // "Hi," on its own line is deliberate; "Hi ," is a placeholder that
  // rendered empty. Only the second should fire.
  assert.equal(scoreDraft({ subject: 'x y z', body: `Hi,\n\n${'word '.repeat(60)}` }).checks.length, 0);
  const merged = scoreDraft({ subject: 'x y z', body: `Hi ,\n\n${'word '.repeat(60)}` });
  assert.match(merged.checks[0].title, /mail merge/);
});

test('an unfilled placeholder blocks the send outright', () => {
  const r = scoreDraft({ subject: 'Website for {{business}}?', body: GOOD.body });
  assert.equal(r.blocked, true);
  assert.ok(r.checks.some((c) => /placeholder/i.test(c.title)));
});

test('links are the thing it weighs hardest', () => {
  const one = scoreDraft({ ...GOOD, body: `${GOOD.body}\n\nhttps://example.co.uk` });
  assert.equal(one.level, 'ok', 'one link is fine');

  const two = scoreDraft({ ...GOOD, body: `${GOOD.body}\n\nhttps://a.co.uk https://b.co.uk` });
  assert.equal(two.blocked, false);
  assert.ok(two.checks.some((c) => /Two links/.test(c.title)));

  const three = scoreDraft({ ...GOOD, body: `${GOOD.body}\n\nhttps://a.co.uk https://b.co.uk https://c.co.uk` });
  assert.equal(three.blocked, true);
});

test('a URL shortener blocks the send', () => {
  const r = scoreDraft({ ...GOOD, body: `${GOOD.body}\n\nhttps://bit.ly/abc` });
  assert.equal(r.blocked, true);
  assert.ok(r.checks.some((c) => /shortener/i.test(c.title)));
  assert.deepEqual(r.stats.link_hosts, ['bit.ly']);
});

test('a subject faking a reply is blocked', () => {
  for (const subject of ['Re: our chat', 'RE: quote', 'Fwd: this', 'fw: hello']) {
    const r = scoreDraft({ ...GOOD, subject });
    assert.equal(r.blocked, true, `${subject} should be blocked`);
  }
  assert.equal(scoreDraft({ ...GOOD, subject: 'Rethinking your website' }).blocked, false,
    'a word merely starting with "re" is fine');
});

test('images and markup are caught in a plain-text message', () => {
  assert.equal(scoreDraft({ ...GOOD, body: `${GOOD.body}<img src="x">` }).blocked, true);
  assert.ok(scoreDraft({ ...GOOD, body: `<div>${GOOD.body}</div>` })
    .checks.some((c) => /HTML/i.test(c.title)));
});

test('message length is judged against reply rate, not spam folklore', () => {
  assert.ok(scoreDraft({ ...GOOD, body: 'Hi. Want a website? Call me.' })
    .checks.some((c) => /short/i.test(c.title)));
  assert.ok(scoreDraft({ ...GOOD, body: 'word '.repeat(260) })
    .checks.some((c) => /Long/i.test(c.title)));
  assert.equal(scoreDraft(GOOD).stats.body_words > 50, true);
});

test('bulk-mail furniture is flagged', () => {
  for (const junk of ['View in browser', 'Unsubscribe | Preferences', 'Click here to book',
                      'You are receiving this email because you subscribed']) {
    const r = scoreDraft({ ...GOOD, body: `${GOOD.body}\n\n${junk}` });
    assert.ok(r.checks.length > 0, `${junk} should be noticed`);
  }
});

test('shouting is a warning, never a block', () => {
  const r = scoreDraft({ ...GOOD, body: GOOD.body.replace('Happy to mock', 'LIMITED TIME OFFER — mock') });
  assert.equal(r.blocked, false);
  assert.ok(r.checks.some((c) => /capitals/i.test(c.title)));
});

test('ordinary UK business acronyms are not mistaken for shouting', () => {
  const r = scoreDraft({ ...GOOD, body: GOOD.body.replace('Best,', 'VAT and LLP and CIC details on request.\n\nBest,') });
  assert.equal(r.checks.some((c) => /capitals/i.test(c.title)), false);
});

test('an empty subject or body is blocked', () => {
  assert.equal(scoreDraft({ subject: '', body: GOOD.body }).blocked, true);
  assert.equal(scoreDraft({ subject: 'hello there', body: '' }).blocked, true);
});

/* ----------------------------- address checking --------------------------- */

test('rubbish addresses are rejected without a DNS lookup', async () => {
  for (const bad of ['', '   ', 'not-an-email', 'a@b', 'two@@ats.com', 'has space@x.com']) {
    const r = await checkAddress(bad, { dns: false });
    assert.equal(r.level, 'bad', `${JSON.stringify(bad)} should be rejected`);
  }
});

test('a common domain typo is caught and corrected', async () => {
  const r = await checkAddress('dave@gmial.com', { dns: false });
  assert.equal(r.level, 'bad');
  assert.equal(r.suggestion, 'dave@gmail.com');
});

test('throwaway mailbox providers are rejected', async () => {
  assert.equal((await checkAddress('x@mailinator.com', { dns: false })).level, 'bad');
  assert.equal((await checkAddress('x@yopmail.com', { dns: false })).level, 'bad');
});

test('a normal business address passes the offline checks', async () => {
  const r = await checkAddress('info@hillsideroofing.co.uk', { dns: false });
  assert.equal(r.level, 'ok');
  assert.equal(r.domain, 'hillsideroofing.co.uk');
});

test('domainOf normalises case and whitespace', () => {
  assert.equal(domainOf('  Info@Example.CO.UK '), 'example.co.uk');
  assert.equal(domainOf('nonsense'), '');
});

test('a domain that does not resolve is rejected', async (t) => {
  const r = await checkAddress('info@this-domain-does-not-exist-9f3a2b.co.uk');
  if (r.level === 'warn') return t.skip('no DNS available in this environment');
  assert.equal(r.level, 'bad');
  assert.match(r.reason, /does not resolve|no mail server/i);
});

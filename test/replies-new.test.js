/**
 * Every reply comes onto the Replies tab, and each of the team sees how many
 * are new to them.
 *
 *   - a pasted WhatsApp reply is listed on Replies straight away
 *   - the count of new replies is per person, and opening Replies clears
 *     only your own
 *   - the scheduler's Gmail check stands down while Gmail isn't connected
 *   - a reply is listed once, however many times its mock up was rebuilt
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OLLAMA_HOST = '127.0.0.1:1';

const { get, post, raw, teardown, nextCompanyNumber } = await import('./helpers.js');
const { db } = await import('../server/db.js');
const { checkForReplies, listReplies } = await import('../server/lib/replies.js');

test.after(teardown);

async function lead(name, phone) {
  const r = await post('/api/leads', {
    business_name: name, location: 'Stone', phone, entity_type: 'corporate',
    company_number: nextCompanyNumber(), category: 'architect',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const prep = await post('/api/outreach/prepare', { lead_id: r.body.lead.id, channel: 'whatsapp', text: 'Hi there' });
  await post(`/api/outreach/${prep.body.event_id}/sent`, {});
  return r.body.lead;
}

/** Signed in as someone else, with their own cookie. */
async function asColleague() {
  await post('/api/auth/users', { name: 'Cailan Jassal', email: 'cailan@test.example', password: 'test-pass-123' });
  const login = await raw('POST', '/api/auth/login', { email: 'cailan@test.example', password: 'test-pass-123' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
}

test('a pasted WhatsApp reply is on the Replies tab straight away', async () => {
  const l = await lead('Stitch Architecture', '07700 930001');
  const r = await post('/api/replies/whatsapp-paste', {
    text: '[10:00, 18/06/2025] +44 7700 930001: Thanks for the offer but I’m already engaged with a developer.',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const listed = (await get('/api/replies')).body.replies.find((x) => x.id === r.body.reply_id);
  assert.ok(listed, 'listed on Replies');
  assert.equal(listed.channel, 'whatsapp');
  assert.equal(listed.lead_id, l.id);
  assert.ok(listed.fetched_at);
  assert.equal(listed.intent, 'elsewhere', 'a turn-down, so no build tools on it');
});

test('the count of new replies is yours: opening Replies clears it, and only for you', async () => {
  await post('/api/replies/seen', {});
  assert.equal((await get('/api/replies/unseen')).body.count, 0);

  await lead('Reynolds John Ltd', '07700 930002');
  await post('/api/replies/whatsapp-paste', { text: '[11:00, 18/06/2025] +44 7700 930002: Yes please' });
  assert.equal((await get('/api/replies/unseen')).body.count, 1);

  const before = (await post('/api/replies/seen', {})).body.before;
  assert.ok(before, 'says when you last looked, so the screen can mark what is new');
  assert.equal((await get('/api/replies/unseen')).body.count, 0);

  // A colleague who has never opened Replies still has theirs to see.
  const created = db.prepare('SELECT COUNT(*) AS n FROM replies').get().n;
  await asColleague();
  db.prepare("UPDATE users SET created_at = '2000-01-01T00:00:00.000Z' WHERE email = 'cailan@test.example'").run();
  assert.equal((await get('/api/replies/unseen')).body.count, created);
});

test('the scheduler’s Gmail check stands down while Gmail is not connected', async () => {
  const out = await checkForReplies();
  assert.equal(out.skipped, true);
});

test('a reply is listed once, however many times its mock up was rebuilt', async () => {
  const l = await lead('Rebuilt Twice Ltd', '07700 930003');
  const r = await post('/api/replies/whatsapp-paste', {
    text: '[12:00, 18/06/2025] +44 7700 930003: 1. Rebuilt Twice\n2. Ring us\n3. Stone and Stafford',
  });
  const brief = db.prepare('SELECT id FROM briefs WHERE reply_id = ?').get(r.body.reply_id);
  assert.ok(brief, 'the reply was read into a brief');
  const add = db.prepare(
    `INSERT INTO mockups (lead_id, brief_id, token, business_name, pages, generated_at)
     VALUES (?, ?, ?, 'Rebuilt Twice Ltd', '["home"]', ?)`
  );
  add.run(l.id, brief.id, `t1-${l.id}`, '2025-06-18T12:01:00.000Z');
  add.run(l.id, brief.id, `t2-${l.id}`, '2025-06-18T12:02:00.000Z');
  const rows = listReplies({ leadId: l.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mockup.token, `t2-${l.id}`, 'the latest build');
});

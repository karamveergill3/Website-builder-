/**
 * Sharing the daily hunt out across the team (5 each of 15, say).
 *
 * The hunt round-robins its finds to whichever active rep is holding the
 * fewest un-worked leads, so an empty board deals evenly and nobody on
 * holiday gets buried. A lead added by hand belongs to whoever added it, and
 * any lead can be reassigned. These prove the assignment logic and the routes
 * that surface and change it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { get, post, patch, teardown } = await import('./helpers.js');
const { db } = await import('../server/db.js');
const { nextAssignee, rotationUserIds } = await import('../server/lib/assign.js');

// helpers.js already created and signed in one admin. Add two reps.
const admin = (await get('/api/auth/me')).body.user;
await post('/api/auth/users', { email: 'bea@test.example', name: 'Bea', password: 'test-pass-123', role: 'rep' });
await post('/api/auth/users', { email: 'cy@test.example',  name: 'Cy',  password: 'test-pass-123', role: 'rep' });
const users = (await get('/api/auth/users')).body.users;
const bea = users.find((u) => u.email === 'bea@test.example').id;
const cy  = users.find((u) => u.email === 'cy@test.example').id;

const clearLeads = () => db.prepare('DELETE FROM leads').run();
const seedNew = (assignee) => db.prepare(
  "INSERT INTO leads (business_name, status, assigned_to, created_at) VALUES ('X', 'new', ?, ?)"
).run(assignee, new Date().toISOString());

test('the rotation is every active user, lowest id first', () => {
  assert.deepEqual(rotationUserIds(), [admin.id, bea, cy].sort((a, b) => a - b));
});

test('nextAssignee deals evenly across an empty board', () => {
  clearLeads();
  assert.equal(nextAssignee(), admin.id, 'first goes to the lowest id');
  seedNew(admin.id);
  assert.equal(nextAssignee(), bea, 'then the next emptiest');
  seedNew(bea);
  assert.equal(nextAssignee(), cy);
  seedNew(cy);
  assert.equal(nextAssignee(), admin.id, 'and back round — 5/5/5 over fifteen');
});

test('nextAssignee tops up whoever is emptiest, not a rigid rota', () => {
  clearLeads();
  seedNew(bea); seedNew(bea); // Bea already has two on her plate
  // admin and cy have none, admin is lower — so the next one is the admin's.
  assert.equal(nextAssignee(), admin.id);
});

test('worked leads do not count against a rep', () => {
  clearLeads();
  // A lead the rep has already moved on ('sent') should not keep them loaded.
  db.prepare("INSERT INTO leads (business_name, status, assigned_to, created_at) VALUES ('X','sent',?,?)")
    .run(admin.id, new Date().toISOString());
  seedNew(bea);
  seedNew(cy);
  assert.equal(nextAssignee(), admin.id, 'the sent lead is off the admin plate');
});

test('a suspended rep drops out of the rotation', async () => {
  await patch(`/api/auth/users/${cy}`, { active: false });
  assert.ok(!rotationUserIds().includes(cy));
  clearLeads();
  seedNew(admin.id); seedNew(bea); // both active reps at one
  assert.notEqual(nextAssignee(), cy, 'never a suspended user');
  await patch(`/api/auth/users/${cy}`, { active: true }); // restore for later tests
});

test('a lead added by hand belongs to whoever added it', async () => {
  clearLeads();
  const res = await post('/api/leads', { business_name: 'Hand Made Ltd' });
  assert.equal(res.body.lead.assigned_to, admin.id, 'the admin is signed in here');
});

test('the owner filter selects mine, unassigned and a named rep', async () => {
  clearLeads();
  const mine = (await post('/api/leads', { business_name: 'Mine Ltd' })).body.lead;      // -> admin
  const hers = (await post('/api/leads', { business_name: 'Hers Ltd' })).body.lead;
  await patch(`/api/leads/${hers.id}`, { assigned_to: bea });
  db.prepare("INSERT INTO leads (business_name, status, created_at) VALUES ('Nobody Ltd','new',?)")
    .run(new Date().toISOString());

  const mineList = (await get('/api/leads?assigned_to=me')).body.leads;
  assert.deepEqual(mineList.map((l) => l.business_name).sort(), ['Mine Ltd']);

  const beaList = (await get(`/api/leads?assigned_to=${bea}`)).body.leads;
  assert.deepEqual(beaList.map((l) => l.business_name), ['Hers Ltd']);

  const none = (await get('/api/leads?assigned_to=none')).body.leads;
  assert.deepEqual(none.map((l) => l.business_name), ['Nobody Ltd']);
  assert.equal(mine.assigned_to, admin.id);
});

test('bulk-assign hands a batch to a rep, and null unassigns', async () => {
  clearLeads();
  const a = (await post('/api/leads', { business_name: 'A Ltd' })).body.lead;
  const b = (await post('/api/leads', { business_name: 'B Ltd' })).body.lead;

  await post('/api/leads/bulk-assign', { ids: [a.id, b.id], assigned_to: cy });
  assert.equal((await get(`/api/leads?assigned_to=${cy}`)).body.leads.length, 2);

  await post('/api/leads/bulk-assign', { ids: [a.id], assigned_to: null });
  assert.equal((await get('/api/leads?assigned_to=none')).body.leads.length, 1);
});

test('reassigning to a non-existent user is refused', async () => {
  const lead = (await post('/api/leads', { business_name: 'Z Ltd' })).body.lead;
  const res = await patch(`/api/leads/${lead.id}`, { assigned_to: 999999 });
  assert.equal(res.status, 400);
});

test('stats break the day down per rep', async () => {
  clearLeads();
  await post('/api/leads', { business_name: 'One Ltd' });   // -> admin
  const two = (await post('/api/leads', { business_name: 'Two Ltd' })).body.lead;
  await patch(`/api/leads/${two.id}`, { assigned_to: bea });

  const { by_assignee_today } = (await get('/api/leads/stats')).body;
  assert.equal(by_assignee_today[String(admin.id)], 1);
  assert.equal(by_assignee_today[String(bea)], 1);
});

test('the roster is readable by any signed-in rep', async () => {
  const { roster } = (await get('/api/auth/roster')).body;
  assert.ok(roster.find((u) => u.id === admin.id && u.name === admin.name));
  assert.ok(roster.every((u) => !('email' in u)), 'no emails leak through the roster');
});

test.after(() => teardown());

/**
 * What a prospect's reply means, held to a few hundred real-sounding ones.
 *
 * The draft back depends on it: a turn-down read as anything else gets an
 * offer of a mock up in reply to "I don't want a website", which is the one
 * mistake that makes the rep look like they didn't read the message. So a
 * decline must never be read as a yes, a price question, answers or "not
 * sure", and every "stop" must be caught. The rest may miss now and then
 * (the rep reads every draft), but not often.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { classifyReply, draftReply } = await import('../server/lib/reply-draft.js');
const { extractByRules } = await import('../server/lib/brief.js');
const { ASK_DEFAULTS } = await import('../server/lib/ask.js');

const REPLIES = JSON.parse(readFileSync(new URL('./fixtures/replies.json', import.meta.url), 'utf8'));
const LEAD = { business_name: 'Perfect Paws', location: 'Burton', category: 'dog groomer' };
const read = (text) => classifyReply(text, extractByRules(text, LEAD), LEAD);
const DECLINES = ['stop', 'no', 'elsewhere', 'has_site'];

test('the word of mouth, fully booked, had one before turn-down is a no, and the answer is a polite close', () => {
  const body = "Thanks I get business through word of mouth and am fully booked. Don't want a web site. I had one before.";
  assert.equal(read(body), 'no');
  const d = draftReply({
    body, brief: extractByRules(body, LEAD), lead: LEAD, sender: 'Karam', ask: ASK_DEFAULTS, prices: { from: 300, monthly: 12 },
  });
  assert.equal(d.intent, 'no');
  assert.doesNotMatch(d.text, /mock ?up|free|build|\?/i, 'no offer, no questions');
  assert.match(d.text, /no problem/i);
});

test('every "stop" is caught', () => {
  const missed = REPLIES.filter((r) => r.intent === 'stop' && read(r.text) !== 'stop').map((r) => r.text);
  assert.deepEqual(missed, []);
});

test('no turn-down is read as a yes, a price question, answers or "not sure"', () => {
  const wrong = REPLIES
    .filter((r) => DECLINES.includes(r.intent))
    .map((r) => ({ text: r.text, want: r.intent, got: read(r.text) }))
    .filter((r) => !DECLINES.includes(r.got));
  assert.deepEqual(wrong, []);
});

test('nothing that isn’t a stop is read as one', () => {
  const wrong = REPLIES.filter((r) => r.intent !== 'stop' && read(r.text) === 'stop').map((r) => r.text);
  assert.deepEqual(wrong, []);
});

test('each kind of reply is read right nearly every time', () => {
  const byIntent = {};
  for (const r of REPLIES) {
    const tally = (byIntent[r.intent] ??= { right: 0, total: 0, misses: [] });
    tally.total += 1;
    const got = read(r.text);
    if (got === r.intent) tally.right += 1;
    else tally.misses.push(`${got}: ${r.text}`);
  }
  let right = 0;
  for (const [intent, t] of Object.entries(byIntent)) {
    right += t.right;
    assert.ok(t.right / t.total >= 0.85, `${intent}: ${t.right}/${t.total}\n${t.misses.join('\n')}`);
  }
  assert.ok(right / REPLIES.length >= 0.97, `${right}/${REPLIES.length} overall`);
});

/**
 * Replies, briefs and generated mockups.
 *
 *   GET    /api/replies                 what has come back, with briefs
 *   POST   /api/replies/sync            pull new replies from Gmail
 *   POST   /api/replies/manual          record a reply that came another way
 *   POST   /api/replies/whatsapp-read   read a WhatsApp paste: whose, and the answer
 *   POST   /api/replies/whatsapp-paste  file messages copied out of WhatsApp
 *   POST   /api/replies/:id/extract     re-run the brief extractor
 *   PATCH  /api/replies/:id/brief       user corrections to the brief
 *   POST   /api/replies/:id/read        mark as read
 *   DELETE /api/replies/:id             take a reply off
 *   POST   /api/replies/:id/reply        send a reply via Resend
 *   POST   /api/mockups                 generate a site from a brief
 *   GET    /api/mockups                 list generated mockups
 *   POST   /api/mockups/:id/sent        record that the link was sent
 *   GET    /api/ollama                  is the local model there?
 */

import { Router } from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { wrap, badRequest, notFound, conflict, nowIso, str, int } from '../lib/http.js';
import {
  syncReplies, extractBriefFor, listReplies, markRead, recordManualReply,
  readiness, briefToApi, insertReply,
} from '../lib/replies.js';
import {
  configured as resendConfigured, sendEmail as resendSend,
} from '../lib/resend.js';
import { getUserById } from '../lib/auth.js';
import { sendingDomain } from '../lib/sending-policy.js';
import { looksLikeEmail } from '../lib/http.js';
import { renderSite, writeSite, newToken, PAGES, SINGLE_PAGE } from '../lib/site-builder.js';
import { briefForBuild, CTAS, extractByRules } from '../lib/brief.js';
import { available as ollamaAvailable, model as ollamaModel } from '../lib/ollama.js';
import { getSetting, getSettings } from '../db.js';
import { draftReply, classifyReply } from '../lib/reply-draft.js';
import { askQuestions } from '../lib/ask.js';
import { leadVoice } from '../lib/auth.js';
import { senderContext, firstName } from '../lib/template.js';
import { normalisePhone } from '../lib/handoff.js';
import { suppress } from '../lib/suppression.js';
import { recordContact } from '../lib/recontact.js';
import {
  parseWhatsApp, theirSide, fingerprint, textKey, senderKey, senderPhone, nameFit, nameWords,
} from '../lib/wa-paste.js';

/** The starting prices the "how much?" answer quotes, from the Prices screen. */
function startingPrices() {
  let list = null;
  try { list = JSON.parse(getSetting('price_list_json', 'null')); } catch { /* defaults */ }
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  // The Prices screen's own defaults: a one-page site, and the cheapest plan.
  return { from: n(list?.pages?.one_page, 300), monthly: n(list?.monthly?.keep_it_live, 12) };
}

/**
 * The drafted answer to one reply, with what the screen needs to send it:
 * the WhatsApp number it came from, and a built mock up's link.
 */
function draftFor(replyId, { user = null, origin = null, kind = null } = {}) {
  const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(replyId);
  if (!reply) throw notFound('Reply not found');
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(reply.lead_id);
  if (!lead) throw notFound('Lead not found');
  const brief = briefToApi(db.prepare('SELECT * FROM briefs WHERE reply_id = ?').get(replyId)) ?? {};
  // A reply pasted from WhatsApp knows the number it came from: answer that
  // chat, even when it is not the number the first message went to.
  const cameFrom = reply.channel === 'whatsapp' && /^\+\d{8,15}$/.test(reply.thread_id ?? '')
    ? reply.thread_id : null;
  return { ...composeDraft({ lead, body: reply.body, brief, user, origin, kind, cameFrom }), reply_id: reply.id };
}

/**
 * The drafted answer to `body` from `lead`, whether or not it has been filed
 * yet (the paste box shows it before anything is saved).
 */
function composeDraft({ lead, body, brief = {}, user = null, origin = null, kind = null, cameFrom = null }) {
  const mockup = db.prepare(
    'SELECT token FROM mockups WHERE lead_id = ? AND error IS NULL ORDER BY generated_at DESC LIMIT 1'
  ).get(lead.id);
  const base = /^https?:\/\/[^/\s]+$/i.test(String(origin ?? '')) ? origin : '';
  const sentTo = db.prepare(
    `SELECT recipient FROM outreach_events WHERE lead_id = ? AND channel = 'whatsapp'
      ORDER BY COALESCE(confirmed_sent_at, prepared_at) DESC LIMIT 1`
  ).get(lead.id)?.recipient;
  const phone = normalisePhone(sentTo ?? lead.phone ?? '');

  const draft = draftReply({
    body,
    brief,
    lead,
    sender: senderContext(undefined, leadVoice(lead, user)).my_name,
    ask: askQuestions(),
    prices: startingPrices(),
    mockupUrl: mockup ? `${base}/m/${mockup.token}/` : null,
    kind,
  });
  return {
    ...draft,
    reply_id: null,
    lead_id: lead.id,
    business_name: lead.business_name,
    wa_number: cameFrom ? cameFrom.slice(1) : (phone.ok ? phone.e164.replace(/^\+/, '') : null),
    has_mockup: Boolean(mockup),
  };
}

/**
 * They asked not to be contacted: honoured at once, the same way marking a
 * lead opted out does it, so no rep and no hunt offers them again.
 */
function optOut(lead) {
  db.prepare("UPDATE leads SET opted_out = 1, status = 'lost' WHERE id = ?").run(lead.id);
  if (lead.email) suppress(lead.email, { businessName: lead.business_name, reason: 'asked to stop' });
  recordContact(lead, 'opted out');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MOCKUP_ROOT = resolve(__dirname, '..', '..', 'data', 'mockups');

const router = Router();

/* ------------------------------------------------------------- replies */

router.get('/replies', wrap((req, res) => {
  res.json({
    replies: listReplies({
      limit: int(req.query.limit) ?? 50,
      leadId: int(req.query.lead_id),
      unreadOnly: req.query.unread === '1',
    }),
    gmail: readiness(),
  });
}));

router.post('/replies/sync', wrap(async (req, res) => {
  const out = await syncReplies({
    sinceDays: int(req.body?.since_days) ?? 30,
    max: Math.min(100, int(req.body?.max) ?? 50),
  });
  res.status(out.ok ? 200 : 422).json(out);
}));

router.post('/replies/manual', wrap(async (req, res) => {
  const leadId = int(req.body?.lead_id);
  const body = str(req.body?.body);
  if (!leadId) throw badRequest('lead_id is required');
  if (!body) throw badRequest('body is required — paste what they wrote back');

  const channel = str(req.body?.channel) ?? 'manual';
  if (!['manual', 'whatsapp', 'sms', 'email'].includes(channel)) {
    throw badRequest('channel must be manual, whatsapp, sms or email');
  }

  const out = await recordManualReply({
    leadId, body, channel, subject: str(req.body?.subject),
  });
  // The answer back, drafted from what they said. A "stop" is acted on here
  // and now, before anyone can reply to it.
  const draft = draftFor(out.replyId, { user: req.user, origin: str(req.body?.origin) });
  if (draft.intent === 'stop') optOut(db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId));
  res.status(201).json({
    reply_id: out.replyId,
    brief: out.brief,
    draft,
    replies: listReplies({ leadId }),
  });
}));

/* ------------------------------------------- pasted out of WhatsApp */

/**
 * Tells our side of a pasted chat from theirs: the team's names (full and
 * first) and phones, and the business name and number from Settings, which
 * is what a WhatsApp Business account signs its messages with.
 */
function ourSide() {
  const names = new Set(['you']);
  const phones = new Set();
  const name = (v) => { const n = String(v ?? '').trim().toLowerCase(); if (n) names.add(n); };
  const phone = (v) => { const p = senderPhone(v); if (p) phones.add(p); };
  for (const u of db.prepare('SELECT name, phone FROM users').all()) {
    name(u.name); name(firstName(u.name)); phone(u.phone);
  }
  const s = getSettings();
  name(s.biz_name); name(s.biz_contact_name); name(firstName(s.biz_contact_name)); phone(s.biz_phone);
  return (m) => (m.phone ? phones.has(m.phone) : names.has(String(m.sender ?? '').trim().toLowerCase()));
}

/**
 * The leads a WhatsApp number belongs to, best first: the number a WhatsApp
 * actually went to, then a lead's own phone, then a number the finder or a
 * rep filed against it (never one lifted from a directory page, which lists
 * other firms' numbers too).
 */
function leadsForNumber(e164) {
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  for (const r of db.prepare(
    `SELECT lead_id FROM outreach_events
      WHERE channel = 'whatsapp' AND recipient = ? AND lead_id IS NOT NULL
      ORDER BY confirmed_sent_at IS NULL, COALESCE(confirmed_sent_at, prepared_at) DESC`
  ).all(e164)) add(r.lead_id);
  const sent = ids.length;
  for (const r of db.prepare("SELECT id, phone FROM leads WHERE phone IS NOT NULL AND TRIM(phone) <> ''").all()) {
    if (normalisePhone(r.phone).e164 === e164) add(r.id);
  }
  for (const r of db.prepare(
    `SELECT lead_id FROM contact_signals
      WHERE kind IN ('phone', 'whatsapp') AND value = ?
        AND (promoted_at IS NOT NULL
             OR source IN ('places', 'lead:existing', 'user:manual', 'website', 'website:wa'))
      ORDER BY confidence DESC`
  ).all(e164)) add(r.lead_id);
  return { ids, sent };
}

/** A lead as the "whose reply is this?" list shows it, grouped by owner. */
const candidate = (row, fit = null) => ({
  id: row.id,
  business_name: row.business_name,
  location: row.location,
  status: row.status,
  whatsapp_sent_at: row.wa_at ?? null,
  owner_id: row.assigned_to ?? null,
  owner: row.owner_name ? firstName(row.owner_name) : null,
  fit,
});

const CANDIDATE_SQL = `SELECT l.*, u.name AS owner_name,
  (SELECT MAX(oe.confirmed_sent_at) FROM outreach_events oe
    WHERE oe.lead_id = l.id AND oe.channel = 'whatsapp') AS wa_at
  FROM leads l LEFT JOIN users u ON u.id = l.assigned_to`;

/**
 * Everyone messaged on WhatsApp, the ones a reply is likeliest from first:
 * awaiting a reply, then replied, then won, then lost; newest send first.
 */
const whatsappLeads = () => db.prepare(
  `${CANDIDATE_SQL} WHERE EXISTS (SELECT 1 FROM outreach_events oe WHERE oe.lead_id = l.id
     AND oe.channel = 'whatsapp' AND oe.confirmed_sent_at IS NOT NULL)
   ORDER BY CASE l.status WHEN 'sent' THEN 0 WHEN 'replied' THEN 1 WHEN 'new' THEN 2
                          WHEN 'won' THEN 3 ELSE 4 END, wa_at DESC LIMIT 500`
).all();

/**
 * Which business a message is from, going by what it says: its own name
 * ("Hi, it's Perfect Paws here"), or our first message quoted back ("I came
 * across Perfect Paws Burton Ltd in Burton"). Words many businesses share
 * ("hair", "building") count for little; a word only one of them has counts
 * for a lot. Null when nothing in it points anywhere.
 */
/** Words every reply is full of, which name no business however they are spelt. */
const CHAT_WORDS = new Set(`yes yeah yep no nope please thanks thank cheers ta hi hello hey here there go
  ahead ok okay sure great good fine lovely nice love like want need get got can could would will
  should you your we our us me my it its is are be do did done how much what when where who why
  this that with for from about just not now then time day week today tomorrow again one two
  right back sounds sound look looks send sent message mate sorry maybe later soon`.split(/\s+/));

function guessFromText(text, rows) {
  const words = new Set(nameWords(text).filter((w) => !CHAT_WORDS.has(w)));
  if (!words.size) return null;
  const flat = ` ${nameWords(text).join(' ')} `;
  const df = new Map();
  for (const row of rows) for (const w of new Set(nameWords(row.business_name))) df.set(w, (df.get(w) ?? 0) + 1);
  const weight = (w) => 1 / (df.get(w) ?? 1);
  let best = null;
  let second = 0;
  for (const row of rows) {
    const own = [...new Set(nameWords(row.business_name))];
    if (!own.length) continue;
    const hits = own.filter((w) => w.length >= 3 && words.has(w));
    if (!hits.length) continue;
    const whole = flat.includes(` ${nameWords(row.business_name).join(' ')} `);
    const distinctive = hits.some((w) => df.get(w) === 1);
    if (!whole && !distinctive) continue;
    const score = hits.reduce((n, w) => n + weight(w), 0) / own.reduce((n, w) => n + weight(w), 0)
      + (whole ? 1 : 0);
    if (!best || score > best.score) { second = best?.score ?? 0; best = { row, score, hits }; }
    else if (score > second) second = score;
  }
  if (!best || best.score < 0.5 || best.score - second < 0.2) return null;
  return best;
}

/**
 * Whose a paste is, and what in it is theirs. The paste's own sender number
 * settles it; failing that the rep's choice; failing that a guess (a saved
 * contact's name, what the message says, or the business most recently
 * messaged), which is only ever offered, never filed on its own.
 *
 *   how: 'chosen' | 'number' | 'several' | 'name' | 'text' | 'recent' | null
 */
function identify(text, { chosenId = null, userId = null, forced = null } = {}) {
  const chosen = chosenId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(chosenId) : null;
  if (chosenId && !chosen) throw notFound('Lead not found');

  const parsed = parseWhatsApp(text);
  if (!parsed.messages.length) throw badRequest('There is no message in that paste');
  const isUs = ourSide();

  // Everyone in the paste who is not us, with the leads their number is on.
  let people = [];
  for (const m of parsed.messages) {
    if (isUs(m) || people.some((p) => p.key === senderKey(m))) continue;
    people.push({ key: senderKey(m), sender: m.sender, phone: m.phone, found: m.phone ? leadsForNumber(m.phone) : null });
  }
  if (!people.length) throw badRequest('Those are all your own messages. Copy theirs too');

  // WhatsApp labels our own copied messages with our profile name, which can
  // be anything ("Kam", "Karam | Web"). When there are two named senders, the
  // one whose words are ours (our business name, or the opener we sent) is us.
  if (people.length > 1) {
    const ours = oursByWords();
    const lines = (key) => parsed.messages.filter((m) => senderKey(m) === key);
    const rest = people.filter((p) => !lines(p.key).some((m) => ours(m.text)));
    if (rest.length) people = rest;
  }
  // Still more than one: the rep can say which is them; otherwise a number
  // beats a name, a name that fits the chosen business beats one that
  // doesn't, and a reply being answered is the last thing in the paste.
  const last = parsed.messages[parsed.messages.length - 1];
  const rank = (p) => (forced && p.key === forced ? 16 : 0) + (p.phone ? 4 : 0)
    + (chosen && nameFit(p.sender, chosen.business_name) > 0 ? 2 : 0)
    + (last && senderKey(last) === p.key ? 1 : 0);
  people = [...people].sort((a, b) => rank(b) - rank(a));

  const matched = people.filter((p) => p.found?.ids.length);
  const byId = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  let who = null;
  let lead = null;
  let how = null;
  let why = null;

  let clash = [];
  if (chosen) {
    lead = chosen;
    how = 'chosen';
    // The person whose number is on that lead, else the likeliest in the paste.
    who = people.find((p) => p.found?.ids.includes(lead.id)) ?? people[0];
    // Their number is on other businesses and not this one: filed here, the
    // reply (and a "stop") would land on the wrong business.
    if (who.found?.ids.length && !who.found.ids.includes(lead.id)) clash = who.found.ids;
  } else if (matched.length === 1 && !(forced && people[0].key === forced && !people[0].found?.ids.length)) {
    who = matched[0];
    const { ids, sent } = who.found;
    lead = byId(ids[0]);
    // One lead, or the number a WhatsApp of ours actually went to: that is
    // the conversation. Several leads sharing a phone and no send: a guess.
    how = ids.length === 1 || sent > 0 ? 'number' : 'several';
    why = how === 'number'
      ? `Matched by their number, ${who.phone}`
      : 'That number is on more than one business. Check it is the right one';
  }

  const first = who ?? people[0];
  who = who ?? first;
  const theirs = theirSide(parsed.messages, (m) => senderKey(m) !== who.key).latest[who.key] ?? [];
  if (!theirs.length) throw badRequest('There is nothing from them in that paste');
  const theirText = theirs.map((m) => m.text).join('\n');

  const pool = whatsappLeads();
  let fit = null;
  if (!lead && !first.phone && parsed.headed && first.sender) {
    // Saved in the phone under a name: go by the name.
    const named = pool.map((row) => ({ row, f: nameFit(first.sender, row.business_name) }))
      .filter((x) => x.f >= 0.5).sort((a, b) => b.f - a.f)[0];
    if (named) {
      lead = byId(named.row.id); how = 'name'; fit = Math.round(named.f * 100);
      why = `They are saved in the phone as “${first.sender}”`;
    }
  }
  if (!lead) {
    // What they wrote, and anything of ours quoted in the paste, can name them.
    const guess = guessFromText(text, pool);
    if (guess) {
      lead = byId(guess.row.id); how = 'text';
      why = `The message mentions “${guess.hits.join(' ')}”`;
    }
  }
  if (!lead) {
    const recent = pool.find((r) => r.status === 'sent' && r.assigned_to === userId)
      ?? pool.find((r) => r.status === 'sent') ?? pool[0];
    if (recent) {
      lead = byId(recent.id); how = 'recent';
      why = 'A best guess: the business messaged most recently';
    }
  }

  // The list to choose from: the likeliest first, then everyone messaged.
  const candidates = [];
  const seen = new Set();
  const push = (row, f = null) => { if (row && !seen.has(row.id)) { seen.add(row.id); candidates.push(candidate(row, f)); } };
  if (lead) push(db.prepare(`${CANDIDATE_SQL} WHERE l.id = ?`).get(lead.id), fit);
  for (const p of matched) for (const id of p.found.ids) push(db.prepare(`${CANDIDATE_SQL} WHERE l.id = ?`).get(id));
  for (const row of pool) if (candidates.length < 80) push(row);

  return {
    parsed, people, matched, who, first, theirs, theirText, lead, how, why, candidates,
    clash: clash.map((id) => byId(id)).filter(Boolean),
    senders: people.map((p) => ({ key: p.key, name: p.phone ?? p.sender, chosen: p.key === who.key })),
    sure: how === 'chosen' || how === 'number',
  };
}

/**
 * Whether a message reads as ours: it names our business, or it is the start
 * of a WhatsApp we sent (the opener's first line, as prepared on Reach).
 */
function oursByWords() {
  const flat = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const biz = flat(getSettings().biz_name);
  const sent = db.prepare(
    `SELECT body_snapshot FROM outreach_events
      WHERE channel = 'whatsapp' AND body_snapshot IS NOT NULL
      ORDER BY id DESC LIMIT 300`
  ).all().map((r) => flat(r.body_snapshot).slice(0, 50)).filter((t) => t.length >= 25);
  return (text) => {
    const t = flat(text);
    return Boolean((biz.length >= 4 && t.includes(biz)) || sent.some((opening) => t.startsWith(opening)));
  };
}

/**
 * The earlier filing of this message, if it has been pasted before. With its
 * header, by its time and words, or by its words alone if it was pasted once
 * on its own after it was sent. With no header, only as a repeat of the very
 * last thing filed for them, within the hour: a new "Yes" days later is new.
 */
function seenBefore(leadId, m) {
  if (m.at) {
    const exact = db.prepare('SELECT reply_id FROM wa_paste_seen WHERE fingerprint = ?').get(fingerprint(leadId, m));
    if (exact) return exact;
    const at = new Date(m.at).getTime();
    return db.prepare(
      `SELECT reply_id FROM wa_paste_seen
        WHERE text_key = ? AND sent_at IS NULL AND seen_at >= ? AND seen_at <= ?
        ORDER BY seen_at DESC LIMIT 1`
    ).get(textKey(leadId, m.text), new Date(at - 5 * 60_000).toISOString(),
      new Date(at + 3 * 86_400_000).toISOString()) ?? null;
  }
  const last = db.prepare(
    'SELECT reply_id, text_key, seen_at FROM wa_paste_seen WHERE lead_id = ? ORDER BY seen_at DESC, rowid DESC LIMIT 1'
  ).get(leadId);
  return last && last.text_key === textKey(leadId, m.text)
    && last.seen_at >= new Date(Date.now() - 60 * 60_000).toISOString() ? last : null;
}

/** Whether every message in `theirs` has already been filed for this lead. */
const allFiled = (leadId, theirs) => theirs.every((m) => seenBefore(leadId, m));

/**
 * POST /api/replies/whatsapp-read { text, lead_id?, origin }
 *
 * What the paste box shows the moment something is pasted: whose reply it is
 * (or the best guess, with the list to change it), what they said, and the
 * answer drafted. Nothing is saved: the rep checks the business, and the
 * reply is filed when they copy the answer (whatsapp-paste, below).
 */
router.post('/replies/whatsapp-read', wrap((req, res) => {
  const text = str(req.body?.text);
  if (!text) throw badRequest('Paste the WhatsApp messages they sent');
  const found = identify(text, {
    chosenId: int(req.body?.lead_id), userId: req.user?.id ?? null, forced: str(req.body?.sender),
  });
  const { lead } = found;
  res.json({
    lead: lead ? { id: lead.id, business_name: lead.business_name, location: lead.location } : null,
    how: found.how,
    why: found.why,
    sure: found.sure,
    their_text: found.theirText,
    from: found.who.phone ?? found.who.sender ?? null,
    senders: found.senders.length > 1 ? found.senders : [],
    already: lead ? allFiled(lead.id, found.theirs) : false,
    clash: found.clash.map((l) => ({ id: l.id, business_name: l.business_name })),
    candidates: found.candidates,
    draft: lead ? composeDraft({
      lead,
      body: found.theirText,
      brief: extractByRules(found.theirText, lead),
      user: req.user,
      origin: str(req.body?.origin),
      cameFrom: found.who.phone,
    }) : null,
  });
}));

/**
 * POST /api/replies/whatsapp-paste { text, lead_id?, origin }
 *
 * Messages copied out of WhatsApp, filed against the lead they came from and
 * answered. Copied from WhatsApp Desktop, each message carries who sent it,
 * which for a prospect not saved in the phone is their number; that finds the
 * lead with nobody choosing it. Our own messages in the same paste are left
 * out, and anything already pasted before is not filed twice. Only a number
 * or the rep's own choice files a reply; a guess is only ever offered.
 *
 * Nothing is sent: the answer comes back drafted, to copy into WhatsApp.
 *
 *   201 { filed: true,  reply_id, lead, draft, messages }
 *   200 { filed: false, already: true, reply_id, lead, draft }  all pasted before
 *   200 { need_lead: true, reason, sender, preview, candidates }  say whose it is
 */
router.post('/replies/whatsapp-paste', wrap(async (req, res) => {
  const text = str(req.body?.text);
  if (!text) throw badRequest('Paste the WhatsApp messages they sent');
  const found = identify(text, {
    chosenId: int(req.body?.lead_id), userId: req.user?.id ?? null, forced: str(req.body?.sender),
  });
  const { who, theirs, first, parsed } = found;

  if (!found.sure) {
    const reason = !parsed.headed ? 'no-header'
      : found.matched.length ? 'several'
      : first.phone ? 'unknown-number' : 'name';
    return res.json({
      need_lead: true,
      reason,
      sender: { name: first.phone ? null : first.sender, phone: first.phone },
      preview: found.theirText.slice(0, 600),
      candidates: found.candidates,
    });
  }
  const { lead } = found;
  if (found.clash.length) {
    const names = found.clash.map((l) => l.business_name).join(' and ');
    throw conflict(`Those messages came from ${who.phone}, which is ${names}'s number. Choose ${names} instead.`);
  }

  const filed = db.transaction(() => {
    const now = nowIso();
    const fresh = theirs.filter((m) => !seenBefore(lead.id, m));
    if (!fresh.length) return { replyId: seenBefore(lead.id, theirs[theirs.length - 1]).reply_id, fresh: [] };
    const replyId = insertReply({
      leadId: lead.id,
      channel: 'whatsapp',
      body: fresh.map((m) => m.text).join('\n'),
      receivedAt: fresh[fresh.length - 1].at,
      threadId: who.phone,
    });
    const mark = db.prepare(
      `INSERT INTO wa_paste_seen (fingerprint, lead_id, reply_id, seen_at, text_key, sent_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO NOTHING`
    );
    for (const m of fresh) {
      mark.run(fingerprint(lead.id, m), lead.id, replyId, now, textKey(lead.id, m.text), m.at ?? null);
    }
    // A number the rep has just told us is this lead's: next time it matches
    // by itself (and a directory's copy of it is vouched for now).
    if (who.phone && !who.found?.ids.length) {
      db.prepare(
        `INSERT INTO contact_signals
           (lead_id, kind, value, source, confidence, note, first_seen_at, last_seen_at, promoted_at)
         VALUES (?, 'whatsapp', ?, 'user:manual', 100, 'their WhatsApp, from a pasted reply', ?, ?, ?)
         ON CONFLICT(lead_id, kind, value) DO UPDATE SET
           last_seen_at = excluded.last_seen_at, source = 'user:manual', confidence = 100,
           promoted_at = COALESCE(contact_signals.promoted_at, excluded.promoted_at)`
      ).run(lead.id, who.phone, now, now, now);
    }
    return { replyId, fresh };
  })();

  if (filed.fresh.length) {
    try {
      await extractBriefFor(filed.replyId, lead);
    } catch (err) {
      // The reply is filed and the answer does not need the brief.
      console.warn(`[replies] brief for pasted WhatsApp reply ${filed.replyId}: ${err.message}`);
    }
  }
  const draft = draftFor(filed.replyId, { user: req.user, origin: str(req.body?.origin) });
  // They asked us to stop, in any one of their messages: honoured the moment
  // it is read, for every business that number is on, since it is the person
  // on the end of it who asked.
  const stop = draft.intent === 'stop' || theirs.some((m) => classifyReply(m.text, {}, lead) === 'stop');
  if (stop) {
    const ids = new Set([lead.id, ...(who.phone ? leadsForNumber(who.phone).ids : [])]);
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
      if (row && !row.opted_out) optOut(row);
    }
  }

  res.status(filed.fresh.length ? 201 : 200).json({
    filed: Boolean(filed.fresh.length),
    already: !filed.fresh.length,
    stopped: stop,
    reply_id: filed.replyId,
    messages: filed.fresh.length,
    lead: { id: lead.id, business_name: lead.business_name },
    draft,
  });
}));

/**
 * DELETE /api/replies/:id — take a reply off (filed against the wrong
 * business, or pasted by mistake). Its brief goes with it; a mock up built
 * from it stays. If it was their only reply, they are back to awaiting one.
 */
router.delete('/replies/:id', wrap((req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');
  const reply = db.prepare('SELECT id, lead_id FROM replies WHERE id = ?').get(id);
  if (!reply) throw notFound('Reply not found');
  db.transaction(() => {
    db.prepare('DELETE FROM replies WHERE id = ?').run(id);
    if (reply.lead_id && !db.prepare('SELECT 1 FROM replies WHERE lead_id = ?').get(reply.lead_id)) {
      db.prepare("UPDATE leads SET status = 'sent' WHERE id = ? AND status = 'replied'").run(reply.lead_id);
    }
  })();
  res.status(204).end();
}));

/** GET /api/replies/:id/draft?origin=&kind=mockup — the answer, drafted again. */
router.get('/replies/:id/draft', wrap((req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');
  const kind = str(req.query.kind) === 'mockup' ? 'mockup' : null;
  res.json({ draft: draftFor(id, { user: req.user, origin: str(req.query.origin), kind }) });
}));

/** POST /api/leads/:id/has-website — they told us they have one. */
router.post('/leads/:id/has-website', wrap((req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(int(req.params.id));
  if (!lead) throw notFound('Lead not found');
  db.prepare(
    `UPDATE leads SET has_website = 1, website_evidence = 'they said so', website_checked_at = ?,
       status = CASE WHEN status IN ('new', 'sent', 'replied') THEN 'lost' ELSE status END
     WHERE id = ?`
  ).run(nowIso(), lead.id);
  res.json({ ok: true });
}));

router.post('/replies/:id/extract', wrap(async (req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');
  const brief = await extractBriefFor(id);
  res.json({ brief, replies: listReplies({ leadId: brief.lead_id ?? undefined }) });
}));

router.post('/replies/:id/read', wrap((req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');
  markRead(id);
  res.json({ ok: true });
}));

/**
 * User corrections. Anything the extractor got wrong is fixed here, and the
 * row is flagged so a later re-extract does not quietly undo the edit.
 */
router.patch('/replies/:id/brief', wrap((req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');
  const existing = db.prepare('SELECT * FROM briefs WHERE reply_id = ?').get(id);
  if (!existing) throw notFound('No brief for that reply yet — extract one first.');

  const b = req.body ?? {};
  const cta = b.primary_cta === undefined ? existing.primary_cta : str(b.primary_cta);
  if (cta && !CTAS.includes(cta)) {
    throw badRequest(`primary_cta must be one of: ${CTAS.join(', ')}`);
  }

  const asJson = (v, fallback) => {
    if (v === undefined) return fallback;
    const list = Array.isArray(v)
      ? v
      : String(v).split('\n').map((s) => s.trim()).filter(Boolean);
    return JSON.stringify(list.slice(0, 20));
  };

  db.prepare(
    `UPDATE briefs SET
       trading_name=@trading_name,
       services=@services, primary_cta=@cta, areas=@areas,
       has_logo=@has_logo, has_photos=@has_photos, brand_colours=@colours,
       notes=@notes, edited_by_user=1, updated_at=@now
     WHERE reply_id=@id`
  ).run({
    id,
    trading_name: b.trading_name === undefined ? existing.trading_name : str(b.trading_name),
    services: asJson(b.services, existing.services),
    cta,
    areas: asJson(b.areas, existing.areas),
    colours: asJson(b.brand_colours, existing.brand_colours),
    has_logo: b.has_logo === undefined ? existing.has_logo : (b.has_logo ? 1 : 0),
    has_photos: b.has_photos === undefined ? existing.has_photos : (b.has_photos ? 1 : 0),
    notes: b.notes === undefined ? existing.notes : str(b.notes),
    now: nowIso(),
  });

  res.json({ brief: briefToApi(db.prepare('SELECT * FROM briefs WHERE reply_id = ?').get(id)) });
}));

/* ------------------------------------------------------------- mockups */

router.post('/mockups', wrap((req, res) => {
  const replyId = int(req.body?.reply_id);
  const leadId  = int(req.body?.lead_id);
  if (!replyId && !leadId) throw badRequest('Supply reply_id or lead_id');

  const briefRow = replyId
    ? db.prepare('SELECT * FROM briefs WHERE reply_id = ?').get(replyId)
    : db.prepare('SELECT * FROM briefs WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1').get(leadId);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?')
    .get(briefRow?.lead_id ?? leadId);
  if (!lead) throw notFound('Lead not found');

  // A mockup can be built with no brief at all — from the lead alone. It is
  // more generic, but "no reply yet" should not block making something to
  // show them.
  const brief = briefRow
    ? briefForBuild(briefToApi(briefRow), lead)
    : briefForBuild({ services: [], areas: [] }, lead);

  const token = newToken();
  const studio = getSetting('biz_name', 'this studio');
  // One page unless the caller explicitly asks for the four-file build.
  const layout = req.body?.pages === 'multi' ? 'multi' : 'single';
  const files = renderSite(brief, {
    draftNote: `Draft mockup for ${brief.business_name} — prepared by ${studio}`,
    pages: layout,
  });

  let error = null;
  try {
    writeSite(MOCKUP_ROOT, token, files);
  } catch (err) {
    error = err.message;
  }
  if (error) throw new Error(`Could not write the mockup: ${error}`);

  const info = db.prepare(
    `INSERT INTO mockups
       (lead_id, brief_id, token, business_name, trade, pages, palette, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lead.id, briefRow?.id ?? null, token, lead.business_name,
    brief.trade ?? lead.category ?? null,
    JSON.stringify(layout === 'multi' ? PAGES : SINGLE_PAGE),
    JSON.stringify(brief.brand_colours ?? []), nowIso()
  );

  res.status(201).json({
    mockup: {
      id: Number(info.lastInsertRowid),
      token,
      url: `/m/${token}/`,
      pages: layout === 'multi' ? PAGES : SINGLE_PAGE,
      layout,
      business_name: brief.business_name,
    },
    brief,
  });
}));

router.get('/mockups', wrap((req, res) => {
  const leadId = int(req.query.lead_id);
  const rows = leadId
    ? db.prepare('SELECT * FROM mockups WHERE lead_id = ? ORDER BY generated_at DESC').all(leadId)
    : db.prepare('SELECT * FROM mockups ORDER BY generated_at DESC LIMIT 100').all();
  res.json({
    mockups: rows.map((m) => ({ ...m, url: `/m/${m.token}/`, pages: JSON.parse(m.pages ?? '[]') })),
  });
}));

/**
 * Send a reply to the lead directly via Resend — no Gmail "Send mail as" needed.
 */
router.post('/replies/:id/reply', wrap(async (req, res) => {
  const id = int(req.params.id);
  if (!id) throw badRequest('Bad reply id');

  const reply = db.prepare(
    `SELECT r.*, l.business_name, l.email AS lead_email, l.id AS lid
     FROM replies r JOIN leads l ON l.id = r.lead_id
     WHERE r.id = ?`
  ).get(id);
  if (!reply) throw notFound('Reply not found');

  const to = str(req.body?.to) || reply.lead_email || reply.from_address;
  if (!to || !looksLikeEmail(to)) throw badRequest('No valid recipient email');

  const subject = str(req.body?.subject)
    || (reply.subject ? `Re: ${reply.subject.replace(/^Re:\s*/i, '')}` : `Your website — ${reply.business_name}`);
  const body = str(req.body?.body);
  if (!body) throw badRequest('body is required');

  if (!resendConfigured()) {
    throw badRequest('Resend is not configured — set RESEND_API_KEY in .env');
  }

  const domain = sendingDomain();
  if (!domain) throw badRequest('No sending domain — set biz_email in Settings');

  const rep = req.user ? getUserById(req.user.id) : null;
  const fromAddr = (rep?.work_email || db.prepare("SELECT value FROM settings WHERE key='biz_email'").get()?.value || '').trim().toLowerCase();
  if (!fromAddr || !looksLikeEmail(fromAddr)) {
    throw badRequest('No valid from address — set biz_email or a work_email');
  }
  const fromName = rep?.name || getSetting('biz_contact_name', '');
  const from = fromName ? `${fromName} <${fromAddr}>` : fromAddr;

  const sent = await resendSend({ from, to, subject, text: body, replyTo: fromAddr });

  const at = nowIso();
  const fromDomain = fromAddr.split('@')[1] ?? null;
  db.prepare(
    `INSERT INTO email_log
       (lead_id, template_id, lead_name, to_email, subject_snapshot, body_snapshot,
        sent_at, channel, provider_message_id, provider, from_domain)
     VALUES (?, NULL, ?, ?, ?, ?, ?, 'gmail', ?, 'resend', ?)`
  ).run(reply.lid, reply.business_name, to, subject, body, at, sent.id, fromDomain);

  db.prepare(
    `UPDATE leads SET last_contacted_at = ?,
       status = CASE WHEN status IN ('new','replied') THEN 'sent' ELSE status END
     WHERE id = ?`
  ).run(at, reply.lid);

  res.json({ ok: true, message_id: sent.id, to, subject });
}));

router.post('/mockups/:id/sent', wrap((req, res) => {
  const id = int(req.params.id);
  const info = db.prepare('UPDATE mockups SET sent_at = ? WHERE id = ?').run(nowIso(), id);
  if (!info.changes) throw notFound('No such mockup');
  res.json({ ok: true });
}));

/* -------------------------------------------------------------- ollama */

router.get('/ollama', wrap(async (req, res) => {
  const probe = await ollamaAvailable({ force: req.query.force === '1' });
  res.json({
    ...probe,
    model: ollamaModel(),
    // What the tool does without it, so the UI can be honest rather than
    // presenting this as broken.
    fallback: 'Replies are still parsed by the built-in rules; a numbered '
            + 'reply extracts fine without any model at all.',
  });
}));

export default router;

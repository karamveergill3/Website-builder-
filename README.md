# Prospect Book

A personal tool for finding UK businesses that don't have a website, tracking
outreach to them from first contact through to a signed job, and — once you've
connected it — sending templated emails from your own Gmail account.

Single user, runs on your own machine, keeps everything in one SQLite file.

---

## Quick start

Needs **Node 22 or newer**. On Windows, `cp` is `copy`.

```bash
npm install
cp .env.example .env
npm start                 # http://localhost:3000
```

```bash
npm run doctor            # is it actually ready? makes real API calls
npm run hunt              # find today's prospects now, without the server
npm test                  # 334 tests
npm run lint
```

**Start with `npm run doctor`.** Everything else in this project is tested
against stubs, which proves the code is right and proves nothing about whether
your keys work. The doctor makes real calls, reports what came back, and ends
with the single next thing to do. It never sends anything to anybody.

The database is created automatically at `data/prospect-book.db` on first run.
There is nothing else to set up for the lead tracker.

Before you can produce an email, fill in **Settings → Your business details**.
Sending is deliberately blocked until you do — see [Compliance](#compliance--read-this-before-sending-anything).

---

## What's here

| | What it does | Needs |
|---|---|---|
| **Lead tracker** | Leads, templates, compose, sent log | Nothing |
| **Daily hunt** | Finds 10+ qualified prospects a day, unattended | A Companies House key |
| **Find companies** | One-off register search by trade and town | A Companies House key |
| **Website check** | Which of them have no website | A Google Cloud API key |
| **Outbox** | Review-then-send through your own Gmail | A Google OAuth client |
| **Reach**  | WhatsApp / SMS / call any lead — one tap per send  | A UK phone number |
| **Contact finder** | Scrapes the lead's website + public directories | Nothing (free)  |
| **Replies** | Reads what came back and pulls out a brief | Nothing (free)  |
| **Mockups** | Builds a one-page site from that brief, on a private link | Nothing (free) |
| **No repeats** | One approach per company, ever, across every channel | Nothing |

The tracker works on its own with no keys at all.

**Nothing here is billed to an AI account.** Three runtime dependencies —
`express`, `better-sqlite3`, `dotenv` — and no AI SDK of any kind. Reply
reading can optionally use a model, but only one running on *your* machine
via Ollama: no key, no account, no bill, and nothing about a prospect ever
leaves the box. `test/no-ai.test.js` fails the build if a hosted provider is
ever introduced or if an inference endpoint stops being loopback. Everything
works without a model at all — the rules-based extractor handles a numbered
reply on its own.

---

## The working day

Set the **Hunt** up once — a list of trades and a list of towns — and it finds
ten or more qualified prospects a day on its own:

1. It reads a page of the **companies register** for a trade and town. Active
   limited companies and LLPs are the only businesses UK law lets you
   cold-email, so everything it finds is qualified before it becomes a lead.
2. **One Google search per town** — "roofers in Otley" comes back with twenty
   businesses *and* their website status for a single billed request. The ones
   with no website are your prospects.
3. It stops at the day's target and moves a cursor on, so tomorrow covers new
   ground.

Then your part:

4. **Find the addresses** — the one genuinely manual step; see below.
5. **Queue and send** — the Outbox shows each email in full, one confirmation
   sends them, spaced out and under a daily cap that ramps up over four weeks.

The hunt never sends anything. Details and cron setup:
[`docs/HUNT.md`](docs/HUNT.md).

You can also drive it by hand — **Find** for a one-off register search, or
**Google Places** to come at it from the other direction — but expect most of
what a map search returns to be sole traders you cannot lawfully email.

### One company, one approach

**A business you have already approached is never offered to you again** — not
by tomorrow's hunt, not in the email queue, not in the Reach modal, and not
after you delete the lead.

That last one is the reason it needs its own table. `DELETE FROM leads` is a
hard delete, and the lead row used to be the only memory that a company had
ever been seen. So the one gesture that means *not interested in this one* was
also the gesture that put it back in tomorrow's list. `company_ledger` outlives
the lead, the way the suppression list already does.

It is keyed on the **company**, not the lead:

- The company number wins whenever there is one — it is the only identifier
  that survives a rename, and it is compared case-insensitively now, so
  `sc123456` and `SC123456` are one business rather than two.
- Failing that, a normalised trading name plus town, which is what lets a
  Google Places import recognise a company the register filed last week.
  Those two funnels key on different identifiers and were previously blind to
  each other.
- Where the register says two similarly-named firms have **different** company
  numbers, that wins over the name guess. They are different businesses.

The rule is one *cold approach* per company, not one message ever:

- **A prospect who replied can always be answered.** Once they have written
  back it is a conversation, and refusing to let you reply would be absurd.
- **You can go again deliberately.** Queue with the lead explicitly named, or
  tick the override in Reach. Every override is still counted, so
  `times_contacted` tells the truth.

Two rows for one company are now impossible: a partial `UNIQUE` index on
`company_number` makes it a storage error rather than something each call site
has to remember to check, and any duplicates already in your database are
merged into the oldest row on upgrade — notes appended, child records moved,
nothing dropped.

### The bit no API solves

**Neither Google nor Companies House holds an email address.** That is the real
cap on volume, not the software. What the tool does about it: a **no email**
view listing exactly who is missing one, a per-lead lookup button, and a
**Paste emails** box that matches a pasted list against your leads by name. The
phone number is always there for the ones that will never have an address.

---

## The tracker

**Leads** — every business you're tracking. Filter by status with the pills,
search across name, town and notes, and watch the stat tiles across the top:
total, awaiting reply, replied, won, and how many can lawfully be emailed.
Select several to change status or queue emails in one go.

Statuses run `new → sent → replied → won / lost`. Marking a lead `sent` by hand
stamps the contact date for you.

**Templates** — the wording. Placeholders get filled from each lead:

| Placeholder | Filled with |
|---|---|
| `{{business}}` | Business name |
| `{{category}}` | Category, e.g. "roofers" |
| `{{location}}` | Town or city |
| `{{phone}}` `{{email}}` | The lead's own contact details |
| `{{first_name}}` | First word of the business name |

A placeholder you mistype is left in the text rather than silently vanishing,
and you get a warning when you save.

**Compose** — pick a lead and a template, see the exact finished email including
the footer, then copy it or open a draft in your mail app. Either action logs
the send, so the tracker's "sent" status is backed by a real record.

**Sent log** — an immutable snapshot of every email: who it went to, the exact
subject and body at the time, and when. Editing a template later does not
rewrite history, and deleting a lead does not erase the proof.

---

## Finding companies

**Find** searches the Companies House register by trade and town. You type
"roofers"; it resolves that to SIC 43910 and returns active companies, with
their registered office and company number. Free, and every result is a body
corporate — so it arrives qualified rather than needing checking.
See [`docs/COMPANIES-HOUSE.md`](docs/COMPANIES-HOUSE.md).

**Google Places** is the other direction: search a trade across as many towns
as you paste in and get back businesses Google holds no website for.
`websiteUri` is requested on the Text Search call itself, so one billed request
covers a page of up to 20 businesses rather than one Place Details call each.
Candidates always land in a checkbox review list; nothing imports without you
ticking it. Setup and costs: [`docs/PHASE2-PLACES.md`](docs/PHASE2-PLACES.md).

**Check register** on the lead list looks up everything unclassified and
applies only unambiguous matches, leaving anything doubtful for you.

## Sending

Queue emails from Compose or straight from the lead list. The Outbox shows each
one in full — real recipient, real subject, real body — and one explicit
confirmation sends them, spaced at a randomised interval under a daily cap.

Before *each individual* send the tool re-checks opt-out, suppression,
classification and your footer, so anything that changed since you reviewed is
still honoured. Successes are logged with their Gmail message ID; failures are
recorded against the queue item and never appear as sent.

Before each send it re-checks the address (syntax, typos, throwaway providers,
a real MX lookup), scores the draft for the things that actually move inbox
placement, and applies a warm-up ramp, a business-hours window and a per-domain
cooldown. The **Inbox** screen shows every one of those guards and its state,
and will score a draft you paste in.

Setup and send rates: [`docs/PHASE3-GMAIL.md`](docs/PHASE3-GMAIL.md).
What reaches an inbox and what does not:
[`docs/DELIVERABILITY.md`](docs/DELIVERABILITY.md).

---

## Compliance — read this before sending anything

Two things constrain this tool that are not preferences, and the software
enforces both rather than reminding you about them.

### You may not cold-email most small businesses

Under PECR regulation 22 you may send unsolicited marketing email to **corporate
subscribers** — limited companies, PLCs, LLPs, CICs — but **not** to sole
traders, ordinary partnerships, or any personal mailbox. Most small trades are
sole traders, so **expect a large share of any Places sweep to be unsendable.**
That is the filter working.

So every lead starts blocked, and to unblock one you must record its **company
number**. A trading name ending in "Ltd" is not evidence: Google shows trading
names, which routinely differ from registered names. The Companies House
integration does this lookup for you — which is why starting from the register
rather than from a map is the better funnel.

Also enforced: no email is produced without your full identity block and an
opt-out line; opted-out addresses go on a suppression list that outlives the
lead; and every guard is re-checked immediately before each individual send.

Full detail, with sources and an honest note on what could not be verified:
**[`docs/COMPLIANCE.md`](docs/COMPLIANCE.md)**, or the **Rules** screen in the app.

### Google will not let you keep most of what Places returns

Maps Platform ToS §3.2.3 permits storing a **place ID**, and names *"copy and
save business names, addresses"* as a prohibited example of scraping. So this
tool stores place IDs and a has-a-website flag, and holds names, addresses and
phone numbers **in memory for one review session only**.

Anything you mean to keep long-term should come from a source you may store —
Companies House, or the business itself. Since you have to check Companies House
anyway to classify a lead, that is usually the same piece of work.
See [`docs/PHASE2-PLACES.md`](docs/PHASE2-PLACES.md).

### Sending from a personal Gmail is riskier than it looks

Gmail's programme policies prohibit unsolicited commercial mail with **no
volume exemption**, and the stated sanction includes disabling the Google
Account — on a personal address that means losing the mailbox itself. Use a
separate account. And note that the send-only permission the tool asks for
cannot read replies, so **checking the mailbox and marking people opted out is
a manual step you have to actually do**.
See [`docs/PHASE3-GMAIL.md`](docs/PHASE3-GMAIL.md) and
[`docs/DELIVERABILITY.md`](docs/DELIVERABILITY.md).

---

## Stack and layout

Node + Express + SQLite via better-sqlite3, and a small vanilla-JS frontend with
no build step. Deliberately boring: it's a single-user personal tool, so there
are no accounts, no framework and nothing to compile.

```
server/
  index.js          Express app; mounts Phase 2/3 routers if present
  db.js             SQLite connection + append-only migrations
  lib/
    template.js     {{placeholder}} rendering
    compliance.js   Identity footer and opt-out enforcement
    http.js         Validation and error helpers
  routes/           leads, templates, emails, settings (+ places, gmail)
public/
  index.html        App shell
  styles.css        Paper-green theme
  js/               Hash router, API client, one module per screen
test/               node:test suite — npm test
data/               SQLite file (gitignored)
```

### Data model

- **leads** — `business_name`, `category`, `location`, `phone`, `email`,
  `google_place_id` (unique, nullable), `status`, `notes`, `source`,
  `opted_out`, `created_at`, `last_contacted_at`, plus `entity_type`,
  `company_number` and `entity_note` for the PECR classification gate
- **templates** — `name` (unique), `subject`, `body`
- **email_log** — `lead_id`, `template_id`, `lead_name`, `to_email`,
  `subject_snapshot`, `body_snapshot`, `sent_at`, `channel`, `provider_message_id`
- **place_cache** — every Google `place_id` ever resolved and whether it had a
  website, so no place is paid for twice. Deliberately holds **no** listing
  content — see the compliance note above
- **suppression_list** — opted-out addresses, normalised, outliving the lead
- **company_ledger** — every company ever found, and whether it has ever been
  approached. Keyed on the company rather than the lead, and it outlives the
  lead row, so deleting a lead does not make its company a fresh target again
- **settings**, **search_runs**, **send_queue** — supporting tables for Phases 2–3

Migrations in `server/db.js` are append-only: add a new one rather than editing
a shipped one.

### Backups

Everything lives in `data/prospect-book.db`. Copy that file and you have a
complete backup.

```bash
sqlite3 data/prospect-book.db ".backup 'backup.db'"
```

---

## Tests

```bash
npm test
```

334 tests covering placeholder rendering, lead and template CRUD with
validation, stats, the PECR classification gate, Companies House matching and
entity classification, suppression across lead deletion, log-snapshot
immutability, the Places field mask and dedupe, Google's error-reason handling,
draft scoring, address validation, the daily hunt's budget and cursor
behaviour, the review-then-send confirmation, the daily cap, and
header-injection resistance in message building, reply extraction, and the
mockup builder's escaping, themes and layout blocks, and the one-approach-per-
company rule across every channel. Every external API is
stubbed, so the suite never spends money or needs credentials — and one test
asserts the project has no AI dependency and reaches no model provider.

```bash
npm run lint
```

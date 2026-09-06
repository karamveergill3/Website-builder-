# Prospect Book

A personal tool for finding UK businesses that don't have a website, tracking
outreach to them from first contact through to a signed job, and — once you've
connected it — sending templated emails from your own Gmail account.

Single user, runs on your own machine, keeps everything in one SQLite file.

---

## Quick start

```bash
npm install
cp .env.example .env      # optional for Phase 1
npm start                 # http://localhost:3000
```

The database is created automatically at `data/prospect-book.db` on first run.
There is nothing else to set up for the lead tracker.

Before you can produce an email, fill in **Settings → Your business details**.
Sending is deliberately blocked until you do — see [Compliance](#compliance--read-this-before-sending-anything).

---

## What's here

| Phase | What it does | Needs |
|---|---|---|
| **1. Lead tracker** | Leads, templates, generate-email view, sent log | Nothing |
| **2. Find leads** | Google Places search for businesses with no website | A Google Cloud API key |
| **3. Gmail sending** | Review-then-send through your own Gmail | A Google OAuth client |

Each phase works on its own. Phase 1 is useful with no API keys at all.

---

## Phase 1 — the tracker

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

## Phase 2 — finding leads

Search a category across as many towns as you paste in. There is no fixed
location bias: the sweep goes wherever you point it.

`websiteUri` is requested on the Text Search call itself, so **one billed
request covers a page of up to 20 businesses** rather than one Place Details
call each. A business becomes a candidate only when Google returns no website
for it, candidates always land in a checkbox review list, and nothing is ever
imported without you ticking it.

Every place ID ever seen is remembered, so re-sweeping the same town costs
almost nothing and never re-imports what you already have.

Setup, costs, storage rules and error handling:
[`docs/PHASE2-PLACES.md`](docs/PHASE2-PLACES.md).

## Phase 3 — sending

Queue emails from Compose or straight from the lead list. The Outbox shows each
one in full — real recipient, real subject, real body — and one explicit
confirmation sends them, spaced at a randomised interval under a daily cap.

Before *each individual* send the tool re-checks opt-out, suppression,
classification and your footer, so anything that changed since you reviewed is
still honoured. Successes are logged with their Gmail message ID; failures are
recorded against the queue item and never appear as sent.

Setup, send rates and the account risk:
[`docs/PHASE3-GMAIL.md`](docs/PHASE3-GMAIL.md).

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
names, which routinely differ from registered names.

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

Gmail's programme policies prohibit unsolicited commercial mail with no volume
exemption, and the stated sanction includes disabling the Google Account.
Don't use your main personal account.
See [`docs/PHASE3-GMAIL.md`](docs/PHASE3-GMAIL.md).

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

72 tests covering placeholder rendering, lead and template CRUD with
validation, stats, the PECR classification gate, suppression across lead
deletion, log-snapshot immutability, the Places field mask and dedupe, Google's
error-reason handling, the review-then-send confirmation, the daily cap, and
header-injection resistance in message building. The Places and Gmail suites run
against stubbed APIs, so they never spend money or need credentials.

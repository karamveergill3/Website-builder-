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
Sending is deliberately blocked until you do — see [Compliance](#compliance).

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
total, awaiting reply, replied, won, and how many are actually emailable.

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

## Compliance

Cold emailing UK businesses is legal in specific circumstances and unlawful in
others. The rules are set out in full, with sources, in
[`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — **read it before you send anything.**

What the software enforces for you:

- **No email is produced without your identity block.** Your name, trading name,
  postal address and contact email are appended to every email. Until those four
  are filled in, Compose is blocked, the mail-app draft link is withheld, and the
  API refuses to log a send.
- **Every email carries a one-line opt-out.** Editable, but it cannot be removed.
- **Opted-out leads are hard-excluded.** Setting `opted_out` on a lead blocks it
  from preview, from logging, and from the Gmail queue. There is no override.

What it can't do for you: judging whether a given business is one you're allowed
to email without consent. `docs/COMPLIANCE.md` explains the distinction that
matters (limited companies and LLPs vs sole traders and partnerships).

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
  `opted_out`, `created_at`, `last_contacted_at`
- **templates** — `name` (unique), `subject`, `body`
- **email_log** — `lead_id`, `template_id`, `lead_name`, `to_email`,
  `subject_snapshot`, `body_snapshot`, `sent_at`, `channel`, `provider_message_id`
- **place_cache** — every Google `place_id` ever resolved, so no place is ever
  paid for twice
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

Covers placeholder rendering, lead and template CRUD with validation, stats,
the compliance gate, opt-out exclusion, and log-snapshot immutability.

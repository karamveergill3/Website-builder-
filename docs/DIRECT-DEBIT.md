# Auto-collecting maintenance plans (GoCardless Direct Debit)

A maintenance plan is a recurring monthly charge (a care plan). Without Direct
Debit you raise this month's invoice with **"Bill this month"** and chase the
payment like any other. With **GoCardless Direct Debit** connected, the client
authorises once and the monthly amount is then **collected automatically** —
no invoice to raise, no link to chase, month after month.

You send the client a secure link; they enter their bank details on
GoCardless's own page (we never see or store them); GoCardless sets up the
Direct Debit and, from then on, pulls the plan amount every month and pays it
into your business bank account.

## What it costs (UK)

| | Fee |
|---|---|
| Per successful collection | **1% + 20p**, capped at **£4** |
| Setup / monthly fee | **none** — you only pay when you get paid |

So a £30/month plan costs about 50p a month to collect; a £150/month plan is
capped at £4. Cheaper than card fees for anything recurring, and far less
work than invoicing every month.

## Connect it (one-time)

1. Create an account at **<https://manage.gocardless.com>** (your real
   business details and bank account). You can use the **sandbox** immediately
   to test with fake bank details before verification finishes.
2. **Get your access token:** dashboard → **Developers → Access tokens** →
   create one and copy it.
   - It starts `sandbox_...` in the sandbox (fake money) or `live_...` once
     your account is activated (real money). The app works out which from the
     token itself — there's no separate switch.
3. **Put it on the server.** In your SSH session (`~/keylo`):
   ```bash
   nano .env
   ```
   Add the line:
   ```
   GOCARDLESS_ACCESS_TOKEN=sandbox_...your token...
   ```
   Save (Ctrl+O, Enter), exit (Ctrl+X), then:
   ```bash
   sudo systemctl restart keylo
   ```

Copy the token straight from GoCardless into the server — don't paste it into
a chat or commit it. `.env` is gitignored, so it never leaves the server.

## Use it

1. On the **Invoices** screen, under **Maintenance plans**, create a plan for
   the client (monthly amount + a description).
2. Click **Set up Direct Debit** on the plan. A secure link appears — copy it
   and send it to the client (email or WhatsApp).
3. The client opens the link and enters their bank details on GoCardless.
4. When they finish, the plan flips to **on Direct Debit** and GoCardless
   starts collecting the monthly amount on its own. The collection day is taken
   from the plan's start date (clamped to the 1st–28th so it's always valid).

While you wait for the client, the plan shows **awaiting client**. You can
re-send the link any time with **Resend Direct Debit**.

## Test it before going live

With a `sandbox_...` token, set a plan up and open the link. GoCardless's
sandbox lets you complete the flow with a **test bank** (e.g. sort code
`20-00-00`, account `55779911`) — no real money and no real mandate. The plan
should flip to **on Direct Debit**. Once you're happy, swap the token for your
`live_...` one and restart.

## How it stays safe

- Bank details are entered on GoCardless's own secure page. The hub never sees,
  handles or stores them.
- The client's return link carries an **unguessable token** tied to that one
  plan — that's what matches the return to the right plan.
- The subscription is created with an **idempotency key**, and the return is
  guarded so that refreshing the confirmation page can never create a second
  subscription or a double charge.
- The token lives only in the server's `.env` (gitignored) — never in the
  database, the code, or any invoice.

## Turning it off

Remove (or comment out) `GOCARDLESS_ACCESS_TOKEN` from `.env` and restart. The
**Set up Direct Debit** option simply disappears; existing plans already on
Direct Debit keep collecting inside your GoCardless account until you cancel
them there.

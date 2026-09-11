# Taking card, Klarna & Clearpay payments (Stripe)

With Stripe connected, every invoice grows a live **"Pay by card / Klarna /
Clearpay"** button. The client taps it, pays on Stripe's hosted page, and the
invoice marks itself **paid** automatically. You're paid in full up front; if
they pick Klarna or Clearpay, the instalments are between them and the provider.

This sits alongside PayPal (Pay in 3) and bank transfer — the client picks
whichever they like.

## What it costs (UK, per successful payment)

| Method | Fee |
|---|---|
| Visa / Mastercard, debit & credit | **1.5% + 20p** (UK cards) |
| Klarna (Pay in 3) | **4.99% + 45p** |
| Clearpay (Pay in 4) | **6% + 30p** |

No monthly or setup fee — you only pay when you get paid. (Klarna is cheaper
"direct" at ~0.99%, a separate integration we can add later if it gets popular.)

## Connect it (one-time)

1. Create a free account at **<https://dashboard.stripe.com>** (a real business,
   your details). You can start in **test mode** immediately without finishing
   verification.
2. **Get your secret key:** Dashboard → **Developers → API keys** → copy the
   **Secret key**.
   - It starts `sk_test_...` in test mode (fake money) or `sk_live_...` once
     you've activated the account (real money). The app works out which from
     the key itself — there's no separate switch.
3. **Put it on the server.** In your SSH session (`~/keylo`):
   ```bash
   nano .env
   ```
   Add the line:
   ```
   STRIPE_SECRET_KEY=sk_test_...your key...
   ```
   Save (Ctrl+O, Enter), exit (Ctrl+X), then:
   ```bash
   sudo systemctl restart keylo
   ```
4. **Turn on the payment methods you want.** Dashboard → **Settings → Payment
   methods** → enable **Cards**, **Klarna**, **Clearpay**. Whatever you switch
   on there is what appears at checkout — no code change needed. (Klarna and
   Clearpay need your account activated/verified before they can go live.)

Copy the key straight from Stripe into the server — don't paste it into a chat
or commit it. `.env` is gitignored, so it never leaves the server.

## Test it before going live

With an `sk_test_...` key, open any invoice's pay link and use Stripe's test
card **4242 4242 4242 4242**, any future expiry, any CVC. It should whisk you
through and mark the invoice **paid** — with no real money moving. Once you're
happy, swap the key for your `sk_live_...` one and restart.

## How "paid" is decided (money safety)

On return from Stripe the server looks the session up and marks the invoice
paid **only if** Stripe reports it paid **and** it's the session we created for
that invoice **and** the amount and currency match the invoice to the penny.
Anything else leaves it unpaid. The amount always comes from the stored
invoice, never from anything the client's browser sends.

# Taking payments with PayPal (the automated "Pay now" button)

When this is set up, an invoice carries a **Pay now** button. The client taps
it, pays on PayPal — in full, or with **Pay in 3** to spread it over monthly
instalments — and the invoice marks itself **paid** the moment PayPal confirms
it. You are paid the full amount straight away; PayPal collects any instalments
from the client. Nothing here changes if you leave it unconnected: invoices
still show your PayPal link and bank details, you just mark them paid by hand.

## What you need

1. A **PayPal Business account** (free): <https://www.paypal.com/uk/business>.
   A personal account can be upgraded to business.
2. **REST API credentials** — a Client ID and Secret:
   - Go to the PayPal Developer Dashboard: <https://developer.paypal.com/dashboard/>
   - **Apps & Credentials** → make sure the toggle is on **Live** (there is
     also a **Sandbox** for testing — see below).
   - **Create App**, give it any name, and copy the **Client ID** and
     **Secret** it shows.

## Put them in `.env`

Add these lines to your `.env` file (the same file your other keys are in —
it is never committed):

```
PAYPAL_CLIENT_ID=your-client-id
PAYPAL_CLIENT_SECRET=your-secret
PAYPAL_ENV=live
```

Restart the app. Run `npm run doctor` — you should see **PayPal — connected
(live)**. That's it: every invoice now shows the live Pay now button.

## Test it first without real money (recommended)

PayPal gives you a **sandbox** — a fake-money copy of everything — so you can
run a full payment end to end before going live:

1. In the Developer Dashboard switch to **Sandbox**, Create App there, and
   copy those Client ID/Secret.
2. Set `PAYPAL_ENV=sandbox` with the sandbox keys.
3. Sandbox also gives you test buyer accounts (Dashboard → **Sandbox →
   Accounts**) to "pay" with.
4. Raise an invoice, open its link, tap Pay now, pay with the sandbox buyer —
   the invoice should flip to paid on its own.

When you're happy, swap the three values for your **live** keys and set
`PAYPAL_ENV=live`.

## How the money reaches you

PayPal pays the full amount into your **PayPal Business balance** (usually
within minutes), minus PayPal's fee (roughly 2.9% + 30p per payment — check
your account for the current rate). From there you transfer it to your linked
UK bank account (free, about one business day). Pay in 3 costs you no extra:
PayPal fronts the instalments and collects them from the client.

## The safety checks (built in)

- The payment amount is taken from the **stored invoice**, never from anything
  the client's browser sends.
- On return, the invoice is marked paid **only if** PayPal reports the payment
  COMPLETED, the order is the exact one we created for that invoice, and the
  captured amount and currency match the invoice to the penny. Anything else
  leaves it unpaid.

## A note on the link

The Pay now button and PayPal's return both work over your public hub link.
On the free Cloudflare quick tunnel that link changes each restart, which is
fine — the button is built fresh each time from whatever link the client is
using. If you move to a permanent link later, nothing here needs changing.

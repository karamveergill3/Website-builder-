# Multichannel outreach

Reaching prospects across email, WhatsApp, SMS and phone — every channel
free at zero pounds a message, and every one legally gated the same way.

## What runs and what costs

|            | What the tool does                                    | Free? | Send is |
|------------|-------------------------------------------------------|-------|---------|
| Email      | Renders template, calls Gmail API, records the send   | Yes   | Automatic (Gmail free tier, up to 500/day) |
| WhatsApp   | Renders template, builds `wa.me/{E164}?text=…` link   | Yes   | One tap on your phone |
| SMS        | Renders template, builds `sms:{E164}?body=…` link     | Yes   | One tap on your phone |
| Call       | Builds `tel:{E164}` link                              | Yes   | One tap on your phone |

There is no free API for WhatsApp or SMS. Every commercial-grade "WhatsApp
automation" ends here in the end — the tool prepares the message, your phone
dispatches it. This is the only path that costs nothing.

## Why sending is not one-click for WhatsApp/SMS

- **WhatsApp** — the Business API is $0.04–0.09 per marketing message and
  requires an approved BSP. The `wa.me/` deep link is a supported alternative
  from Meta itself; it opens WhatsApp on your phone with the recipient and
  the message pre-filled.
- **SMS** — every carrier bills the sender per message. Twilio's trial
  credits run out. `sms:` is a URI scheme every mobile OS supports; it opens
  your phone's messaging app.
- **Phone calls** — `tel:` is the same idea, one-tap dial.

## The PECR gate

The same corporate-vs-individual rule that gates email applies to every
channel:

- **Corporate subscribers** — limited companies, LLPs, PLCs, CICs — may be
  cold-emailed, cold-messaged and cold-called under PECR regulations 21 and
  22. Companies House says who these are.
- **Individual subscribers** — sole traders and ordinary partnerships — need
  prior consent for any of the above. The finder still discovers them; the
  gate blocks the send.
- **Opt-out** beats every other consideration. Once someone opts out they
  are excluded from every channel.

**Phone calls have one extra step**: corporate subscribers are exempt from
TPS but not from **CTPS** (the Corporate TPS register). There is no free
bulk-lookup API. Check individual numbers at ctpsonline.org.uk before you
dial them at any scale. The tool surfaces this reminder every time a call
is prepared.

## Finding contacts for free

**The tool targets businesses with no website.** That single fact rules out
most of what a general email-finder does — you cannot scrape a website that
does not exist, and email addresses genuinely rarely exist for these
businesses either. They are phone-first.

What the finder actually does, in the order it matters:

1. **Phone from Google Places** — captured by the daily hunt when the
   listing carries a `nationalPhoneNumber`. Filed as both `lead.phone` and
   a signal at 90% confidence. This is where most phones come from.
2. **DuckDuckGo HTML search** — free, no API key. `"{business} {town}"`
   plus a filter that keeps only public directories and social pages
   (Facebook, Yell, Checkatrade, Trustpilot, MyBuilder, Bark, Yelp,
   Cylex, Hotfrog, 192.com, LinkedIn, Instagram). Those pages often
   carry the phone and sometimes an email.
3. **Website scrape** — only when the lead is known to *have* a website
   (`has_website === 1`) or the user pastes a URL in the reach modal.
   For a hunt lead this is skipped entirely and `no-website:` is recorded
   in the errors column so the trail explains why.

**Every request is polite**:

- Honest `User-Agent` identifying the tool
- 3-second minimum global gap between HTTP calls
- 15-second minimum per host
- 12-second hard timeout
- 512 KB max HTML body per fetch

Free scraping is best-effort. Sites go down, DuckDuckGo rate-limits, some
listings block Node's `fetch` outright. Every failed source is logged on
the discovery run — one source failing does not stop the others.

## Signals, promoted signals, and the lead row

Everything the finder turns up lands in `contact_signals` with a source and
a confidence:

- `email` at 95% — the domain matches the company's own website
- `email` at 75% — a role address (info@, hello@)
- `email` at 30% — a free-mail domain, kept for reference but PECR will
  block it if you try to email it
- `phone` at 80% — from the company's own website
- `phone` at 70% — from a directory
- `whatsapp` — a phone number found on a `wa.me/` link
- `facebook` — a page URL

**Promoting a signal** writes its value onto the lead's `email` or `phone`
column. That is the field the rest of the tool (Compose, Outbox, the PECR
gate) reads from. Signals stay in the table so the trail is visible.

## What outreach costs to run daily

- Companies House: free
- Google Places (only if you configured a key): about one billed request
  per town per day. Sits inside the monthly free allowance for a
  twenty-town rotation.
- DuckDuckGo: free, but they rate-limit heavy scraping. The finder is
  deliberately slow (15 seconds per host) so ten leads a day is fine and
  a hundred a day is not.
- WhatsApp / SMS: nothing — the tool never sends them.

## What could go wrong

- **DuckDuckGo starts refusing** the HTML endpoint. Their anti-bot is
  aggressive. When it 202s or 403s, the discovery run records
  `duck: <status>` on the errors column and continues with what it has.
  There is no free workaround here except waiting or running searches by
  hand and pasting the URLs.
- **Website 403s** — some hosting providers block Node's fetch by default.
  The finder records the failure and moves on.
- **Numbers not on WhatsApp** — a landline in a `wa.me/` link opens
  WhatsApp with an error. The tool warns "landline — WhatsApp may not
  answer" when the E.164 does not start with 07.
- **Phone number scraped from a page belongs to the agency, not the
  business.** This is a human-eye check. The phone is presented as a
  signal, not silently written onto the lead. You decide before promoting.

## Legally clean, not automated

The tool prepares the message. You dispatch it. That is not a technical
limitation with a paid workaround — it is the boundary between "personal
outreach" and "bulk marketing," and doing the send from your own phone
keeps the tool on the personal-outreach side of that line.

# Keeping mail out of junk

What actually determines whether a cold email at 10–25 a day reaches an inbox,
what this tool enforces about it, and the three things it cannot fix.

**Sourcing note.** Google's support and developer pages were unreachable from
the environment this was built in (403 at the network egress policy), so the
Gmail-specific figures below come from search summaries of those official
pages rather than pages read directly. They are marked where it matters.
Nothing here is a guarantee — anyone promising inbox placement is selling
something.

---

## The short version

At this volume the usual playbook does not apply. Authentication is Google's
and already correct — **but only because the tool sends through the Gmail API**
(see the DMARC note below). There is no domain reputation to build, because you
do not own gmail.com. What is left is:

1. **Not bouncing.** A dead address is a guaranteed hard bounce, and you have
   too few sends for a good one to average it out.
2. **Not being complained about.** Spam marks are the strongest negative signal
   there is, and at your volume you get very few sends to dilute one.
3. **The shape of the message** — links above all, then length and structure.
4. **Getting replies**, which is a strong positive signal.

Everything the tool does follows from those four.

> **A note on percentages.** It is tempting to say "one bounce in 25 sends is a
> 4% rate, thirteen times Google's 0.3% ceiling". The arithmetic is right but
> the comparison is not: Google's 0.3% is a Postmaster figure computed over an
> authentication domain's aggregate traffic to *active* Gmail users, not over
> your day's sending. The real argument for checking addresses is simpler —
> a bounce is pure downside and costs nothing to avoid.

---

## What it enforces

| | Default | Why |
|---|---|---|
| Address checked before sending | on | Syntax, domain typos, throwaway providers, and a real MX lookup. Bounces cost more than anything else at this volume. |
| Draft scored | on | Links, shorteners, images, length, subject shape, unfilled placeholders. Blocking findings stop the send. |
| Warm-up ramp | on | 5/day, rising to your cap over four weeks. A new mailbox opening at full volume is the clearest automation signal there is. |
| Sending window | 09:00–17:00, weekdays | A cold commercial email at 3am reads as automated to the recipient as much as to the filter. |
| One company at a time | 14 days | Two people at the same firm inside a fortnight is how a complaint gets made. |
| Randomised gaps | 120–420s | A fixed cadence is machine-shaped. Never set the two bounds equal. |
| List-Unsubscribe header | **off** | See below. |

All of it is enforced server-side and re-checked immediately before each
individual send.

### Why List-Unsubscribe is off

**An opt-out route is not optional.** PECR regulation 23 requires every
marketing email to carry a valid address for a request that communications
cease, and unlike regulation 22 it applies to corporate subscribers too. What
is optional is the *mechanism*.

Google scopes the one-click unsubscribe header (RFC 8058) to senders of 5,000+
messages a day. Below that the header buys nothing: its benefit is diverting
complaints, which only pays at volumes where complaint percentages are
statistically meaningful.

It costs something, though. Gmail renders a visible **Unsubscribe** chip beside
the sender name, which files the message as a campaign in the reader's mind.
(That is a Promotions-tab and human-perception effect, not a spam-filter one.)

So the tool puts a plain-English opt-out in the body instead:

> If this isn't relevant, reply and say so — I won't write again.

That, together with a real reply-to address, is what discharges the regulation
23 obligation — which is why the tool will not build a footer without it. It
also produces a **reply**, a strong positive signal, instead of a header
interaction.

Turn the header on under Settings if you ever go above bulk volumes. *(The
scoping is Google's published position; no controlled test either way was
found, and one vendor claim that low-volume senders are penalised without the
header is unsupported and contradicts that scoping.)*

---

## What the draft scorer checks

Ranked by how much evidence there is for each.

**Blocking** — the send is refused:

- **Three or more links.** Every domain in the body is extracted and checked
  against blocklists, so each link is an independent way to fail.
- **A URL shortener** (bit.ly, t.co, is.gd and the like). Spamhaus flags abused
  shorteners with a distinct return code inside its domain blocklist, so
  receivers can score them. Use the real URL.
- **An image, or a tracking pixel.** These emails are plain text. The best-
  evidenced effect of pixels, shared click-tracking domains and image-heavy
  templates is Promotions-tab classification rather than the spam folder — the
  Promotions tab is still not where a one-to-one note should land.
- **A subject faking a reply** — "Re:" or "Fwd:" on a first contact.
- **An unfilled `{{placeholder}}`.**
- **An empty subject or body.**

**Warnings** — worth fixing, but they do not stop you:

- **Two links.** One or none reads better for a first contact.
- **Under 30 or over 200 words.** This is about reply rate, not spam placement,
  and the widely-quoted "75 words is optimal" figure comes from a study of
  general email traffic rather than cold outreach — treat 50–125 words as a
  sensible range, not a law. Too short is a real failure mode either way: two
  lines and a link is the shape of a compromised account.
- **Subject over ten words.** Four to seven reads best.
- **Shouting and exclamation marks.** Gmail barely scores these, but plenty of
  UK small businesses sit behind cPanel, Plesk or MDaemon gateways that still
  run SpamAssassin, and avoiding them costs nothing. Words of three letters or
  fewer are ignored so VAT, LLP and CIC do not trip it.
- **Bulk-mail furniture** — "view in browser", an unsubscribe bar, "click here",
  a mailing-list preamble.
- **The wreckage of a half-filled mail merge** — "roofers in ," or "Hi ,".

**Deliberately not checked: spam trigger words.** Static word lists are
folklore for modern ML filters — Gmail runs machine-learned models over
thousands of signals per message, personalised per recipient. The tool does not
contort your copy around a word list.

---

## Addresses

Checked in this order, all locally:

1. **Shape.** Permissive on purpose — real addresses break most "correct"
   regexes.
2. **Domain typos.** `gmial.com`, `hotmial.com`, `outlok.com` and friends, with
   the correction offered. Exact matches only, never fuzzy: `sky.com` and
   `sky.co.uk` are one edit apart and both real.
3. **Throwaway providers.** Mailinator, YOPmail and the rest. The bundled list
   is short; if you ever need thorough coverage there are maintained
   MIT-licensed packages with six figures of domains.
4. **MX lookup** via `dns.resolveMx`, which handles three cases:
   - a **null MX** (RFC 7505 — a single record with preference 0 and an empty
     label) means the domain refuses all mail outright, and is rejected. Note
     that Node surfaces the null label as an empty string, not `"."`, so a
     naive length check passes these straight through. `example.com` publishes
     one, as do a good many defensive registrations of mistyped domains.
   - **no MX but an A record** is an implicit mail exchanger under RFC 5321
     §5.1, so it passes with a note rather than being called dead.
   - a DNS **timeout** is a warning, not a rejection, and is not cached.

**It does not probe with `RCPT TO`.** That is unreliable against catch-all and
greylisting servers, is widely treated as abusive, and can get the probing IP
listed. The gain does not justify it.

Role addresses — `info@`, `hello@`, `enquiries@` — are **not** penalised. For
B2B they are the better target: generally not personal data, and the person
reading them expects business post.

---

## What this cannot fix

**gmail.com has no reputation you can build.** You inherit the aggregate
behaviour of every Gmail account there is, including the spammers. You cannot
raise it, cannot move it, and can never see your own numbers — Postmaster Tools
enrols the *authentication* domain and needs a DNS record proving you own it,
and you do not own gmail.com. The standard advice to "build domain reputation
and watch Postmaster" is structurally unavailable to you.

**And you may only use a gmail.com From: through Google's own infrastructure.**
Google set gmail.com's DMARC policy to `p=quarantine` in February 2024
specifically to stop third-party platforms sending as gmail.com. Anything not
sending through the Gmail API or Google's SMTP with the account's own
credentials cannot SPF-pass or DKIM-sign as gmail.com, so it fails DMARC and
gets quarantined. This tool uses the Gmail API, so it is fine — but if you ever
route it through another SMTP service while keeping a gmail.com From:, every
message will land in spam.

*The fix, if you keep doing this:* register a dedicated sending domain — never
your main one — set SPF, DKIM and DMARC on it, and confirm `dkim=pass` in a test
message's `Authentication-Results` header. Google Workspace does **not** enable
DKIM automatically and silently failing DKIM is the most common setup error.

*But not immediately:* a brand-new domain has no history, and 25/day is too
little traffic to warm one quickly. For the first month or two a fresh domain
is **worse** than gmail.com. Start it in parallel and move over once it has
history.

**You have almost no signal to average a bad event against.** A handful of
sends a day means a single complaint carries far more weight than it would in a
larger programme. There is no headroom to absorb a bad list. This is the
argument for relevance and low volume, not for clever scheduling.

**Recovery is slower than damage.** The one figure here that comes from Google
rather than from vendors is the mitigation gate: seven consecutive days below a
0.3% spam rate. The various "two to six weeks" and "30 to 45 days" recovery
numbers that circulate are vendor content and could not be corroborated —
treat them as folklore, and assume recovery is measured in weeks rather than
days.

**Replies are the strongest positive signal, and the tool cannot see them.**
The Gmail permission it asks for is `gmail.send`, which is write-only: it can
send and nothing else, and cannot read your inbox. Widening it to read replies
would mean `gmail.readonly` or `gmail.modify`, both of which are *restricted*
scopes requiring Google verification. So **checking replies and marking people
opted out is a manual step you have to actually do** — and under PECR it is not
optional.

---

## Sending from a personal Gmail — the honest position

Gmail's programme policies prohibit using Gmail to send unsolicited commercial
mail, with **no volume exemption**. Being under the 5,000/day bulk threshold
exempts you from the technical bulk-sender requirements; it does not exempt you
from that prohibition. Those two things get conflated constantly.

Google's stated sanction includes disabling the account. On a personal address
that means losing the mailbox, Drive and Photos — not just API access.

So: use a separate account, keep the volume low and the mail genuinely
relevant, and understand that a separate account does not make it compliant —
it contains the damage.

If the mail is genuinely solicited, none of this applies.

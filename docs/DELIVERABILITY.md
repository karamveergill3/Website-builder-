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
and already perfect. There is no domain reputation to build, because you do not
own gmail.com. What is left is:

1. **Not bouncing.** One dead address at 25/day is a 4% bounce rate.
2. **Not being complained about.** One spam mark is a 4% complaint rate against
   a 0.1% target.
3. **The shape of the message** — links above all, then length and structure.
4. **Getting replies**, which is the strongest positive signal there is.

Everything the tool does follows from those four.

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

Google scopes the one-click unsubscribe requirement (RFC 8058) to senders of
5,000+ messages a day. Below that the header buys nothing: its real benefit is
diverting complaints, which only pays at volumes where complaint percentages
are statistically meaningful.

It costs something, though. Gmail renders a visible **Unsubscribe** chip beside
the sender name, which files the message as a campaign in the reader's mind and
undercuts the one-to-one framing that earns replies.

So the tool puts a plain-English opt-out in the body instead:

> If this isn't relevant, reply and say so — I won't write again.

That satisfies PECR reg. 23(b)'s requirement for a valid address to send a
cease request, and it produces a **reply** — the strongest positive signal
available — instead of a header interaction.

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
- **A URL shortener** (bit.ly, t.co, is.gd and the like). Spamhaus maintains a
  dedicated list for abused shorteners. Use the real URL.
- **An image, or a tracking pixel.** These emails are plain text; an image is a
  commercial-intent marker, and post-privacy-protection the open data is junk
  anyway.
- **A subject faking a reply** — "Re:" or "Fwd:" on a first contact.
- **An unfilled `{{placeholder}}`.**
- **An empty subject or body.**

**Warnings** — worth fixing, but they do not stop you:

- **Two links.** One or none reads better for a first contact.
- **Under 30 or over 200 words.** The evidence here is about reply rate rather
  than spam placement: 50–125 words replies best, ~75 optimal. Too short is a
  real failure mode — two lines and a link is the shape of a compromised
  account.
- **Subject over ten words.** Four to seven reads best.
- **Shouting and exclamation marks.** Gmail barely scores these, but plenty of
  UK small businesses sit behind cPanel, Plesk or MDaemon gateways that still
  run SpamAssassin, and avoiding them costs nothing. Words of three letters or
  fewer are ignored so VAT, LLP and CIC do not trip it.
- **Bulk-mail furniture** — "view in browser", an unsubscribe bar, "click here",
  a mailing-list preamble.
- **The wreckage of a half-filled mail merge** — "roofers in ," or "Hi ,".

**Deliberately not checked: spam trigger words.** Static word lists are
folklore for modern ML filters. The tool does not contort your copy around them.

---

## Addresses

Checked in this order, all locally:

1. **Shape.** Permissive on purpose — real addresses break most "correct"
   regexes.
2. **Domain typos.** `gmial.com`, `hotmial.com`, `outlok.com` and friends, with
   the correction offered.
3. **Throwaway providers.** Mailinator, YOPmail and the rest.
4. **MX lookup** via `dns.resolveMx`. A domain with an A record but no MX still
   receives mail, so that falls back rather than being called dead. A DNS
   timeout is a warning, not a rejection.

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
requires a DNS TXT record proving you own the authentication domain, and you do
not own gmail.com. The standard advice to "build domain reputation and watch
Postmaster" is structurally unavailable to you.

*The fix, if you keep doing this:* register a dedicated sending domain — never
your main one — set SPF, DKIM and DMARC on it, and confirm `dkim=pass` in a test
message's `Authentication-Results` header. Google Workspace does **not** enable
DKIM automatically and silently failing DKIM is the most common setup error.

*But not immediately:* a brand-new domain has no history, and 25/day is too
little traffic to warm one quickly. For the first month or two a fresh domain
is **worse** than gmail.com. Start it in parallel and move over once it has
history.

**Percentages are brutal at low volume.** At 25 a day, one spam complaint is a
4% rate against Google's 0.1% target and 0.3% ceiling. There is no headroom to
absorb a bad list. This is the argument for relevance and low volume, not for
clever scheduling.

**Recovery is much slower than damage.** Sources put degradation at about a day
and recovery at two to six weeks, with three months quoted for a badly damaged
sender. Google's formal gate is seven consecutive days below 0.3%.

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

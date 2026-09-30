# Sending through your own Gmail

How to connect it, how fast to send, and an honest account of the risk.

---

## Read this first

**Cold email conflicts with Gmail's own programme policies.**

> *"Don't use Gmail to distribute spam or unsolicited commercial mail."*
> — Gmail Program Policies

There is **no volume below which that stops applying**. Being under the
5,000/day bulk-sender threshold exempts you from the *technical* bulk-sender
requirements; it does not exempt you from the prohibition on unsolicited
commercial mail. Those two things get conflated constantly and the conflation
is wrong.

Google's stated sanction for a policy breach includes **disabling the Google
Account**. On a personal `@gmail.com` that means losing the mailbox itself —
along with Drive, Photos and everything else on that account. Appealing is the
practical recourse and there is no guarantee of a result.

So:

- **Never run cold outreach from your main personal Gmail.** Use a separate
  account. A separate account still breaks the same policy; it just contains
  the damage.
- **If the mail is genuinely solicited** — replies, opt-ins, follow-ups to
  people who asked — none of this applies and this setup is entirely
  appropriate.
- **At real volume, the right tool is a dedicated email service on your own
  sending domain**, with its own SPF, DKIM and DMARC. That isolates reputation
  damage away from your primary domain and mailbox. It does **not** exempt you
  from [UK PECR](COMPLIANCE.md), which is the binding constraint here anyway.

That is the honest position. The rest of this document assumes you have read it.

---

## Setup

1. In the **same Google Cloud project** as your Places key, enable the
   **Gmail API**.
2. Under **APIs & Services → Credentials**, create an **OAuth client ID**.
   Choose **Web application** and add this redirect URI:

   ```
   http://localhost:3000/api/gmail/callback
   ```

   (Match the port to whatever you run on. Set `GMAIL_REDIRECT_URI` in `.env`
   if you need something different.)
3. On the consent screen, add the scopes this tool requests:
   `https://www.googleapis.com/auth/gmail.send`, `openid`, `email`.
4. **Set the publishing status to "In production"** — see the next section.
   This is the step people miss.
5. Put the credentials in `.env` and restart:

   ```
   GMAIL_CLIENT_ID=…apps.googleusercontent.com
   GMAIL_CLIENT_SECRET=…
   ```
6. Open **Outbox** and connect.

Google has reorganised this area of the console into the **Google Auth
Platform** (Branding / Audience / Data Access / Verification), so publishing
status now lives under **Audience**. Any step-by-step guide older than that
will describe a screen that no longer exists.

### The 7-day refresh token trap

**If your OAuth app is left in "Testing" status, refresh tokens expire 7 days
after you consent.** Everything works perfectly for a week and then dies with
`invalid_grant`. This is the single most common way these projects break.

The fix is to set publishing status to **"In production"**. You do **not** need
to complete Google's verification to do that — publishing status and
verification status are independent. You will see a *"Google hasn't verified
this app"* interstitial once, click Advanced → "Go to … (unsafe)", and after
that the refresh token persists indefinitely.

Two caveats: the personal-use verification exception is capped at fewer than
100 users, and Google's position is that apps in production *should* complete
verification if they meet the criteria. This is a tolerated configuration for a
single-user tool, not a blessed one.

When a token does expire, the tool stops the run and tells you to reconnect
rather than retrying into a wall.

### Why these scopes

`gmail.send` is **write-only**. It can send a message and do nothing else — it
cannot read your inbox, list messages, or touch drafts. It is a *sensitive*
scope, not a *restricted* one, so it does not drag the project into a
third-party security assessment.

`openid` and `email` are there so the Outbox can show which account you
connected. Without them there is no way to confirm you authorised the right
Gmail, because `gmail.send` cannot read a profile.

**The consequence you need to plan around:** the tool cannot see replies. Most
opt-outs arrive as someone replying "no thanks", so **reading your replies and
marking those leads opted out is a manual step you have to actually do.**
Adding reply detection would mean `gmail.readonly` or `gmail.modify`, both of
which *are* restricted scopes and would require full verification.

---

## How fast to send

The defaults are **25 emails a day**, spaced at a **random 120–420 seconds**.
Both are adjustable under Settings. The reasoning:

- **The 500/day technical limit is not the binding constraint — abuse detection
  is.** Nothing about being under 500 makes you safe. What protects you is
  looking like a person working through a list rather than a program.
- **A fixed interval is the clearest machine signal there is.** The gap is
  randomised for that reason; don't set the two bounds equal.
- **The spam-rate ceiling is the real limit.** Google's threshold is 0.10%,
  with 0.30% as a hard floor. At 25 sends a day, a single complaint in 1,000
  sends puts you at the operating limit. There is no headroom to absorb a bad
  list — which is the argument for low volume and high relevance, not for
  clever scheduling.
- **25/day × 20 working days ≈ 500 a month**, which is a realistic figure for
  genuinely researched outreach and an unrealistic one for spray-and-pray.

Worth doing yourself, which the tool does not automate:

- **Ramp up.** Start at 5/day and add 5 a week. Never step up in a week where
  anything went wrong.
- **Send during business hours.** A cold commercial email arriving at 3am reads
  as automated to the recipient and to the filter.
- **Stop on any 429 or daily-limit error** rather than retrying — aggressive
  retry against a cap is itself an abuse signal. The tool halts the run when
  Google returns one of these.

Both limits are enforced server-side and re-checked before each individual
send, so a stale browser tab cannot exceed them.

### Numbers worth knowing

- **Free Gmail: 500 emails/day, 500 recipients per message.** Exceeding it
  locks sending for 1–24 hours. *(Confirmed from Google's support page.)*
- **Google Workspace: commonly cited as 2,000/day, unverified** — the numeric
  table could not be retrieved. Do not plan capacity on that figure without
  checking it.
- **Gmail API quota units are a separate ceiling** from the account send limit.
  You can fail on either. At tens of sends a day they are a non-issue.
- **The bulk-sender threshold is close to 5,000 messages a day to *personal
  Gmail addresses*** — counted by recipient type, aggregated across your domain,
  and once you cross it you are classified as a bulk sender going forward.

Above that threshold you would additionally need SPF *and* DKIM, a DMARC record
with alignment, and **RFC 8058 one-click unsubscribe** — which needs an HTTPS
`List-Unsubscribe-Post` endpoint; a `mailto:` List-Unsubscribe does not satisfy
it. This tool sets a `mailto:` List-Unsubscribe, which is right for the volumes
it is built for and satisfies PECR's requirement for a valid cease address, but
would not be enough if you ever sent at bulk scale.

From November 2025 Gmail moved from quietly filtering non-compliant mail to
returning SMTP 4xx and 5xx rejections, so failures are louder than older guides
suggest.

---

## What happens when you send

1. **Queue.** Emails are composed and staged. Anything that fails the
   [PECR gate](COMPLIANCE.md) is refused here with a reason.
2. **Review.** The Outbox shows the full recipient, subject and body of every
   queued email. Nothing is hidden behind a summary.
3. **Confirm — once.** The confirmation lists every recipient and requires a
   ticked box. It also carries the count you reviewed: if the queue changed
   since, the send is refused rather than silently sending more than you saw.
4. **Send.** One at a time, with the randomised gap. Before *each* message the
   tool re-checks that the lead has not opted out, is not suppressed, is still
   classifiable as a corporate subscriber, and that your identity footer is
   still complete. An opt-out arriving between review and send is honoured.
5. **Log.** Every success is written to the sent log with its Gmail message ID,
   the exact subject and body, and the time. Failures are recorded against the
   queue item and are **never** logged as sent.

The run stops entirely on an authentication failure or a daily-limit error.
You can stop it yourself at any point; it finishes the message in flight and
leaves the rest queued.

---

## The message it builds

Plain text, UTF-8, base64 encoded, as an RFC 5322 message:

```
To: recipient@example.co.uk
From: Your Trading Name <you@gmail.com>
Reply-To: you@yourbusiness.co.uk
Subject: A website for Example Roofing Ltd?
List-Unsubscribe: <mailto:you@yourbusiness.co.uk?subject=unsubscribe>
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: base64
```

Header values are stripped of CR and LF before assembly, so a subject
containing a newline cannot inject extra headers. Non-ASCII subjects are RFC
2047 encoded. The whole message is base64url encoded — `+` → `-`, `/` → `_`,
padding removed — which is what the Gmail API expects and a common place to
get it wrong.

---

## What is not verified

Google's support pages were unreachable from the environment this was built in,
so the Workspace sending limits, the `messages.send` quota-unit cost, and the
exact free-Gmail recipient figures are second-hand. The free-Gmail 500/day
limit, the bulk-sender threshold and the scope definitions were confirmed.

Check the numbers you actually depend on at
[support.google.com/mail/answer/22839](https://support.google.com/mail/answer/22839)
and
[developers.google.com/workspace/gmail/api/reference/quota](https://developers.google.com/workspace/gmail/api/reference/quota).

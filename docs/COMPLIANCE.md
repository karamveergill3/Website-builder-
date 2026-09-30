# Who you may email, and what every email must say

This is the part of the tool that is not a preference. Getting it wrong is a
regulatory matter, not a style choice, so the software enforces it rather than
reminding you about it.

**None of this is legal advice**, and see [What is not verified](#what-is-not-verified)
before you rely on any of it. If you intend to send at any volume, an hour of a
solicitor's time is cheap next to the downside.

---

## The short version

| | |
|---|---|
| **You may cold-email** | limited companies, PLCs, LLPs, CICs, Scottish partnerships, chartered and public bodies |
| **You may not cold-email** | sole traders, ordinary (non-LLP) partnerships, private individuals, or any personal mailbox |
| **Every email must carry** | who you are, a real postal address, where you got their details, and a way to opt out |
| **An opt-out means** | stop immediately, permanently, and keep a record so you never contact them again by accident |

Most small trades are sole traders. Expect a large share of any Google Places
sweep to be unsendable — that is the filter working correctly.

---

## 1. The classification rule

PECR regulation 22 restricts unsolicited marketing email to **individual
subscribers**. Corporate subscribers are outside its scope, so they may be
emailed without consent.

> *"There are two types of subscribers: individual subscribers (people, sole
> traders, ordinary partnerships); and corporate subscribers (organisations
> with their own legal personality, for example limited companies, LLPs and
> Scottish partnerships)."* — ICO, Guide to PECR, key concepts and definitions

> *"you can send unsolicited electronic mail marketing to corporate subscribers
> without consent or a soft opt-in. However, if you are sending unsolicited
> electronic mail marketing to individual subscribers, you must have their
> consent or be able to meet all the requirements of a soft opt-in."*
> — ICO, business-to-business marketing

The test is the recipient's **legal form**, not whether the address looks like
a business one.

### Why the soft opt-in cannot help you

Regulation 22(3)'s soft opt-in requires that you obtained the details *in the
course of a sale or negotiations for a sale* to that person. Details that came
out of a map listing were not, so it never applies to cold outreach.

### Personal mailboxes are always blocked

Even where the business is a limited company, the subscriber of a
`@gmail.com`, `@hotmail.co.uk` or `@btinternet.com` mailbox is the individual,
not the company. The tool blocks those regardless of classification.

### A name ending in "Ltd" is not evidence

Google shows **trading names**, which routinely differ from registered names,
and the PECR "subscriber" is whoever contracts for the communications service —
not whoever the map listing names. So the tool will not let you classify a lead
as corporate without recording a **company number**.

Look the business up on the
[Companies House register](https://find-and-update.company-information.service.gov.uk/).
If the ICO ever asks how you knew a recipient was a corporate subscriber,
"the listing said Ltd" is not an answer.

### The two-layer trap

`jane.smith@acme-ltd.co.uk` is a **corporate subscriber** for PECR — the
subscriber is the employer — so no consent is needed. But it is also
**personal data**, so UK GDPR applies in full: the right to object is absolute,
and the Article 14 duty below is engaged.

`info@` and `hello@` addresses at an incorporated company are the lowest-risk
target. Prefer them.

---

## 2. What every email must contain

Regulation 23 applies to **every** marketing email, to both kinds of
subscriber, solicited or not:

> *"A person shall neither transmit, nor instigate the transmission of, a
> communication for the purposes of direct marketing by means of electronic
> mail where: (a) the identity of the person on whose behalf the communication
> has been sent has been disguised or concealed; (b) a valid address to which
> the recipient of the communication may send a request that such
> communications cease has not been provided…"*
> — PECR reg. 23, legislation.gov.uk

Regulation 23(c) also pulls in reg. 7 of the E-Commerce Regulations 2002: a
commercial communication must be **clearly identifiable as one**.

And because the details came from a third party rather than from the person,
**UK GDPR Article 14** requires you to tell them — and where you use the data
to contact them, the deadline is that first contact.

### The checklist the tool enforces

| Line | Requirement | Source |
|---|---|---|
| "This is a marketing email from …" | Clearly identifiable as a commercial communication | E-Commerce Regs reg. 7, via PECR reg. 23(c) |
| Your name and trading name | Identity not disguised or concealed | PECR reg. 23(a) |
| A real postal address | Sole trader trading under a name that is not their surname must give their full name and a UK address for service | Companies Act 2006 s.1202 |
| Company number, place of registration, registered office | If you trade as a limited company or LLP — expressly including emails | Names and Trading Disclosures Regs 2015, Part 6 |
| A monitored contact address | Valid address for a cease request | PECR reg. 23(b) |
| Where you got their details | Privacy information when data came from a third-party source | UK GDPR Art. 14 |
| A one-line opt-out | In *every* message, simple and free | ICO direct marketing guidance |

**A VAT number is not required** in a marketing email — that obligation attaches
to VAT invoices. Include it if you like.

Sending is blocked outright until your name, trading name, postal address and
contact email are set under **Settings**. There is no override.

---

## 3. Opt-outs

There is **no grace period** in UK law. The "10 business days" figure people
quote is from the US CAN-SPAM Act and does not apply here.

> *"If someone withdraws their consent you must stop the direct marketing that
> the consent covers immediately or as soon as possible."* — ICO

### Suppress, do not delete

> *"If someone no longer wants you to use their information for direct
> marketing purposes, you should put their details onto a suppression or 'do
> not contact' list, instead of deleting them."* — ICO

This is why marking a lead **opted out** also writes the address to a
suppression list that outlives the lead. Delete the lead and re-import the same
business six months later, and it stays blocked.

Addresses are normalised before comparison, so `dave+leads@…` and `dave@…` are
the same mailbox, as are `dave.smith@gmail.com` and `davesmith@gmail.com`.
Whole domains can be suppressed too.

Suppression is checked **at send time**, not when the queue is built, so an
opt-out that arrives after you have reviewed a batch is still honoured.

### You need to be able to see replies

Most opt-outs will arrive as a plain reply saying "no thanks", not by clicking
anything. The Gmail integration uses the `gmail.send` scope, which is
**write-only** — it cannot read your inbox. So **reading replies and marking
leads opted out is a manual step you have to actually do.** Widening the scope
to read replies automatically would pull the project into Google's restricted-scope
verification; see [PHASE3-GMAIL.md](PHASE3-GMAIL.md).

---

## 4. Penalties

The £500,000 maximum quoted in most older guidance is **out of date**. The Data
(Use and Access) Act 2025 raised PECR penalties to UK GDPR levels with effect
from 5 February 2026:

- Higher tier: **£17.5m or 4% of worldwide turnover**, whichever is higher
- Standard tier: **£8.7m or 2%**, whichever is higher

The DUAA also removed the old requirement to show substantial damage or
distress before a fine could be issued.

Realistically, the exposure for a sole operator sending small volumes is an ICO
complaint and an enforcement notice rather than a headline fine. But the
figures are what they are.

---

## 5. What the software enforces

Enforced in the backend, so the interface cannot be worked around:

- **Default deny.** Every lead starts unclassified and cannot be emailed.
- **Evidence required.** Classifying a lead as corporate requires a company
  number in a plausible format.
- **Free-mail block.** Personal mailbox domains are refused regardless.
- **Footer required.** No email can be produced — copied, drafted or sent —
  without the full identity block and opt-out line.
- **Opt-out is absolute.** Checked at preview, at queue time, and again
  immediately before each individual send.
- **Suppression outlives the lead**, keyed on the normalised address.
- **Everything sent is logged**, with the exact subject and body at the time.

What it cannot do for you: decide whether a given business is actually
incorporated. That means checking Companies House. There is no way round it.

---

## What is not verified

The rules above were compiled from ICO guidance, legislation.gov.uk and gov.uk.
**They could not be checked against those pages when this tool was built** — the
build environment's network policy blocked `ico.org.uk`, `legislation.gov.uk`
and `www.gov.uk` outright. The text is drawn from search-index summaries of
those official pages, which is second-hand.

Specifically worth re-reading at the source before you rely on it:

- The reg. 22 / reg. 23 wording, at
  [legislation.gov.uk/uksi/2003/2426](https://www.legislation.gov.uk/uksi/2003/2426/regulation/22)
- The corporate/individual subscriber distinction, in the
  [ICO Guide to PECR](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/)
- The DUAA penalty figures
- Whether the ICO's direct marketing guidance has been revised — it was noted as
  under review with an update expected in 2026

The classification rule — that sole traders and ordinary partnerships are
individual subscribers — is the highest-consequence point in this document and
the one most worth confirming yourself.

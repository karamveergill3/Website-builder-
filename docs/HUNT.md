# The daily hunt

Finding ten or more qualified prospects a day without anyone driving it.

## What it does

Each day it works through a list of trades and towns you set once. For each
combination it:

1. Reads a page of the **Companies House** register — active companies of that
   trade, in that town. Every one is a body corporate, so every one is lawful
   to cold-email.
2. Skips any it already holds.
3. Runs **one Google Places search** for the whole town — "roofers in Otley" —
   which comes back with twenty businesses *and* their website status for a
   single billed request.
4. Files the companies Google shows no website for, and the ones Google has
   never heard of.
5. Stops as soon as it has met the day's target.

It moves a cursor through the register per trade/town, so tomorrow reads new
ground rather than the same first page. When a combination is worked through it
is retired, and re-opened a month later — new companies incorporate all the time.

**It never sends anything.** It finds and files. Sending stays behind the
confirmation in the Outbox.

## The economics

The register is free. The only cost is the Places search, and the design is
built around making that cheap: **one request covers a whole town**, not one
per company. Twenty towns is twenty-odd requests a day, which sits inside
Google's monthly free allowance.

The alternative — looking each company up individually — would be roughly
twenty times the cost for the same answer. The tool can still do that on
demand (**Check websites** on the lead list), but the hunt does not.

Set **Google lookups, max** as the hard ceiling. If it is ever reached the hunt
stops rather than spending more.

## Setting it up

**Hunt** in the app:

- **Trades** — one per line, in the words you would say. "roofers" resolves to
  SIC 43910; the chips under the box show what each one resolved to. A trade
  with no SIC code is listed as unrecognised rather than quietly dropped, and
  you can type a raw code instead. **Add every trade** fills the list from
  the 80-plus preset — building, home services, motor, beauty, food, retail,
  personal services — existing lines kept, duplicates dropped.
- **Towns** — one per line. Matched against the registered office as whole
  words, so a town name or a full postcode, not a partial one.
- **Find per day** — the target. It stops as soon as it hits it.
- **Run automatically every day** — the built-in scheduler.

More towns is the main lever. Four trades across five towns is twenty
combinations; at a hundred companies read per page that is a lot of days before
anything runs out. Add every trade (80+) across ten towns and you have 800
combinations — enough to keep the hunt fed for months without repeating
ground.

**Default caps** — 20 leads per day, 80 register pages, 80 Places requests.
Every one of those can be raised (up to 500) but 20/day is the point where
the manual step (finding contact details on the leads it files) starts to
become the bottleneck rather than the hunt itself.

## Running it when the server is not up

The built-in scheduler only fires while the server is running. It checks every
few minutes rather than at an exact time, so the machine only has to be awake
at *some* point after the hour you set — but a laptop that sleeps through the
day will miss it.

For that, run it from cron instead:

```bash
# every weekday at 08:00
0 8 * * 1-5  cd /path/to/prospect-book && /usr/bin/npm run hunt >> hunt.log 2>&1
```

Or on a Mac, a launchd agent with `StartCalendarInterval`.

By hand, any time:

```bash
npm run hunt          # the configured target
npm run hunt -- 25    # override it for this run
```

Both routes write to the same database and neither will start while the other
is mid-hunt.

## Reading the results

**Ground covered** shows, per trade and town: how far through the register it
has read, how many prospects came out of it, and when it last ran. **Restart**
takes one back to the beginning — worth doing occasionally, since companies
already held are skipped anyway, so it only surfaces genuinely new ones.

**Recent runs** shows what each run cost. If `found` is short of `target` and
there is no error, the towns are worked through: add more.

## What it cannot do

**It cannot find email addresses.** Neither Companies House nor Google holds
one. Everything the hunt files arrives with a company number, a registered
office and often a phone number, but no address — so it lands in the **no
email** view on the lead list, which is where the manual work is. See the
README.

**"Not on Google" is a weaker signal than "on Google with no website".** A
company with no listing usually has no web presence at all, which is the ideal
prospect. But a registered office can be an accountant's address, and the
business may trade somewhere else entirely — or have stopped trading in all but
name. Leads are tagged with which of the two it was (`website_evidence`), and
you can turn the unlisted ones off entirely.

**It does not judge whether a business is worth writing to.** It filters on
"active company, this trade, this town, no website". Everything past that is
your read.

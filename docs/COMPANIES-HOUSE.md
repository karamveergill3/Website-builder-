# Companies House

The piece that makes the tool workable. PECR only lets you cold-email bodies
corporate, and nothing in a Google listing tells you whether a business is one.
The register does — for free.

## Why it matters twice

**Qualification.** A lead cannot be emailed until it is positively identified
as a limited company, LLP or similar, with the company number recorded as
evidence. Doing that by hand for every lead is the difference between a tool
you use and one you abandon.

**Storage.** Companies House data is published under the **Open Government
Licence v3.0**, which grants a perpetual, royalty-free licence to copy, adapt
and commercially exploit it. So company name, number and registered office may
be kept indefinitely — unlike Google Places content, which
[may not be](PHASE2-PLACES.md#what-google-lets-you-keep). The durable half of a
lead record should come from here.

Two things the licence does *not* cover: officer and PSC data is personal data
and sits outside the OGL grant, and the register changes daily — re-check
status before acting on a stale record.

---

## Setup

1. Sign in at the
   [Developer Hub](https://developer.company-information.service.gov.uk).
2. Create an application. Choose **live**, not sandbox — the sandbox does not
   serve useful search data.
3. Create a key of type **API key**.
4. Add it to `.env` and restart:

   ```
   COMPANIES_HOUSE_API_KEY=your-key
   ```

Keys are issued from that portal directly. The paid Companies House products
are the separate document and bulk-order services, not this one — but the
public data API's pricing is not stated on any page that could be checked when
this was written, so confirm it on the Hub rather than taking my word for it.

**Rate limit: 600 requests per 5 minutes.** The client runs at roughly 1.4/s,
well under it, and serialises requests through a single queue. Companies House
reserve the right to ban applications that push the limit, so don't raise it.

---

## The two ways to use it

### Find companies (the good one)

**Find → trade + town.** This queries `/advanced-search/companies` filtered by
SIC code, `company_status=active` and location. Everything it returns is an
active body corporate, so it is qualified *before* it becomes a lead. The
response carries the SIC codes and a full registered office inline, so there is
no follow-up call per company.

You type "roofers" and the tool resolves it to SIC 43910. The mapping in
`server/lib/sic.js` is a hand-curated shortcut covering the trades most likely
to be running without a website — it is not the register. Any code can be typed
in directly, and the full official list is at
[resources.companieshouse.gov.uk/sic](https://resources.companieshouse.gov.uk/sic/).

Then **Check for websites** runs one Google Places lookup per company and keeps
only the yes/no answer. That completes the funnel: active company → no website
→ a real prospect.

### Check existing leads

Leads that came from Google Places arrive unclassified. **Check register** on
the lead list looks each one up by name and applies only unambiguous matches;
anything doubtful is left for you, and the **Check** button on a row shows the
candidates ranked so you can pick.

A match is applied automatically only when the name score is at least 0.9, the
company is trading, it is a body corporate, and the runner-up is clearly worse.
A trading name ending in "Ltd" is never enough on its own — Google shows
trading names, which routinely differ from registered ones.

---

## Which company types may be emailed

The API exposes no flag for this, so the tool carries an explicit **allow-list**
in `server/lib/companies-house.js`. Deliberately an allow-list: Companies House
adds enumeration values over time, and a deny-list would silently admit each
new one as sendable.

**Bodies corporate** — separate legal personality, outside PECR reg. 22:
`ltd`, `plc`, `llp`, `private-unlimited`, `private-unlimited-nsc`,
`old-public-company`, the guarantee and section-30 variants, `royal-charter`,
`protected-cell-company`, `assurance-company`, `unregistered-company`, the ICVC
types, `european-public-limited-liability-company-se`, `united-kingdom-societas`,
`charitable-incorporated-organisation` and its Scottish equivalent,
`further-education-or-sixth-form-college-corporation`, `northern-ireland` and
`northern-ireland-other`, `registered-society-non-jurisdictional`,
`industrial-and-provident-society`, `eeig`, `ukeig`.

**Not** — these are treated as individual subscribers and blocked:

| Type | Why |
|---|---|
| `limited-partnership` | An English or NI LP is not a body corporate; the general partner bears liability |
| `scottish-partnership` | Separate legal personality under Scots law, but not a body corporate |
| `uk-establishment`, `eeig-establishment` | A branch record, not an entity — contracts bind the foreign parent |
| `oversea-company`, `registered-overseas-entity` | Not a UK incorporation |
| `other` | Unclassified. Never assume. |

Status matters too. `active` alone is not enough: a company with
`company_status_detail` of `active-proposal-to-strike-off` is being dissolved
and is excluded.

---

## Notes for anyone reading the code

The three endpoints return genuinely inconsistent field names, which is why
`companies-house.js` normalises each separately rather than sharing a type:

| Endpoint | Name field | Type field | Address |
|---|---|---|---|
| `/search/companies` | `title` | `company_type` | `address_snippet` + `address` |
| `/advanced-search/companies` | `company_name` | `company_type` | `registered_office_address`, plus `sic_codes` |
| `/company/{n}` | `company_name` | **`type`** | `registered_office_address` |

Other traps:

- Auth is HTTP Basic with the key as the username and an **empty password**.
  The header is `base64("key:")` — the trailing colon is required, and omitting
  it is the single most common failure.
- `company_number` is a **string** and zero-padded (`00000006`). Parsing it as
  a number breaks every subsequent URL. Scottish and NI numbers carry alpha
  prefixes (`SC`, `NI`, `OC`, `SO`).
- `/search/companies` returns **416** past roughly 900 results — it is for
  finding a specific name, not enumerating the register.
- `/advanced-search/companies` returns **500** past about 10,000. Narrow by
  town or incorporation date rather than retrying.
- Advanced search needs at least one of trade, town or name; a status filter
  alone is a 400.
- For enumerating a whole trade nationally, the free
  [bulk data product](http://download.companieshouse.gov.uk/en_output.html)
  beats paging the API.

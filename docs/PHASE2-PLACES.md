# Finding leads with the Google Places API

How to set it up, what it costs, and what Google's terms let you keep.

---

## Setup

1. **Create a Google Cloud project** at
   [console.cloud.google.com](https://console.cloud.google.com/).
2. **Enable "Places API (New)"** under APIs & Services → Library. This is a
   *different* API from the one called plain "Places API", which is now legacy
   and prices differently. Make sure you enable the one with **(New)** in the
   name.
3. **Turn on billing** for the project. The API returns `BILLING_DISABLED`
   until you do, even for calls inside the free allowance.
4. **Create an API key** under APIs & Services → Credentials.
5. **Restrict it**, which matters because this key can spend money:
   - *API restriction*: Places API (New), and nothing else.
   - *Application restriction*: **IP addresses**, listing the machine you run
     this on. Do **not** pick "HTTP referrers" — that is for keys used in a
     browser, and a server-side request with a referrer restriction fails with
     `API_KEY_HTTP_REFERRER_BLOCKED`.
6. **Put it in `.env`** and restart:

   ```
   GOOGLE_MAPS_API_KEY=AIza…
   ```

The Find leads screen tells you if the key is missing, and the search run
records the exact reason if Google refuses a call.

---

## What the tool asks Google for

One request per area per page, with this field mask and nothing else:

```
X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,
                  places.nationalPhoneNumber,places.websiteUri,nextPageToken
```

No photos, no reviews, no ratings, no opening hours. On the New API the field
mask is what you are billed on, so every field you do not need is money you do
not spend.

**`websiteUri` comes back from Text Search directly.** That is the whole cost
argument: one request covers a page of up to 20 businesses, instead of one
Place Details call per business. A sweep of 20 towns is 20 requests, not 400.

There is an optional "verify with Place Details" pass that re-checks each
candidate individually. It is **off by default** because Text Search already
answered the question, and turning it on multiplies the cost by roughly the
number of candidates.

### How "no website" is detected

A business with no website has **no `websiteUri` key in the response at all** —
not `null`, not `""`. The field is a plain proto3 string, and unset scalars are
omitted from the JSON entirely. The check is therefore `!place.websiteUri`.
Comparing against `null` or `''` would silently match nothing and your
candidate list would come back empty.

---

## Costs

**⚠ The prices below could not be verified.** Google's billing pages were
unreachable from the environment this tool was built in, and Google reprices
Maps Platform periodically. They are a plausible starting point, not a quote.
The Find leads screen labels its estimate as unverified until you confirm the
figures yourself under **Settings → Places pricing**.

Read the current numbers at
[developers.google.com/maps/documentation/places/web-service/usage-and-billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing).

### What is actually confirmed

- Prices are quoted **per 1,000 requests in USD**.
- A request is billed **once, at the highest tier any field in its mask
  touches** — not once per tier. Google: *"if you select fields in both the
  Essentials and the Pro SKUs, you are billed based on the Pro SKU."*
- The old **$200/month credit was withdrawn on 1 March 2025** and replaced by a
  per-SKU monthly free call allowance. Essentials is 10,000 calls/SKU/month
  (confirmed); the Pro and Enterprise allowances are reported as 5,000 and
  1,000 but were not verified.
- The allowance is **per SKU**, so consolidating work onto one SKU means you
  draw down one allowance rather than several.

### Which tier this tool's mask lands in

Requesting `nationalPhoneNumber` and `websiteUri` puts a Text Search request
in the **Enterprise** tier. `formattedAddress` and `displayName` are already
Pro on Text Search — there is no cheap Essentials tier for Text Search beyond
IDs-only.

Reported prices, all unverified: Text Search Pro $32/1,000, Text Search
Enterprise $35/1,000, Place Details Enterprise $20/1,000.

### A worked estimate

Sweeping 20 towns, one page each:

```
20 requests × $35/1,000  =  $0.70
```

…and if the Enterprise free allowance really is 1,000 calls/month, the first
50 sweeps of that size each month cost nothing.

The Find leads screen shows this calculation before you press Search.

### Watch out for legacy pricing

The legacy Places API became "Legacy" on 1 March 2025 but still dominates
search results. Its model is completely different — Basic/Contact/Atmosphere
*data* SKUs stacking on top of a base SKU. If you google these prices you will
land on legacy tables and mis-model by roughly 2×. Make sure any page you read
says **(New)**.

---

## What Google lets you keep

This one constrains the design, so it is worth reading properly.

Maps Platform Terms of Service **§3.2.3(a)**:

> *"Customer will not export, extract, or otherwise scrape Google Maps Content
> for use outside the Services. For example, Customer will not: … (iii) copy
> and save business names, addresses, or user reviews…"*

and **§3.2.3(b)**:

> *"Customer will not cache Google Maps Content except as expressly permitted
> under the Maps Service Specific Terms."*

The Service Specific Terms then permit exactly two things: **place IDs**
(§A.3, no stated expiry) and **latitude/longitude for up to 30 consecutive
days** (§14.3). Everything else — names, addresses, phone numbers, website
URIs — is outside what you are licensed to store.

### How this tool is built around it

- The database stores the **place ID** and **whether the place had a website**,
  and nothing from the listing.
- Names, addresses and phone numbers from a sweep live **in memory for one
  hour**, for the length of a review session, and are never written to disk.
  When they expire the run still knows which places had no website; re-running
  the search is the only way to see who they were.
- A lead you import is tagged as Places-derived so you can find them later.
- **Anything you mean to keep long-term should come from a source you may
  store** — Companies House, or the business itself. Since you have to check
  Companies House anyway to classify a lead for
  [PECR](COMPLIANCE.md#1-the-classification-rule), that is usually the same
  piece of work.

### Two clauses worth a lawyer's eye

**§3.2.3(d)(iii)** prohibits using the Core Services *"in a listings or
directory service"*. If you ever extend this into something that publishes
business listings, that clause is squarely in the way.

**§3.2.3(e) / SST §14.2**: Places data may be used with **no map at all**
(explicitly fine), but must not be shown alongside a **non-Google map**. This
tool draws no map, so it is in the clear.

**If your Google Cloud billing address is in the EEA**, a stricter set of terms
applies with a closed list of permitted uses that this kind of tool is not on.
The UK is not in the EEA, so a UK-billed account falls under the standard
terms — but check which address your account actually uses.

### Attribution

If you ever display Places data to anyone other than yourself, `Place.attributions`
must be shown with its links, unmodified. This tool does not request that field
because the review list is private to you. Read
[the Places policies page](https://developers.google.com/maps/documentation/places/web-service/policies)
before putting Places data on any screen other people see.

---

## Limits and errors

Text Search returns at most **20 places per page and 60 in total** across three
pages. The depth selector caps at 3 pages for that reason. To go deeper in one
area, search a narrower category or a smaller town.

Rate limits are per-method, per-project, and best read from **Cloud Console →
APIs & Services → Places API (New) → Quotas** for your own project rather than
taken from any documentation.

The tool maps Google's error reasons to advice:

| Reason | What it means |
|---|---|
| `API_KEY_INVALID` | The key is wrong or expired |
| `SERVICE_DISABLED` | Places API (New) is not enabled on the project |
| `BILLING_DISABLED` | No active billing account |
| `API_KEY_SERVICE_BLOCKED` | The key's API restriction omits Places API (New) |
| `API_KEY_IP_ADDRESS_BLOCKED` | This machine's outbound IP is not on the key's allowlist |
| `API_KEY_HTTP_REFERRER_BLOCKED` | Browser-style restriction on a server-side key |
| `RATE_LIMIT_EXCEEDED` | Too fast — retried automatically with backoff |
| `RESOURCE_QUOTA_EXCEEDED` | Allocation spent — retrying will not help |
| 403 with no reason at all | No key reached Google |

Only rate limits and 5xx responses are retried. Everything else fails the run
and records why.

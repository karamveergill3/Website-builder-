# Reading replies and building mockups

A prospect replies. The tool reads what they asked for and builds them a
one-page site on a private link. You check it, paste the link into your
answer, and that is the pitch.

## The flow

1. **A reply arrives.** Either the tool reads it from Gmail, or you paste it
   in by hand (a WhatsApp message, notes from a phone call — same pipeline).
2. **A brief is extracted** — the name to put on the site, services, what
   they want visitors to do, whether they have a logo and photos, brand
   colours, areas covered.
3. **You check the brief** and correct anything wrong. Twenty seconds.
4. **Build mockup** generates the page, writes it to disk, and gives you a
   link.
5. **You send the link.** Nobody finds it without the token.

## How replies are read

Two passes, in this order.

**The rules.** The follow-up template asks four numbered questions — name,
services, assets, action — so most replies come back as "1. … 2. … 3. … 4. …"
and split deterministically. Keyword
matching then pins down the field that decides the whole layout: what a
visitor should be able to do first.

The last answer is the important one, and its answer space is closed —
call, quote, book, prices, gallery, enquire. A roofer who says "people
ringing us" gets a site built around a phone number. Someone who says
"request a quote" gets a site built around a form. It is one word in their
reply and it changes every page.

The rules handle a lot more than numbered lists: negations that bind to the
right clause ("no logo **but** I've got photos" — logo no, photos yes),
inflections that a naive pattern misses ("ring**ing** us"), coverage areas
bleeding into a services list ("roofs and guttering **round** Wolverhampton"),
and the quoted original being stripped so the extractor never reads our own
questions back.

**The local model.** Whatever the rules could not settle is asked of Ollama,
running on your machine. Loose prose — "yeah sounds good mate, we mostly do
roofs round wolverhampton, main thing is people giving us a bell" — is where
it earns its place.

Rules always win where they spoke. They only produce an answer when they
matched something explicit, and a deterministic answer is both better and
stable across runs.

### Installing the local model

Optional. Everything works without it; numbered replies extract perfectly on
rules alone.

```bash
curl -fsSL https://ollama.com/install.sh | sh   # or the .dmg on macOS
ollama pull llama3.2                            # about 2 GB
```

That is the whole setup. It runs on your hardware: no API key, no account,
no bill, no rate limit, and a prospect's email never leaves the machine.

`OLLAMA_MODEL` picks a different model; `OLLAMA_HOST` a different port. The
host **must** be a loopback address — a remote one is refused before any
request is made, and `test/no-ai.test.js` enforces the same rule across the
source tree. That is what keeps the "costs nothing on any AI account"
promise true.

## Reading Gmail

Off by default, and deliberately so.

Sending uses `gmail.send`, which is write-only — it cannot see your mailbox.
Reading replies needs `gmail.readonly`, which grants sight of **everything**.
That is a real widening, so:

1. Turn on **Read replies** in Settings.
2. Reconnect Gmail. The consent screen will now ask for read access too.
3. The tool records what Google actually granted, not what it asked for — a
   scope you untick on the consent screen is detected rather than assumed.

The search itself is narrow: inbox only, only from addresses already on a
lead, only within a date window. A message from an address we do not hold is
never stored.

`gmail.readonly` is a Google "restricted" scope. For a single-user personal
tool you stay in OAuth **testing** mode with your own address as the only
test user — no verification, no review, no cost. Only publishing an app
triggers Google's assessment.

**If you would rather not grant it**, paste replies in by hand. Same
extraction, same mockup, nothing to authorise.

## What gets built

**One page**, as anchored sections down a single scroll. No build step, no
external fonts or scripts — everything inlined so it opens straight from disk.

| Section | What it does |
|---|---|
| Hero      | Trade + town as the headline, the CTA their answer picked |
| Services  | One card per service, in their own words |
| Our work  | Photo slots — honest placeholders, not stock images |
| About     | Who they are, area covered, facts panel |
| Contact   | Phone, email, hours, area, enquiry-form placeholder |

A one-pager is the right shape for this market. A caller wants the number,
proof the work is decent, and the area covered — all of which fit on one
screen and a flick. Four pages give them three more chances to get lost on a
phone, and reviewing it takes you one screenshot instead of four.

`POST /api/mockups` with `{"pages":"multi"}` still produces the four-file
version for a job that warrants it.

## The name on the site

Companies House holds the **registered** name — `HILLSIDE ROOFING LIMITED`.
The van says `Hillside Roofing`. The site should say what the van says, so
the first question in the follow-up asks for it.

- Given a name, that is the masthead.
- Given nothing, the registered name is title-cased rather than left
  shouting — but only when it *is* all-caps, so `McKinnon Roofing Ltd` is
  left alone.
- Where the two differ, the footer carries **"A trading name of
  HILLSIDE ROOFING LIMITED"**. That is not decoration: Companies Act 2006
  s.1202 requires a limited company trading under another name to disclose
  the registered one.

The extractor works out which numbered answer is which rather than assuming
positions, so a reply in the old three-question format still parses — it
just reports the name as missing.

## How it looks

The page opens on a dark hero with a slow-drifting gradient mesh behind it,
a film-grain overlay, a large gradient headline, a pill call-to-action, and
a ticker of their services. Sections rise into view as you scroll. Cards
lift on hover.

**All of it is CSS.** The preview is served under `default-src 'none'`, so
there is no JavaScript available — and none is needed. Reveals use
`animation-timeline: view()` and the header's colour change uses
`animation-timeline: scroll()`; both are native CSS and both are wrapped in
`@supports`, so a browser without them shows a static page with identical
content rather than a broken one.

`prefers-reduced-motion` stops every animation. All of them are decorative,
so the page is complete either way — that is the test for whether an effect
earns its place.

### Sector themes

Colour is the weakest differentiator. Swapping only the accent produces
eight versions of one template, which is exactly what a prospect recognises
as generic. So each trade family gets its own **type, shape and motion**:

| Sector | Display face | Shape | How it moves | Backdrop |
|---|---|---|---|---|
| Building  | Archivo, heavy    | Blunt 6px  | Arrives fast from the left | Hazard diagonals |
| Motor     | Chakra Petch, caps| Sharp 2px  | Sweeps sideways, slight skew | Technical grid |
| Landscaping | Fraunces        | Round 22px | Grows up out of the ground | Organic curves |
| Hair & beauty | Cormorant Garamond, light | Editorial 2px | Slow unveil, weightless | Soft bloom + hairline rule |
| *(beauty runs on a light ground — see below)* | | | | |
| Food      | Playfair Display  | Warm 14px  | Gentle rise | Warm glow from below |
| Retail    | DM Serif Display  | Editorial 3px | Staggered | Column rules |
| Cleaning  | Outfit            | Soft 18px  | Light lift | Floating bubbles |
| Professional | Inter, tight   | Precise 10px | Minimal settle | Fine dot grid |

A salon gets a high-contrast serif at 300 weight, wide-tracked small caps,
square edges and a slow fade. A garage gets uppercase technical type, sharp
corners, a measuring grid and motion that passes sideways. They do not read
as the same site.

#### Light and dark grounds

Most sectors open on a dark hero. **Hair and beauty does not** — those sites
live in warm white, cream, soft black and silver. A dark plum ground with a
hot pink accent reads as a bar, not a salon, so the beauty theme runs
`mode: 'light'`: a warm-white ground, near-black serif type, a silver-taupe
accent and a solid black button.

A light ground is not the dark one with its colours swapped. The mesh drops
from 55% to 32% opacity and the grain switches from `overlay` to
`multiply`, because the same values that read as depth on near-black read
as a stain on cream. The hero type, the button fills, the ticker and the
header all branch on the mode.

**Palette still follows the trade**, and each one carries a second, lighter
hue so the mesh has depth across the whole hero instead of one lit corner. A
colour the prospect named beats the default, and its companion is derived
from it by lightening so the two always belong together.

**Fonts come from Google Fonts**, which is the one thing the preview CSP
allows beyond its own origin. `default-src 'none'` and the total absence of
`script-src` are what carry the security here — no script can run by any
route — so allowing a stylesheet and a font file widens nothing executable.
The cost is that the viewer's IP reaches Google, which is true of most of
the web. Every theme falls back to a real system face (Georgia, Helvetica,
system-ui), so a blocked or slow load leaves a page that still looks
deliberate.

### Hero artwork

Each sector opens with a piece of line art that animates in:

| Sector | What it is | What it does |
|---|---|---|
| Hair & beauty | Scissors over a comb | Blades open and close, comb teeth draw in |
| Motor         | Alloy wheel with a dashed tyre | Turns continuously, speed lines pass |
| Building      | Courses of roof tiles | Lay themselves bottom row up |
| Landscaping   | Stems with leaves | Grow up out of the ground, then sway |
| Food          | Cup | Steam rises in wisps |
| Cleaning      | Bubbles | Drift upward at different speeds |
| Retail        | Price tag on a hook | Swings gently |
| Professional  | Geometric mark | Draws itself, stroke by stroke |

**Inline SVG animated with CSS.** No image request, no JavaScript, nothing
that can fail to load — and it scales to any screen without going soft. It
uses `currentColor`, so a salon's scissors come out pink and a garage's
wheel red without a second asset existing anywhere. The whole page
including the artwork is about 20 KB.

**Drawn as objects, not as strokes.** A line of even width reads as a
diagram whatever you do with it. The scissors have tapered blades that come
to a point, handles curving to real finger loops, and a screw at the pivot.
The wheel has tread blocks cut into the tyre, five shaped spokes with the
gaps showing, a centre cap and lug bolts. The tiles are filled and overlap
with a curved top edge; the leaves are two arcs meeting at a tip. Filled
bodies are what make them read as things rather than as icons.

Everything is genuinely in motion — the wheel turns continuously, the
scissors keep snipping, the bubbles keep rising. A screenshot only ever
catches one frame of it.

The art is `aria-hidden` — it carries no information a screen reader needs —
and it is dropped entirely below 900px, where the screen is better spent on
the phone number.

### The headline

Companies House calls a garage "Vehicle maintenance and repair" and a salon
"Hairdressing and beauty". Set as an H1 at display size those run to four
lines, push the phone number off the screen, and read as a database dump.
Nobody searches for them either.

So each register label maps to the words a customer would actually use —
**Servicing & MOT**, **Hair & beauty**, **Plumbing & heating** — and
anything unmapped is trimmed generically to fit. The fuller label still
appears in the eyebrow above, where small caps have room for it.

**Placeholders are honest.** Where their photos go, the page says so.
A dashed empty box reads better than a stock photo of someone else's van,
and it gives you something concrete to ask them for.

## Security

The pages contain text a stranger emailed you, so:

- **Everything is escaped at render.** A reply containing `<script>` renders
  as visible text.
- **Phone numbers are stripped to digits** before going in a `tel:` href.
  Numbers reach the tool from Google Places and from scraped directory
  pages, so a value like `" onmouseover="alert(1)` is attacker-influenced —
  it would otherwise close the attribute and open an event handler. A number
  that survives sanitising is linked; one that does not produces no link.
- **A restrictive CSP** is served with every preview: `default-src 'none'`,
  no scripts at all, styles inline-only. Anything that did slip past the
  escaping still cannot run.
- **`noindex`** in the markup and `X-Robots-Tag` on the response. A mockup
  is a private draft for one prospect.
- **The token is the secret** — 128 bits of randomness. Directory listing is
  off, dotfiles are denied, and path traversal is blocked, so without the
  exact token there is nothing to find.

## What this does not do

**It does not write their copy.** The pages carry real structure and real
service names, with obvious "this is your copy to change" prompts. A local
3B model writing marketing prose produces something worse than a blank —
generic copy is the thing that makes a mockup read as generated.

**It does not host the real site.** This is a pitch, served from your
machine on a private link. Winning the job is where the real build starts.

**It cannot read replies you never received.** If a prospect answers by
phone, paste the gist in — the extractor treats it identically.

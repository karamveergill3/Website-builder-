# Reading replies and building mockups

A prospect replies. The tool reads what they asked for and builds them a
four-page site on a private link. You check it, paste the link into your
answer, and that is the pitch.

## The flow

1. **A reply arrives.** Either the tool reads it from Gmail, or you paste it
   in by hand (a WhatsApp message, notes from a phone call — same pipeline).
2. **A brief is extracted** — services, what they want visitors to do,
   whether they have a logo and photos, brand colours, areas covered.
3. **You check the brief** and correct anything wrong. Twenty seconds.
4. **Build mockup** generates `index`, `services`, `about` and `contact`,
   writes them to disk, and gives you a link.
5. **You send the link.** Nobody finds it without the token.

## How replies are read

Two passes, in this order.

**The rules.** The follow-up template asks three numbered questions, so most
replies come back as "1. … 2. … 3. …" and split deterministically. Keyword
matching then pins down the field that decides the whole layout: what a
visitor should be able to do first.

That third answer is the important one, and its answer space is closed —
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

Four pages, no build step, no external fonts or scripts — everything inlined
so the files open straight from disk.

| Page | What it does |
|---|---|
| `index.html`   | Hero with trade + town, the CTA their answer picked, services, photo slot |
| `services.html`| Each service as its own block with a photo slot |
| `about.html`   | Who they are, area covered, facts panel |
| `contact.html` | Phone, email, hours, area, enquiry-form placeholder |

**Palette follows the trade.** Roofers get slate and high-vis orange; a
salon gets soft pink; a bakery gets warm brown; a landscaper gets green.
This is the single cheapest thing that stops every generated site looking
like the same template. A colour the prospect actually named always beats
the trade default.

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

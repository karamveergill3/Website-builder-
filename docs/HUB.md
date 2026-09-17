# Running Keylo as a team hub

This turns the tool from something on one laptop into a shared hub your reps
reach from anywhere — their own phones included — for free. One PC runs it;
everyone else just opens a link and signs in.

> **Want it online even when your PC is off?** This page covers running the hub
> from your own PC (it's offline whenever the PC sleeps). To put it on a free
> server that stays on 24/7 at a permanent link, follow **[DEPLOY.md](DEPLOY.md)**
> instead — same app, same logins, but always reachable.

Everyone who signs in shares one lead pool and one "already contacted"
memory, so no business is ever approached twice across the team. Each rep
uses their own phone for WhatsApp; the emails carry the Keylo Studios name.

## Sharing the day's leads

The daily hunt has one target for the whole hub (set it under **Settings →
Hunt** — for three of you working 5 each, set it to **15**). As it finds
businesses it shares them out across the active team automatically: the next
find goes to whoever is holding the fewest un-worked leads, so an empty
morning deals evenly (5/5/5) and nobody on holiday gets buried.

On the **Leads** screen, once there is more than one of you:

- an **Owner** column shows whose lead each one is (yours highlighted),
- a **Found today** line reads "You 5 · Bea 5 · Cy 5",
- the **owner dropdown** filters to *Mine*, *Unassigned*, or a named rep,
- ticking leads and choosing **Assign to…** hands a batch to someone else.

A lead you add by hand is yours. Anyone can reassign any lead — handy for
handing a hot one to whoever is free.

---

## What you need

- **The PC that will host it.** It has to stay on and awake while the team is
  working — when it sleeps, the hub goes offline for everyone.
- **Node** (already installed if the tool runs).
- **cloudflared**, a free Cloudflare tool that gives you a public link without
  touching your router. One-time install:
  - Windows: `winget install --id Cloudflare.cloudflared`
  - macOS: `brew install cloudflared`
  - or download it from
    <https://github.com/cloudflare/cloudflared/releases>

Nothing here costs anything. There is no server bill: the hub runs on your
own PC, and Cloudflare's quick tunnel is free.

---

## Start it (every time)

- **Windows:** double-click `scripts\start-hub.cmd`
- **macOS/Linux:** run `scripts/start-hub.sh`

Two windows open: the hub itself, and the tunnel. The tunnel window prints a
line like:

```
https://random-words-here.trycloudflare.com
```

That address **is** your hub. Open it yourself, and send it to your reps.
Leave both windows open — closing them takes the hub offline for everyone.

> The free quick-tunnel address changes each time you restart it. For a
> permanent address that never changes, you can upgrade to a named Cloudflare
> tunnel on a free Cloudflare account with a domain — ask and I'll set that
> up. For getting started today, the changing link is fine: just send the new
> one when you restart.

---

## First run: make your admin account

The very first time anyone opens the hub, it asks you to **create the owner
account**. Do this yourself — it becomes the admin, the only account that can
add or remove reps. Pick a strong password.

## Add your reps

Once you're in, open the **Team** tab (top right, admins only):

1. **Add a rep** — their name, their email (what they sign in with), and a
   temporary password.
2. Send each rep the link, their email, and the password.
3. They open the link, sign in, and can change their own password from the
   corner menu.

You can **suspend** a rep (signs them out at once and blocks them coming
back) or **reset** a password any time from the same screen.

---

## Sending messages — today

- **WhatsApp works immediately, for everyone.** A rep opens a lead → Reach →
  Open WhatsApp, and it opens on *their own phone* with the message ready.
  No setup, no accounts to link. This is the fastest way to have the whole
  team sending today.
- **Email** currently sends from the one Gmail connected under Settings.
  Per-rep Gmail — each person sending email from their own address — is the
  next thing being built.

---

## Keeping it safe

The hub is on the public internet now, so treat the link like a key:

- **The login is the lock.** Nobody sees any data without signing in, so a
  stranger who guesses the link hits a login screen and stops there.
- **Keep the link off public posts** (no Instagram bios, no open group
  chats). Share it directly with your reps.
- **Strong passwords**, especially the admin. Reset anyone who leaves.
- **The hosting PC stays on.** If it sleeps or reboots, restart the launcher
  and send out the new link.

If a rep leaves or a password gets out, suspend the account and/or reset the
password from the Team screen — both take effect instantly.

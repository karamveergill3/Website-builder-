# Putting the hub online 24/7 — for free

This puts Keylo on a small server that runs around the clock at **no cost**, so
your team gets in whether or not your PC is on, at a **permanent link** that
never changes.

The server is **Oracle Cloud's "Always Free"** tier — a real computer that
stays on forever at £0. You do a one-time setup (about 20 minutes). After that
you never touch it again; it just runs.

You'll do six things. I (Claude) prepared a script that does the hard middle
part in one command — most of your job is clicking through sign-ups.

1. Create a free Oracle Cloud account
2. Create the free server
3. Open the two web ports in Oracle's console
4. Get a free web address (DuckDNS)
5. Connect to the server and run one command
6. Paste your API keys and open your hub

> Keep this simple: do the steps in order. If anything looks different from
> what's written (Oracle changes its menus sometimes), tell me what you see and
> I'll steer you.

---

## 1. Create a free Oracle Cloud account

1. Go to <https://www.oracle.com/cloud/free/> and click **Start for free**.
2. Sign up. It asks for a card **to verify you're a real person — the Always
   Free things we use are never charged.** Don't add any paid ("upgrade")
   services and you cannot be billed.
3. When it asks for your **Home Region**, pick the one closest to you (e.g.
   *UK South (London)*). This can't be changed later, so choose your country.
4. Finish and sign in to the **Oracle Cloud Console** (the dashboard).

---

## 2. Create the free server

1. In the console, open the menu (☰, top-left) → **Compute** → **Instances**.
2. Click **Create instance**.
3. **Name:** `keylo-hub` (anything is fine).
4. **Image and shape** → **Edit**:
   - **Image:** click **Change image**, choose **Canonical Ubuntu**, pick
     **24.04** (or 22.04). Select it.
   - **Shape:** click **Change shape**. Prefer **Ampere / VM.Standard.A1.Flex**
     (set 1 OCPU and 6 GB memory — all free). If it says no capacity in your
     region, choose **VM.Standard.E2.1.Micro** instead (also Always Free).
     Both are marked **"Always Free-eligible"** — make sure the one you pick
     has that green label.
5. **SSH keys** (this is how you'll connect):
   - Leave **Generate a key pair for me** selected.
   - Click **Save private key** and **Save public key**. Keep the **private
     key** file somewhere safe on your PC (e.g. `Documents\keylo-key.key`).
     You need it to connect.
6. Leave networking on its defaults (it creates a network and a public subnet
   for you — that's what we want).
7. Click **Create**. Wait ~1 minute until the instance shows **RUNNING**.
8. Copy the **Public IP address** shown on the instance page. You'll use it in
   steps 3 and 5.

---

## 3. Open the two web ports (Oracle console)

Oracle blocks web traffic until you allow it. This is the step people most
often miss — do it carefully.

1. On your instance's page, under **Instance details**, find **Virtual cloud
   network** and click its link.
2. In the left list click **Subnets**, then click the **public** subnet.
3. Click the **Security List** (usually "Default Security List for …").
4. Click **Add Ingress Rules**, and add **two** rules:

   | Field | Rule 1 | Rule 2 |
   |---|---|---|
   | Stateless | leave unticked | leave unticked |
   | Source Type | CIDR | CIDR |
   | Source CIDR | `0.0.0.0/0` | `0.0.0.0/0` |
   | IP Protocol | TCP | TCP |
   | Destination Port Range | `80` | `443` |

5. Click **Add Ingress Rules** to save.

That's the whole console-firewall step. (The server's own firewall is opened
for you by the script in step 5.)

---

## 4. Get a free permanent web address (DuckDNS)

1. Go to <https://www.duckdns.org> and sign in (Google/GitHub/Reddit — one
   click, free).
2. In the box, type a name for your hub, e.g. `keylostudios`, and click **add
   domain**. That gives you **`keylostudios.duckdns.org`** — your permanent
   link.
3. Near the top, copy your **token** (a long code). Keep it handy for step 5.

You don't need to type the IP anywhere — the script points it at your server
and keeps it pointed there.

---

## 5. Connect to the server and run one command

**Connect (from your Windows PC):**

1. Open **PowerShell** (Start menu → type *PowerShell*).
2. Connect using the private key you saved and the public IP from step 2:

   ```powershell
   ssh -i "C:\Users\Karam Gill\Documents\keylo-key.key" ubuntu@YOUR_PUBLIC_IP
   ```

   Type **yes** if it asks about authenticity. You're now on the server (the
   prompt changes to `ubuntu@keylo-hub`).

   > If it complains the key is "too open", run this once, then reconnect:
   > `icacls "C:\Users\Karam Gill\Documents\keylo-key.key" /inheritance:r /grant:r "$($env:USERNAME):(R)"`

**Get the code and install it** — paste these lines one block at a time.

First you need a **read-only GitHub token** so the server can download the
private code:
- On github.com: your avatar → **Settings** → **Developer settings** →
  **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
- **Repository access:** Only select repositories → `website-builder-`.
- **Permissions:** Contents → **Read-only**. Generate it and copy the token.

Now on the server (replace `YOUR_TOKEN` with the token you just copied):

```bash
git clone --branch claude/uk-business-outreach-2yg1xi \
  https://YOUR_TOKEN@github.com/karamveergill3/website-builder-.git keylo
cd keylo
bash scripts/deploy-server.sh
```

The script will ask for your **DuckDNS subdomain** and **token** from step 4,
then do everything else — install Node, install the app, set it to run 24/7,
turn on HTTPS, and open the server firewall. It takes a few minutes.

---

## 6. Paste your API keys and open your hub

The hunt (finding businesses) and PayPal need your keys. On the server:

```bash
nano keylo/.env        # if you're already in the keylo folder, just: nano .env
```

Fill in `COMPANIES_HOUSE_API_KEY`, `GOOGLE_MAPS_API_KEY`, and (if using them)
the Gmail and PayPal values — the same ones from your PC's `.env`. Save with
**Ctrl+O, Enter**, exit with **Ctrl+X**. Then:

```bash
sudo systemctl restart keylo
```

Now open **`https://keylostudios.duckdns.org`** (your address). The first
screen creates your **owner account**. After that, open the **Team** tab and
add your partners — send each of them the link, their email, and a password.
They're in, from anywhere, forever.

> The HTTPS certificate takes a minute the first time. If the link doesn't load
> immediately, wait a minute and refresh. If it still won't load, ports 80/443
> in step 3 are the thing to double-check.

---

## Moving your existing leads over (optional)

If you've already got leads in the version on your PC and want them on the
server, copy the database file up. In **PowerShell on your PC**:

```powershell
scp -i "C:\Users\Karam Gill\Documents\keylo-key.key" `
  "C:\Users\Karam Gill\Website-builder-\data\prospect-book.db" `
  ubuntu@YOUR_PUBLIC_IP:~/keylo/data/prospect-book.db
```

Then on the server: `sudo systemctl restart keylo`. (Do this before you create
accounts on the server, so nothing gets overwritten.)

---

## Living with it

- **Updating to new code I push:** on the server,
  `cd keylo && git pull && bash scripts/deploy-server.sh` — safe to re-run, and
  it restarts the hub for you.
- **Is it running?** `sudo systemctl status keylo`
- **See what it's doing:** `sudo journalctl -u keylo -f` (Ctrl+C to stop
  watching).
- **Restart it:** `sudo systemctl restart keylo`
- **Back up your data:** the file `keylo/data/prospect-book.db` is everything
  (leads, logins, invoices). Copy it down now and then with the `scp` command
  above, reversed.
- **Cost:** £0, as long as you only ever use the Always-Free-labelled server
  and never click "upgrade". Oracle may email about an unused account — just
  sign in occasionally to keep it active.

## Keeping it safe

- The **login is the lock** — nobody sees anything without signing in.
- Keep the link out of public posts; send it straight to your partners.
- Strong passwords, especially the owner account.
- If a partner leaves, **Suspend** them on the Team tab — instant.

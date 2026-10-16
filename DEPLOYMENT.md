# Deploying Project Blue on your own domain

This walks through putting Blue on a real hostname (for example
`problue.run.place`) with TLS, so the agent is reachable at
`https://problue.run.place` from any browser.

---

## What has to happen

Three separate things, and it is worth being clear about which is which:

| Step | What it involves | Where it happens |
| --- | --- | --- |
| 1. Run Blue on a host with a public IP | a VPS, home server, or PaaS | your machine |
| 2. Point the domain at that host | editing a DNS **A record** | your DNS provider |
| 3. Get HTTPS for the domain | automatic, via Caddy + Let's Encrypt | on the host |

A DNS record only says *which IP serves the name*. It cannot make the app
appear — something has to be listening on that IP. That is why step 1 comes
first: until Blue is running somewhere publicly reachable, there is nothing for
the domain to point at.

---

## Step 1 — run Blue on a host

You need a machine with a **public IP** that stays up. Any of these work:

- **A VPS** — Hetzner, DigitalOcean, Linode, Oracle Cloud free tier (~$4–6/mo).
  This guide assumes this path.
- **A home server / Raspberry Pi** — works, but you must forward ports 80 and
  443 on your router, and home IPs are usually dynamic.
- **A PaaS** (Render, Railway, Fly.io) — the container image below runs as-is;
  see *PaaS* at the end.

### Which host to pick

The stack is Caddy + Blue + SearXNG in Docker, so **get 2 GB of RAM, not 1 GB**.
Blue is small (a Node process and a SQLite file), but SearXNG is a Python app
with four worker threads, and on a 1 GB box all three containers plus the Docker
daemon leave it swapping or getting OOM-killed the moment a search runs. 2 GB is
the honest floor for "it just works"; 1 GB works only if you drop the SearXNG
service and use a search API key instead.

| Pick | Spec | Price | Why |
| --- | --- | --- | --- |
| **Hetzner CX22** *(best value)* | 2 vCPU, 4 GB, 40 GB NVMe, 20 TB | ~€3.79–4.51/mo (~₹350–420) | Most RAM per rupee anywhere. Pick the **Singapore** region — it is their closest to India, so expect 40–60 ms rather than 10 ms. New accounts sometimes need a quick ID check, and billing is in EUR. |
| **Vultr — Mumbai** | 1 vCPU, 2 GB, 50 GB NVMe, 2 TB | ~$12/mo (~₹1,050) | An actual Indian datacenter, so ~10–20 ms. Card billing, hourly, easy to destroy. |
| **DigitalOcean — Bangalore (BLR1)** | 1 vCPU, 2 GB, 50 GB SSD, 2 TB | ~$12/mo (~₹1,050) | Same latency story as Vultr Mumbai, with the best documentation of the three. |
| **Linode (Akamai) — Mumbai** | 1 vCPU, 2 GB, 50 GB SSD | ~$12/mo | Equivalent to the two above; free snapshots. |

If you just want the cheapest thing that will hold up: **Hetzner CX22 in
Singapore**. If you would rather keep the round trip inside India: **Vultr
Mumbai or DigitalOcean Bangalore**. Either way the host needs to be a *plain
Linux VPS* — the steps below install Docker on it — and whatever you pick must
allow inbound **80** and **443**.

> You do not need a domain-related product from the host. Your DNS already lives
> at DNS Exit, and that is where step 2 happens.

### With Docker (recommended)

```bash
# On the fresh host, as root (or a sudo user):
curl -fsSL https://get.docker.com | sh

git clone https://github.com/adarsh135/Project-Blue.git
cd Project-Blue

cp .env.deploy.example .env
openssl rand -base64 48        # paste into BLUE_SESSION_SECRET
openssl rand -hex 32           # paste into SEARXNG_SECRET
nano .env                      # set both secrets, DOMAIN, and ACME_EMAIL

docker compose up -d --build
docker compose logs -f caddy
```

That starts three containers:

| Container | Reachable from | Role |
| --- | --- | --- |
| `blue` | the Docker network only | the app, on `/data` (named volume) so the database survives rebuilds |
| `searxng` | the Docker network only | keyless search, configured by `searxng/settings.yml` |
| `caddy` | the internet, on 80 + 443 | TLS, and the only thing exposed |

Nothing but Caddy publishes a port, so the database and the search instance are
not reachable from outside the host.

### Without Docker (systemd + Node)

Requires **Node 22.5 or newer** — Blue uses the built-in `node:sqlite` module,
so there is no database server and no native build step.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin blue
sudo -u blue git clone https://github.com/adarsh135/Project-Blue.git /home/blue/app
cd /home/blue/app && sudo -u blue npm ci --omit=dev

sudo tee /etc/project-blue.env >/dev/null <<'EOF'
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
PUBLIC_URL=https://problue.run.place
BLUE_DATA_DIR=/home/blue/app/data
BLUE_SESSION_SECRET=PASTE_THE_GENERATED_SECRET_HERE
EOF
sudo chmod 600 /etc/project-blue.env

sudo tee /etc/systemd/system/project-blue.service >/dev/null <<'EOF'
[Unit]
Description=Project Blue
After=network-online.target

[Service]
User=blue
WorkingDirectory=/home/blue/app
EnvironmentFile=/etc/project-blue.env
ExecStart=/usr/bin/node --no-warnings server/index.js
Restart=always
RestartSec=3
# node:sqlite keeps a WAL file next to the database
ReadWritePaths=/home/blue/app/data

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now project-blue
sudo systemctl status project-blue
```

Then run Caddy in front of it (it will handle TLS on its own):

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
problue.run.place {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4000 {
		flush_interval -1
	}
}
EOF
sudo systemctl reload caddy
```

> `flush_interval -1` matters. The chat endpoint streams Server-Sent Events; if
> a proxy buffers the response, the answer arrives in one lump at the end
> instead of typing itself out.

---

## Step 2 — point the domain at the host

You need the host's **public IPv4 address**:

```bash
curl -4 -s https://ifconfig.me; echo
```

### At DNS Exit

`problue.run.place` already resolves, so the record exists and needs editing
rather than creating. Log in at **dnsexit.com**, open the DNS zone for
`run.place`, and find the existing entry for the host `problue`:

| Field | Value |
| --- | --- |
| Type | `A` |
| Name / Host | `problue` (DNS Exit may show it as `problue.run.place`) |
| Value / Destination | your server's public IPv4 |
| TTL | `300` while you are setting up |

Replace the current destination — do not add a second A record, or clients will
get a mix of the old and new address and behave intermittently.

Notes:

- **Do not use a CNAME** for this. You are pointing at an IP.
- If the panel only lets you pick one of DNS Exit's own targets, you are looking
  at their *URL forwarding / free subdomain* feature rather than DNS zone
  management. You want the zone editor: **DNS Exit → DNS → your domain → A record**.
- If your host has IPv6, add a matching `AAAA` record. Optional.
- If you are on a home connection with a dynamic IP, DNS Exit's dynamic-DNS
  client can keep the A record updated.

### Verify before continuing

```bash
dig +short problue.run.place          # should print your server's IP
```

Propagation is usually under a minute at TTL 300, but can take longer. Do not
start Caddy until this returns the right address — Let's Encrypt validates by
connecting back to the name, and it will fail while DNS is stale.

---

## Step 3 — HTTPS

Nothing to do. Caddy sees the `problue.run.place` site block, requests a
certificate from Let's Encrypt over HTTP-01, and renews it automatically from
then on. Watch it happen:

```bash
docker compose logs -f caddy
```

Requirements for that to succeed:

- Ports **80 and 443** reachable from the internet (open the firewall /
  security group; forward them if you are behind a router).
- DNS already pointing at the host.

If it does not work, Caddy's log says why, and the usual cause is one of those
two.

---

## Verify the live site

```bash
curl -sI https://problue.run.place | head -20
curl -s  https://problue.run.place/api/status
```

Expected: `Strict-Transport-Security`, `X-Frame-Options: SAMEORIGIN`, and a CSP
header, plus a JSON status body. Then open the domain, register an account, and
send a message.

The session cookie should come back with `Secure`:

```bash
curl -sI -X POST https://problue.run.place/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"Sup3rSecret1"}' | grep -i set-cookie
```

---

## Configuration worth setting

| Variable | Why |
| --- | --- |
| `BLUE_SESSION_SECRET` | **Set it.** Without one, a secret is generated into the data volume; lose the volume and every session is invalidated. |
| `PUBLIC_URL` | `https://problue.run.place`. Used for CSRF origin checks. |
| `NODE_ENV=production` | Turns on HSTS and `X-Frame-Options`; do not serve publicly without it. |
| `SEARXNG_SECRET` | **Set it.** Signs SearXNG's own session cookies. `openssl rand -hex 32`. |
| `DOMAIN` | The name Caddy gets a certificate for. Must match the DNS record. |
| `ACME_EMAIL` | Let's Encrypt expiry notices. Optional but recommended. |
| `BLUE_SEARXNG_URL` | Defaults to the bundled instance. See *About search* below. |
| `OPENAI_API_KEY` etc. | Picks a real model. Without one, Blue answers from its offline engine. |

### About search

**This is already set up for you.** SearXNG ships as the `searxng` service in
`docker-compose.yml`, and the stack points Blue at it by default
(`BLUE_SEARXNG_URL=http://searxng:8080`, resolved over the Docker network by
service name). Nothing to configure, nothing to pay for.

That matters because the fallback lane — scraping DuckDuckGo — is **throttled
per IP**, and a datacenter IP gets hit hardest of all. Blue detects that
anti-bot page and says so rather than pretending there were no results, but it
is not a dependable production backend. SearXNG is: it queries whatever engines
the instance is configured with, and since only Blue can reach this instance,
there is no public traffic to rate limit.

`searxng/settings.yml` exists for one essential reason: SearXNG ships with
`search.formats: [html]` only, and the JSON API that Blue calls has to be
enabled explicitly. Without that file the instance answers `/search?format=json`
with its HTML UI, and Blue reports exactly that.

Precedence, if you configure more than one backend:

```
tavily  >  brave  >  serper  >  searxng  >  duckduckgo (scrape)
```

Details worth knowing:

- **If SearXNG is unreachable** (still booting, or the container died), Blue
  falls back to the keyless scrape for that search instead of failing, and
  reports `duckduckgo` as the provider that actually answered. The tool summary
  says the fallback happened.
- **If SearXNG is misconfigured** (for example the JSON API is off), Blue does
  *not* silently fall back. It raises an error naming the setting, because that
  is a problem you are meant to fix, not one to route around.
- **To use a different instance**, set `BLUE_SEARXNG_URL` in `.env`. To drop the
  lane entirely, set it empty (`BLUE_SEARXNG_URL=`) and set `TAVILY_API_KEY` or
  one of the others.

Confirm which lane is live:

```bash
curl -s https://problue.run.place/api/status | grep -o '"search":{[^}]*}'
```

You want `"provider":"searxng"`. To check the instance itself, ask the *Blue*
container to reach it — that also proves the `searxng` hostname resolves across
the compose network, which is the thing the app actually depends on:

```bash
docker compose exec blue node -e "
  fetch('http://searxng:8080/search?q=test&format=json')
    .then(r => r.text())
    .then(t => console.log(t.slice(0, 200)))
"
```

A JSON body starting `{"query":...` means it is working. An HTML body means the
`json` format is missing from `searxng/settings.yml`.

---

## Backups

Everything is one SQLite file plus the session secret:

```bash
docker compose exec blue sh -c 'ls -la /data'
docker run --rm -v project-blue_blue-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/blue-$(date +%F).tar.gz -C /data .
```

SQLite runs in WAL mode, so copying the file while the app is running can miss
recent commits. Either stop the container first, or use the SQLite backup API:

```bash
docker compose exec blue node -e "
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync('/data/blue.db');
  db.exec(\"VACUUM INTO '/data/backup.db'\");
  console.log('ok');
"
```

---

## Troubleshooting

**`docker compose up` stops with `set SEARXNG_SECRET in .env`** — the bundled
search instance refuses to start with a default secret. Run
`openssl rand -hex 32` and paste it into `SEARXNG_SECRET`.

**`web_search` reports it fell back to DuckDuckGo** — SearXNG was unreachable
for that search. Check `docker compose ps` and `docker compose logs searxng`.
The search still answered, so this is a warning rather than a failure; the
`searxng_last` block in `/api/status` records the reason.

**`web_search` fails with "…answered with text/html instead of JSON"** — the
JSON API is off on that instance. `searxng/settings.yml` in this repo enables it
under `search.formats`; if you edited that file, keep both `html` and `json`.
Note that `search.formats` is *replaced*, not merged, so listing only `json`
turns the web UI off.

**`web_search failed … anti-bot challenge`** — you are on the keyless DuckDuckGo
lane, meaning `BLUE_SEARXNG_URL` is empty and no API key is set. Either let it
default to the bundled instance, or set one of the search keys.

**Certificate never issues** — DNS not updated yet, or 80/443 blocked. Check
`dig +short your.domain` first, then the Caddy log.

**`fetch_page` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`** — the host is
behind a TLS-inspecting proxy. Point `NODE_EXTRA_CA_CERTS` at the proxy CA
bundle.

**Chat answers appear all at once instead of streaming** — a proxy is buffering
SSE. Ensure `flush_interval -1` on the reverse proxy (both configs above set it).

**Logged out after every deploy** — `BLUE_SESSION_SECRET` is changing, or the
data volume is not mounted at `/data`.

---

## PaaS

The `Dockerfile` is self-contained, so Render, Railway, and Fly.io can build it
directly. Two things to change from the Compose setup:

- Let the platform provide `PORT`; Blue reads it.
- Mount a **persistent volume** at `/data` and set `BLUE_SESSION_SECRET`
  explicitly. On platforms with ephemeral filesystems, an unmounted `/data`
  loses accounts and chat history on every redeploy.
- Skip Caddy — the platform terminates TLS. Then point your DNS record at the
  hostname the platform gives you.

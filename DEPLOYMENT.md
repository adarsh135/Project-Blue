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

### With Docker (recommended)

```bash
git clone https://github.com/adarsh135/Project-Blue.git
cd Project-Blue

cp .env.deploy.example .env
openssl rand -base64 48        # paste the output into BLUE_SESSION_SECRET
nano .env                      # set BLUE_SESSION_SECRET and ACME_EMAIL

docker compose up -d --build
docker compose logs -f caddy
```

That starts two containers: Blue itself (bound only to the Docker network) and
Caddy (bound to 80/443), with the SQLite database on a named volume so it
survives rebuilds.

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
| `BLUE_SEARXNG_URL` | Makes `web_search` dependable without paying for an API key. See below. |
| `OPENAI_API_KEY` etc. | Picks a real model. Without one, Blue answers from its offline engine. |

### About search

If you set no search backend, `web_search` falls back to scraping DuckDuckGo,
which is **throttled per IP** and will eventually answer your server with an
anti-bot page. Blue detects that and tells you instead of pretending there were
no results — but it is not a dependable production backend.

Two ways to fix it:

```bash
# Keyless: run SearXNG alongside Blue, add "json" to its search.formats
docker run -d --name searxng -p 8080:8080 searxng/searxng
# then set BLUE_SEARXNG_URL=http://searxng:8080 (same Docker network)
```

Or set `TAVILY_API_KEY` / `BRAVE_API_KEY` / `SERPER_API_KEY`.

Either way, confirm with:

```bash
curl -s https://problue.run.place/api/status | grep -o '"search":{[^}]*}'
```

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

**`web_search failed … anti-bot challenge`** — expected on the keyless lane.
Set `BLUE_SEARXNG_URL` or a search API key.

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

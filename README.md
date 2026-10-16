# ◈ Project Blue

**A self-hosted agentic AI assistant — with a real credential system, sessions, durable memory and per-user recent searches.**

Blue is what you get when you take the assistant experience you're used to (plan → use tools → cite sources → remember you) and build it as plain, inspectable Node.js you own: one process, one SQLite file, zero required API keys.

![status](https://img.shields.io/badge/tests-78%20passing-brightgreen) ![node](https://img.shields.io/badge/node-%E2%89%A522.5-blue) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Why it exists

Most "AI chat" repos are a thin wrapper around one vendor's SDK. Project Blue is the other half of the product: the part that makes an assistant *yours*.

| Capability | What ships |
| --- | --- |
| 🔐 **Credential system** | scrypt-hashed passwords (N=32768, per-user salt), revocable login sessions per device, one-time-visible `blue_sk_…` API keys stored only as SHA-256 hashes, and an audit log of every credential event |
| 🧵 **Sessions** | Cookie sessions (HttpOnly + SameSite=Lax + double-submit CSRF token), device-aware session list, revoke one / revoke all, password change invalidates other devices |
| 💬 **Conversations** | Persistent chats with derived titles, pin/archive, full-text search across *and* inside conversations |
| 🔎 **Recent searches** | Every web search the agent (or you) runs is recorded per user with provider, result count, snippets, pinning and day grouping |
| 🧠 **Memory** | Durable `key → value` facts the agent writes when you say "remember…", injected into every future system prompt |
| 🧰 **Agent loop** | Streaming tool-calling loop: `web_search`, `fetch_page`, `calculator`, `clock`, `memory`, `session_search`, `search_history` |
| 🔌 **Any model** | OpenAI-compatible, Anthropic, Gemini, Ollama — or the built-in **Blue Local Engine** that runs with no key at all |
| 🌗 **Real UI** | Dark/light theme, streaming markdown with copyable code blocks, collapsible tool-call cards, recent-searches rail, memory and account panels |

---

## Quick start

```bash
git clone https://github.com/adarsh135/Project-Blue.git
cd Project-Blue
npm install
npm start
# → http://localhost:4000
```

Create an account on the sign-up tab and start talking. That's the whole setup — no API key, no database server, no Docker.

Optional, to make it smarter:

```bash
cp .env.example .env
# add ANY ONE of:
#   OPENAI_API_KEY=sk-…        (or any OpenAI-compatible base URL)
#   ANTHROPIC_API_KEY=sk-ant-…
#   GEMINI_API_KEY=…
#   OLLAMA_BASE_URL=http://localhost:11434   (local models, still no key)
# and optionally a search provider:
#   TAVILY_API_KEY=… / BRAVE_API_KEY=… / SERPER_API_KEY=…
```

Blue picks the provider automatically; per-account you can switch provider, model, temperature, system prompt and enabled tools in **Settings**.

---

## Try these

| Message | What happens |
| --- | --- |
| `remember my timezone is Asia/Kolkata` | agent writes a memory, then uses it in later answers |
| `what time is it in Asia/Kolkata?` | `clock` tool, real IANA timezone maths |
| `calc (1250 * 1.18) / 3` | `calculator` tool — exact, no hallucinated arithmetic |
| `search the web for the latest Node.js LTS release` | `web_search` → cited markdown links, logged in Recent searches |
| `read https://api.github.com/repos/nodejs/node` | `fetch_page` — the readable text of that URL, pretty-printed for APIs |
| `show my recent searches` | `search_history` tool renders your own search log |
| `find in my chats about sqlite` | `session_search` across every message you've ever sent |
| `who are you?` | Blue explains its own credential/session/memory architecture |

---

## Architecture

```
                         ┌──────────────────────── browser ────────────────────────┐
                         │  index.html + ES modules   (no build step, no bundler)  │
                         │  api.js → cookie + x-blue-csrf header, SSE reader        │
                         └───────────────▲──────────────────────┬──────────────────┘
                                         │ fetch/SSE            │
┌────────────────────────────────────────┴──────────────────────▼──────────────────┐
│ server/index.js — express 5                                                      │
│  security headers · CSP · JSON body limit · request log · auth middleware         │
│                                                                                  │
│  /api/auth/*  auth.routes.js      register · login · logout · me · password ·     │
│                                   sessions (devices) · api keys · audit events    │
│  /api/*       api.routes.js       conversations · SSE chat · recent searches ·    │
│                                   memories · settings · tools · stats             │
│                                                                                  │
│  agent/agent.js  ← the loop: history → tools → stream → tool calls → stream again │
│    ├── prompt.js       system prompt: identity, tool rules, memory, search log     │
│    ├── providers.js    streaming adapters (OpenAI / Anthropic / Gemini / Ollama)   │
│    ├── local-engine.js offline fallback engine (intent → tool → answer writer)     │
│    ├── tools.js        tool schemas + execution + result rendering                 │
│    └── math.js         sandboxed arithmetic parser (no eval)                       │
│                                                                                  │
│  db.js — node:sqlite schema, migrations, queries                                  │
│  auth.js — scrypt, sessions, API keys, CSRF, rate limiting                        │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
                                 data/blue.db (SQLite, WAL)
```

### The agent loop, concretely

1. The user's turn is persisted, the chat is titled from the first message.
2. Context is assembled: custom/system prompt + stored memories + the 8 most recent searches + up to 400 stored messages.
3. The provider streams tokens. `text` events go straight to the browser; `tool_call` events are queued.
4. If the model asked for tools, the assistant turn is persisted *with its tool calls*, each tool runs, and every result is persisted as a `tool` message.
5. Results are fed back and the model streams again — up to `BLUE_MAX_TOOL_ROUNDS` (default 4) rounds, so no runaway loops.
6. The final answer is persisted with provider, model, latency and token counts. If a remote provider is unreachable, Blue emits a visible notice and re-answers with the offline engine rather than showing an error.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the data model, the auth flow and the SSE protocol.

---

## The Blue Local Engine (offline mode)

With no provider key configured, `local-engine.js` takes over. It is **not** a language model — it's an honest deterministic planner:

* classifies the request (greeting, identity, capabilities, web search, maths, clock, memory read/write, session search, search history, general);
* emits the same `tool_call` events a model would, so the agent loop, persistence and UI are identical;
* writes the final answer **from the tool output** — real calculators, real timestamps, real memories, real search results — instead of inventing facts;
* explains failures ("`web_search` failed because no provider answered — add `TAVILY_API_KEY`…") rather than hallucinating an answer.

That means the credential system, sessions, recent searches, memory and the whole UI are fully exercisable with zero keys, and plugging in a model later changes only the brain, not the plumbing.

---

## HTTP API

Everything the web app does is a documented JSON endpoint, so you can drive Blue from a script.

```bash
# 1. create an account (returns a session cookie + CSRF cookie)
curl -c jar -X POST localhost:4000/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"BlueDemo2026!"}'

# 2. mint an API key for machine access
curl -b jar -X POST localhost:4000/api/auth/keys \
  -H 'content-type: application/json' -H "x-blue-csrf: $(grep blue_csrf jar | awk '{print $7}')" \
  -d '{"label":"cli"}'
# → {"plaintext":"blue_sk_1a2b3c4d_…"}   (shown once)

# 3. one-shot chat with a tool-using agent
curl -X POST localhost:4000/api/chat \
  -H "Authorization: Bearer blue_sk_…" -H 'content-type: application/json' \
  -d '{"content":"search for the latest sqlite release"}'
# → {"answer":"…","tools_used":["web_search"],"provider":"local", …}
```

| Method & path | Purpose |
| --- | --- |
| `POST /api/auth/register` · `login` · `logout` | account + session lifecycle |
| `GET/PATCH /api/auth/me` | profile |
| `POST /api/auth/password` | change password (revokes other sessions) |
| `GET/DELETE /api/auth/sessions[/:id]` | list / revoke login sessions |
| `GET/POST /api/auth/keys`, `DELETE /api/auth/keys/:id` | API keys |
| `GET /api/auth/events` | credential audit log |
| `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/:id` | conversations |
| `POST /api/sessions/:id/messages` | **SSE** chat stream (`start`, `title`, `text`, `tool_start`, `tool_result`, `usage`, `done`, `error`, `close`) |
| `POST /api/chat` | one-shot JSON chat (great for API keys) |
| `GET /api/messages/search?q=` | search every message you've sent |
| `GET /api/searches` · `POST /api/searches` · `POST /api/searches/:id/pin` · `DELETE /api/searches[/:id]` | recent searches |
| `GET/POST /api/memories`, `DELETE /api/memories/:id` | memory |
| `GET/PUT /api/settings`, `GET /api/tools` | engine + tool configuration |
| `GET /api/stats`, `GET /api/status` | counters, engine health |

---

## Web search

`web_search` picks the first configured backend:

```
Tavily → Brave → Serper → SearXNG → keyless DuckDuckGo
```

The first three need a key. **SearXNG is the keyless option that actually holds up** — search
no longer depends on somebody else's throttling policy. It aggregates whatever engines its
instance is configured with, and there is no per-IP anti-bot campaign aimed at a private
instance.

`docker-compose.yml` runs one next to Blue and points the app at it, so the hosted path needs
no configuration. To run it by hand:

```bash
docker run -d --name searxng -p 8080:8080 searxng/searxng
# then, in .env:
BLUE_SEARXNG_URL=http://localhost:8080
```

The instance needs `json` in its `search.formats` setting — the image defaults to `html` only.
`searxng/settings.yml` enables it for the bundled service; a hand-rolled `docker run` like the
one above will answer with HTML, and Blue detects that and says exactly which setting to change
rather than failing vaguely.

Two failure modes are deliberately treated differently:

* **Unreachable** (still booting, container died) — Blue falls back to the keyless scrape for
  that search and reports `duckduckgo` as the provider that actually answered, so a degradation
  is never mistaken for the configured backend having worked.
* **Misconfigured** — no silent fallback. The error names the setting, because that is a bug to
  fix, not one to route around.

Only with none of the above does `web_search` fall back to DuckDuckGo's keyless endpoints: the
Instant Answer API for entity/definition facts, then the `html.duckduckgo.com` and
`lite.duckduckgo.com` SERP lanes over **POST** with a `Referer` (DuckDuckGo tolerates this far
longer than a GET) and a minimum spacing between requests.

Be aware of what keyless means in practice: DuckDuckGo rate-limits per IP and, once a machine
is flagged, answers with an **anti-bot challenge page served as HTTP 202**. `fetch` treats 202
as success, so a naive scraper reads that as "0 results" and tells you your query matched
nothing. Blue detects the challenge (status, `anomaly.js`, the modal markup) and says so:

```
⚠️ web_search failed
DuckDuckGo served an anti-bot challenge instead of results (HTTP 202).
This is an IP-reputation block on the machine running Blue, not a problem with your query.
```

`GET /api/status` reports the active backend and the last outcome, so you can tell a block
from an empty result set without reading logs:

```json
"search": { "provider": "duckduckgo", "keyless": true,
            "last": { "results": 0, "blocked": true, "error": null } }
```

If you see `blocked: true` more than occasionally, move off the scrape lane: set
`BLUE_SEARXNG_URL` at your own instance, or one of `TAVILY_API_KEY`, `BRAVE_API_KEY`,
`SERPER_API_KEY`. The failed attempt is still recorded in Recent searches with
`provider: 'unavailable'`, so your history stays honest about what happened.

---

## Model lifecycle

Vendors retire model IDs on their own schedule, and a stale `.env` otherwise shows up as a
mystery 404 in the middle of a conversation. Blue ships current defaults, recognises retired
IDs, and turns the vendor's error into one that names the replacement:

| Provider | Default | Retired IDs it will catch |
| --- | --- | --- |
| OpenAI-compatible | `gpt-5.6-terra` | `gpt-4o-mini`, `gpt-4o` (flagged as deprecated) |
| Anthropic | `claude-sonnet-5` | the whole Claude 3/3.5/3.7 line, Opus 4.1 |
| Google Gemini | `gemini-3.8-flash` | every Gemini 1.x and 2.0 model |
| Ollama | `llama3.1` | — (local tags, no vendor lifecycle) |

```
gemini request failed (HTTP 404). model "gemini-1.5-flash" was retired by the provider on
2025-09-29. Update your .env to gemini-3.8-flash.
```

`GET /api/status` also lists anything stale under `stale_models`. A test asserts that no
shipped default is a model a vendor has already retired, and that every replacement named in
the registry is itself still current.

Two provider-specific notes: Gemini authenticates with the documented `x-goog-api-key` header
rather than the legacy `?key=` query parameter, and sampling parameters (`temperature`,
`top_p`, `top_k`) are omitted for Gemini 3.x and later, where Google deprecated them.

---

## Deployment

One command on any host with a public IP — Docker Compose plus Caddy, which
obtains and renews the TLS certificate for your domain automatically:

```bash
cp .env.deploy.example .env      # set BLUE_SESSION_SECRET, DOMAIN, ACME_EMAIL
docker compose up -d --build
```

Then point an **A record** at the host's public IP. Full walkthrough, including
a systemd-only path and the DNS steps, is in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

Two things that catch people out, both covered there: a DNS record says which
IP serves the name and nothing more — something has to be listening on that IP
first — and the reverse proxy must not buffer responses, because chat answers
stream over SSE and will otherwise arrive in one lump at the end.

---

## Security notes

* **Passwords** — scrypt (`N=32768, r=8, p=1`, 64-byte key, per-user random salt). Login failures are indistinguishable between "unknown email" and "wrong password".
* **Sessions** — random 256-bit token, only its SHA-256 stored. HttpOnly + SameSite=Lax cookie with a separate readable CSRF cookie; state-changing requests must present the matching `x-blue-csrf` header or a same-origin `Origin`/`Referer`.
* **API keys** — `blue_sk_<prefix>_<secret>`; only the SHA-256 of the secret is stored, the plaintext is shown exactly once, comparison is timing-safe, and keys can be revoked per key.
* **Rate limiting** — login/register limits per IP, per-user message throughput cap.
* **Isolation** — every query is scoped by `user_id`; a foreign chat id returns 404, never data.
* **Headers** — strict CSP (`default-src 'self'`), `nosniff`, referrer policy, HSTS + `X-Frame-Options` in production. Markdown is escaped before formatting, so model or web output cannot inject markup.
* **Tools** — the calculator is a hand-written recursive-descent parser (no `eval`), `fetch_page` only allows `http(s)`, and the schema keeps Gemini/Anthropic happy without loosening validation.

Deployment checklist: set `BLUE_SESSION_SECRET`, run behind TLS (`PUBLIC_URL=https://…`), set `NODE_ENV=production`, and back up `data/blue.db`.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | listen address |
| `BLUE_SESSION_SECRET` | generated into `data/.session-secret` | session signing/derivation secret |
| `SESSION_TTL_HOURS` | `168` | login session lifetime |
| `BLUE_DATA_DIR` | `./data` | SQLite + secret location |
| `BLUE_MAX_TOOL_ROUNDS` | `4` | agent loop cap per turn |
| `BLUE_FORCE_LOCAL_ENGINE` | `false` | ignore provider keys, always use the offline engine |
| `BLUE_SEARCH_OFFLINE` | `false` | never make outbound search requests |
| `BLUE_LOCAL_TOKEN_DELAY_MS` | `12` | offline-engine stream pacing |
| `OPENAI_*`, `ANTHROPIC_*`, `GEMINI_*`, `OLLAMA_*` | – | model providers |
| `TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY` | – | commercial search providers (see *Web search* below) |
| `BLUE_SEARXNG_URL` | `http://searxng:8080` in Compose | self-hosted SearXNG — keyless and dependable; empty drops the lane |
| `BLUE_SEARCH_MIN_INTERVAL_MS` | `3000` | spacing between keyless DuckDuckGo requests |
| `BLUE_SEARCH_DDG_BASE` | – | send keyless lanes to a mirror/proxy instead of duckduckgo.com |

---

## Tests

```bash
npm test        # 78 tests, ~8s, no network required
```

* `tests/math.test.js` — the calculator, including rejected code-execution attempts
* `tests/markdown.test.js` — escaping/XSS, tables, links, fenced code
* `tests/local-engine.test.js` — intent routing, tool selection, answer synthesis, no stale tool output
* `tests/api.test.js` — boots the real server on a random port: registration validation, identical login failures, CSRF blocking, API-key auth, per-user isolation, search recording/pinning, session revocation, password change
* `tests/ui.test.js` — loads `index.html` into jsdom against the live server and drives the real modules: register → shell renders → send → streamed answer → tool card → history reload → theme toggle
* `tests/frontend-contract.test.js` — every DOM id the JS uses exists, every view has a section, CSP-safe HTML
* `tests/compatibility.test.js` — no default model is one a vendor has retired, retired-ID errors name their replacement, and a DuckDuckGo anti-bot challenge is reported as a block rather than as "no results"
* `tests/search-live.test.js` — the search lanes against a **real HTTP server on a real socket**: a real 202 is detected, the POST body and `Referer` really arrive, lane fallback works, a SearXNG instance is consumed as JSON and explained when it is not, and an unreachable one degrades to the keyless lane while a misconfigured one refuses to

---

## Project layout

```
server/
  index.js            express app, headers, static hosting, error handling
  config.js           env + .env loading, provider discovery
  db.js               schema, migrations, all queries
  auth.js             scrypt, sessions, API keys, CSRF, rate limiting
  routes/auth.routes.js  credential + account endpoints
  routes/api.routes.js   product endpoints incl. the SSE chat stream
  agent/agent.js      the agent loop
  agent/prompt.js     system prompt construction
  agent/providers.js  streaming adapters per provider
  agent/local-engine.js  offline deterministic engine
  agent/tools.js      tool schemas, execution, rendering
  agent/math.js       sandboxed arithmetic
public/
  index.html          auth screen + app shell (all views)
  css/app.css         design tokens, dark/light themes, components
  js/app.js           boot, auth, routing, event bus wiring
  js/chat.js          transcript rendering + SSE streaming
  js/panels.js        conversations, searches, memory, tools, settings, account
  js/api.js           fetch wrapper (cookies + CSRF) and SSE reader
  js/markdown.js      XSS-safe markdown renderer
  js/ui.js            DOM helpers, toasts, modals
  js/store.js         client state + event bus
tests/                78 tests
Dockerfile            production image (Node 22, non-root, healthcheck)
docker-compose.yml    Blue + SearXNG + Caddy; database on a named volume
searxng/settings.yml  instance config — enables the JSON API Blue calls
Caddyfile             automatic HTTPS, SSE-aware proxy config
DEPLOYMENT.md         domain, TLS and backup walkthrough
docs/ARCHITECTURE.md  data model, flows, SSE protocol
```

---

## Roadmap

- [ ] Tool plugins loaded from a `tools/` folder (bring your own tools)
- [ ] File attachments and vision input
- [ ] Multi-user spaces, sharing and read-only links
- [ ] Background jobs (scheduled searches, digests)
- [ ] Postgres adapter for horizontal scale
- [x] Docker image (`Dockerfile` + `docker-compose.yml` + `Caddyfile`, see [DEPLOYMENT.md](DEPLOYMENT.md))

## License

MIT — do what you want, keep the notice.

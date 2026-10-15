# ◈ Project Blue

**A self-hosted, agentic AI assistant — with secure accounts, multimodal chat, deep research, durable memory and per-user search history.**

Blue is an inspectable Node.js assistant you can run locally or deploy to Vercel. It works offline with SQLite and its deterministic local engine, and uses Neon Postgres plus your chosen model/search providers for a durable, hosted deployment.

![status](https://img.shields.io/badge/tests-automated-brightgreen) ![node](https://img.shields.io/badge/node-%E2%89%A522.5-blue) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

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
| 🧰 **Agent loop** | Bounded streaming tool calls: web search, multi-query deep research, safe page reading, precise maths, CSV statistics/charts, memory, and chat/search-history lookup |
| 🧠 **Work modes** | Reasoning summaries, research, coding, planning and writing prompts; customizable system prompt; guardrails against fabricated actions and private chain-of-thought |
| 🖼️ **Multimodal input** | Text/code/CSV, images, PDFs, audio and video attachments, routed to providers that support each format; browser dictation and read-aloud where available |
| 🔌 **Any model** | OpenAI-compatible, Anthropic, Gemini, Ollama — or the built-in **Blue Local Engine** that runs with no model key |
| 🌐 **Research & analysis** | Source-linked research briefs and deterministic local CSV summaries with missing-value checks, grouped data and chart rendering |
| ☁️ **Deployable** | SQLite for local installs; Neon/Postgres for durable serverless data on Vercel, with a single Express function and static assets |
| 🌗 **Real UI** | Dark/light theme, copyable code, sandboxed HTML previews, collapsible tool cards, attachment chips, search rail, memory and account panels |

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

Blue picks the provider automatically; per-account you can switch provider, model, temperature, work mode, system prompt and enabled tools in **Settings**.

---

## Deploy on Vercel

The repository includes a Vercel Node.js Function entry point (`api/index.js`) and `vercel.json` routing for the Express app, SSE chat stream and browser assets. Local SQLite is intentionally **not** used for production data on Vercel because function filesystems are ephemeral.

1. Import this repository into Vercel and use **Node.js 22** (the version required by `package.json`). No frontend build command or output directory is needed.
2. Provision a Neon Postgres database (for example, through the Vercel Marketplace) and add its pooled connection string as `DATABASE_URL` or `POSTGRES_URL`.
3. Add `BLUE_SESSION_SECRET` with at least 32 characters. Generate one with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` and keep the same value across deployments/environments where sessions should remain valid.
4. Add at least one model provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`) and, for reliable current research, a search key (`TAVILY_API_KEY`, `BRAVE_API_KEY` or `SERPER_API_KEY`). Blue can run without a model key, but its offline planner is intentionally limited.
5. Redeploy, then visit the Vercel domain and create an account. Configure all credentials in Vercel's Environment Variables; never commit them to the repo.

`vercel.json` sets a 60-second function duration and includes the `public/` assets used by Express. Confirm that duration is available on your Vercel plan. The database URL and session secret are required by the app at production cold start; a missing or invalid value fails early rather than silently losing user data. See [docs/VERCEL.md](docs/VERCEL.md) for storage, environment, streaming and troubleshooting notes.

---

## Try these

| Message | What happens |
| --- | --- |
| `remember my timezone is Asia/Kolkata` | agent writes a memory, then uses it in later answers |
| `what time is it in Asia/Kolkata?` | `clock` tool, real IANA timezone maths |
| `calc (1250 * 1.18) / 3` | `calculator` tool — exact, no hallucinated arithmetic |
| `search the web for the latest Node.js LTS release` | `web_search` → cited markdown links, logged in Recent searches |
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
│ server/app.js — Express 5 app (shared by local server and Vercel function)        │
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
│  db.js — async SQL layer, migrations and persistent rate limits                  │
│  auth.js — scrypt, sessions, API keys, CSRF, rate limiting                        │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
                 local: data/blue.db (SQLite/WAL) · Vercel: Neon/Postgres
```

### The agent loop, concretely

1. The user's turn is persisted, the chat is titled from the first message.
2. Context is assembled from the system/custom prompt, stored memories, recent searches and a bounded conversation history (160 messages and 240,000 characters by default).
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

## Security notes

* **Passwords** — scrypt (`N=32768, r=8, p=1`, 64-byte key, per-user random salt). Login failures are indistinguishable between "unknown email" and "wrong password".
* **Sessions** — random 256-bit token, only its SHA-256 stored. HttpOnly + SameSite=Lax cookie with a separate readable CSRF cookie; state-changing requests must present the matching `x-blue-csrf` header or a same-origin `Origin`/`Referer`.
* **API keys** — `blue_sk_<prefix>_<secret>`; only the SHA-256 of the secret is stored, the plaintext is shown exactly once, comparison is timing-safe, and keys can be revoked per key.
* **Rate limiting** — login/register limits per IP, per-user message throughput cap.
* **Isolation** — every query is scoped by `user_id`; a foreign chat id returns 404, never data.
* **Headers** — strict CSP (`default-src 'self'`), `nosniff`, referrer policy, HSTS + `X-Frame-Options` in production. Markdown text is escaped; HTML previews use a sandboxed opaque-origin iframe with scripts, links and external requests disabled.
* **Attachments & tools** — per-file, per-turn and request-size validation; provider-specific modality checks; CSV is parsed locally without executing uploaded code. The calculator is a recursive-descent parser (no `eval`), and `fetch_page` only allows `http(s)` URLs.

Deployment checklist: for a local server, keep `data/` backed up and set `BLUE_SESSION_SECRET` if you need a secret shared across replicas. For Vercel, use Neon/Postgres and a stable `BLUE_SESSION_SECRET` as described above; do not treat `/tmp` or SQLite files as durable hosted storage.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | listen address |
| `BLUE_SESSION_SECRET` | generated into `data/.session-secret` locally | stable session secret; required (32+ characters) on Vercel production |
| `DATABASE_URL` / `POSTGRES_URL` | unset | Neon/Postgres connection; local default is SQLite, Vercel production requires Postgres |
| `SESSION_TTL_HOURS` | `168` | login session lifetime |
| `BLUE_DATA_DIR` | `./data` locally; `/tmp/project-blue` on Vercel | SQLite + secret location (ephemeral on Vercel; do not use for production data) |
| `BLUE_MAX_TOOL_ROUNDS` | `4` | agent loop cap per turn |
| `BLUE_MAX_HISTORY_MESSAGES` | `160` | maximum stored messages included in a turn |
| `BLUE_MAX_CONTEXT_CHARS` | `240000` | bounded prompt/history character budget |
| `BLUE_FORCE_LOCAL_ENGINE` | `false` | ignore provider keys, always use the offline engine |
| `BLUE_SEARCH_OFFLINE` | `false` | never make outbound search requests |
| `BLUE_LOCAL_TOKEN_DELAY_MS` | `12` | offline-engine stream pacing |
| `OPENAI_*`, `ANTHROPIC_*`, `GEMINI_*`, `OLLAMA_*` | – | model providers |
| `TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY` | – | search providers (keyless DuckDuckGo otherwise) |

---

## Tests

```bash
npm test        # 57 tests, ~10s, no network required
```

* `tests/math.test.js` — exact arithmetic and rejected code-execution attempts
* `tests/markdown.test.js` — escaping/XSS, links, code fences and sandboxed HTML-preview lifecycle
* `tests/capabilities.test.js` — attachment validation, provider-specific multimodal payloads, CSV parsing/analysis and work-mode prompts
* `tests/local-engine.test.js` — intent routing, tool selection, answer synthesis and no stale tool output
* `tests/api.test.js` — live HTTP auth/session/API-key, CSRF, user isolation, search/memory, settings and CSV-attachment coverage
* `tests/ui.test.js` — jsdom browser flow: register → stream a turn → attach/remove/analyze a CSV → history reload → theme
* `tests/deployment.test.js` — Vercel routing/entry point, production-env fail-fast checks, API health and static-asset smoke test
* `tests/frontend-contract.test.js` — DOM IDs, view sections, CSP-safe HTML and stylesheet tokens

---

## Project layout

```
api/index.js          Vercel Node.js Function entry point (exports the Express app)
server/
  app.js               shared Express app, security headers, API and static hosting
  index.js             standalone local listener and session cleanup
  config.js            environment loading, database/provider discovery
  db.js                async SQLite/Neon Postgres layer, schema and rate limits
  auth.js              scrypt, sessions, API keys, CSRF, rate limiting
  routes/               authentication and product API endpoints
  agent/                 mode prompts, providers, tools and local fallback engine
public/
  index.html            auth screen + app shell (all views)
  css/app.css           themes, composer, attachments and artifact preview styles
  js/                   frontend modules for chat, panels, state, API and markdown
tests/                  57 tests
docs/ARCHITECTURE.md    data model, flows and SSE protocol
docs/VERCEL.md          deployment steps, secrets, persistence and troubleshooting
vercel.json             serverless rewrite, function duration and included assets
```

---

## Roadmap

- [ ] Tool plugins loaded from a `tools/` folder (bring your own tools)
- [ ] Multi-user spaces, sharing and read-only links
- [ ] Background jobs (scheduled searches, digests)
- [ ] Docker image

## License

MIT — do what you want, keep the notice.

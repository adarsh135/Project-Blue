# Project Blue — architecture

The app has one Express 5 application shared by the standalone Node server and the Vercel Node.js Function. Local installs use SQLite; serverless production uses Neon/Postgres because Vercel function filesystems are ephemeral. No frontend build or bundler is required.

---

## 1. Data model

```
users ─┬─ credentials   (kind: password | api_key)   ── hashed secrets
       ├─ sessions      (login sessions, revocable, device aware)
       ├─ chat_sessions (conversations) ── messages (user | assistant | tool)
       ├─ searches      (recent searches, per user)
       ├─ memories      (durable key/value facts)
       ├─ settings      (provider, model, work mode, temperature, tools, theme)
       └─ auth_events   (credential audit log)
```

Key columns:

| table | columns that matter |
| --- | --- |
| `users` | `email` (unique, normalised), `password_hash` (`scrypt$N$r$p$salt$hash`) |
| `credentials` | `kind`, `prefix`, `secret_hash` (SHA-256), `scopes`, `revoked_at`, `last_used_at` |
| `sessions` | `token_hash` (SHA-256 of `sessionId.secret`), `user_agent`, `ip`, `expires_at`, `revoked_at` |
| `chat_sessions` | `title`, `provider`, `model`, `pinned`, `archived`, `updated_at` |
| `messages` | `role`, `name`, `tool_call_id`, `content`, `tool_calls` (JSON), `attachments` (JSON), `tokens_in/out`, `latency_ms` |
| `searches` | `query`, `provider`, `result_count`, `results` (JSON), `source` (`agent`\|`user`), `pinned` |
| `memories` | unique `(user_id, key)` → `value`, `source` (`agent`\|`user`) |
| `auth_events` | `event`, `status`, `ip`, `user_agent`, `detail` |

SQLite uses `journal_mode=WAL` and `foreign_keys=ON`. Hosted Postgres DDL/migrations run once per function cold start; all queries await the shared database-ready promise. Deleting a user cascades to every row they own. Additive migrations keep existing local databases working.

---

## 2. Credential flow

### Password registration / login

```
POST /api/auth/register
  ├─ validate email + password policy (length, letter + digit/symbol)
  ├─ scrypt(password, randomSalt, N=32768, r=8, p=1) → "scrypt$N$r$p$salt$hash"
  ├─ INSERT users
  ├─ newSessionToken() → "sess_xxx.<256-bit secret>"
  ├─ INSERT sessions (token_hash = sha256(token))
  └─ Set-Cookie: blue_session (HttpOnly, SameSite=Lax) + blue_csrf (readable)

POST /api/auth/login
  ├─ normalise email, fetch user
  ├─ scrypt-verify (timing-safe) — identical response for unknown email and bad password
  ├─ transparently upgrade legacy hashes
  └─ new session + cookies
```

### Per-request authentication

`attachUser` runs first for every request and resolves `req.user` in this order:

1. `Authorization: Bearer blue_sk_<prefix>_<secret>` → look up `credentials.prefix`, require
   a timing-safe match on `sha256(secret)`, not revoked, not expired → `req.auth.kind = 'api_key'`.
2. `blue_session` cookie → `sessions` row by `sha256(token)`; reject revoked/expired, then
   touch `last_seen_at`.

### CSRF

Cookie-authenticated state-changing requests (`POST/PUT/PATCH/DELETE`) must satisfy one of:

* `x-blue-csrf` header equals the `blue_csrf` cookie (double submit — a cross-site attacker
  can neither read the cookie nor set the header), or
* `Origin`/`Referer` host equals the request host (or `PUBLIC_URL` host).

API-key requests are exempt: they carry no ambient cookie authority.

### Sessions (devices)

`GET /api/auth/sessions` lists them with `current`/`active` flags. Revoking deletes nothing —
it stamps `revoked_at`, keeping the audit trail. Changing a password revokes every *other*
session. Expired sessions are pruned hourly.

### API keys

`createApiKey` generates `blue_sk_<8 hex prefix>_<192-bit secret>`. Only the prefix and
`sha256(secret)` are stored; the plaintext is returned once and never again. `last_used_at`
updates on each request, and `revoked_at` invalidates instantly.

---

## 3. The agent loop

```
POST /api/sessions/:id/messages   { content }
        │
        ├─ persist user message ─────────────► messages(role=user)
        ├─ title derived from first message ─► chat_sessions.title
        ├─ context = system prompt + memories + 8 recent searches + bounded history (160 messages / 240k chars by default)
        │
        └─ loop (≤ BLUE_MAX_TOOL_ROUNDS)
              ┌─────────────────────────────────────────────────────────────┐
              │ provider.stream(...)                                        │
              │   text       → SSE "text"  → browser renders incrementally  │
              │   tool_call  → collected                                    │
              │   usage      → token counters                               │
              └─────────────────────────────────────────────────────────────┘
                        │ tool calls?
                        ▼ yes
              persist assistant turn (content + tool_calls)
              for each call: execute tool → persist messages(role=tool, tool_call_id)
                             → SSE "tool_start" / "tool_result"
              feed results back into the context and loop again
                        │ no → persist final assistant message → SSE "done"
                        ▼
```

Failure behaviour: if a remote provider throws (bad key, network, rate limit) the client gets
an `error` event **and** a note, the loop re-runs with the offline engine so the user still
gets an answer, and the persisted message records which provider actually answered.

### Providers

`providers.js` exposes one interface — an async generator yielding
`text` / `tool_call` / `usage` / `end` — implemented for:

* **OpenAI-compatible** (`/chat/completions`, tool deltas assembled by index),
* **Anthropic** (`/messages`, `tool_use` blocks + `input_json_delta`),
* **Gemini** (`streamGenerateContent?alt=sse`, `functionCall` parts),
* **Ollama** (`/api/chat`, NDJSON stream).

Each adapter converts the shared message format (`system` + `user`/`assistant`/`tool` with
`tool_calls` and `tool_call_id`) into its own dialect.

### Attachments and data analysis

The chat route validates up to three inline attachments before persisting them with the user
message. Per-file, total-binary, text and serialized-request limits are enforced. Text/code/CSV
is passed as labeled untrusted text; binary payloads are serialized by modality. The current
adapters accept text and images for OpenAI-compatible APIs and Ollama, text/images/PDF for
Anthropic, and text/images/PDF/audio/video for Gemini. Unsupported combinations fail with a
provider-specific message instead of silently dropping files. Older media is omitted from
provider context after a bounded number of recent binary files, while the saved attachment
metadata remains in chat history.

`data_analysis` parses CSV without executing uploaded code and returns deterministic column
summaries, missing-value counts, numeric statistics and optional grouped series for charting.
The local engine can analyze CSVs offline; it explicitly declines to summarize arbitrary media
or documents without a connected model.

### The offline engine

`local-engine.js` implements the same generator contract without any network call:

1. **Intent routing** — regex/keyword classification into greeting, identity, capabilities,
   `web_search`, `calculator`, `clock`, `memory_save`, `memory_recall`, `session_search`,
   `search_history` or general.
2. **Tool round** — emits the same `tool_call` events a model would (plus a short "searching…"
   note), so persistence, SSE and the UI behave identically.
3. **Answer round** — when the last message is a tool result it writes the answer *from that
   output only*: cited search results, exact calculation values, real timezone strings,
   memory tables, matched transcript excerpts.

Deterministic, testable, and it never invents a fact — it explains what failed and what to
configure instead.

### Tools

| tool | notes |
| --- | --- |
| `web_search` | Tavily → Brave → Serper → keyless DuckDuckGo (Instant Answer + HTML fallback); every attempt is recorded in `searches`, including failures (`provider: 'unavailable'`) |
| `deep_research` | several focused web searches; deduplicated sources and source-linked research brief |
| `fetch_page` | 12s timeout, HTML→readable text, capped at 40k chars |
| `data_analysis` | local CSV parsing, missing/numeric summaries and optional grouped chart series |
| `calculator` | recursive-descent parser: `+ - * / % ^`, functions, constants; no `eval`; thousands separators supported |
| `clock` | `Intl.DateTimeFormat` with a validated IANA timezone |
| `memory` | `save` / `recall` / `forget` against the `memories` table |
| `session_search` | `LIKE` search across `messages` for this user |
| `search_history` | reads back the user's own recent searches |

Tools are per-account toggles (`settings.tools_enabled`) and are filtered before being sent
to the model, so a disabled tool simply doesn't exist for that turn.

---

## 4. SSE protocol

`POST /api/sessions/:id/messages` responds `text/event-stream`. Frames:

```
event: start        { sessionId, provider, model, title }
event: title        { title }                       # when derived from the first message
event: text         { delta }                       # incremental markdown
event: tool_start   { id, name, args }
event: tool_result  { id, name, ok, summary, detail, payload }
event: usage        { input, output }               # adapters that report it
event: error        { message }
event: done         { messageId, provider, model, latencyMs, tokensIn, tokensOut }
event: close        {}
```

`res.on('close')` (not `req.on('close')`) is used to detect client disconnects — in modern
Node the request stream emits `close` as soon as its body has been consumed, which would
otherwise abort the stream immediately. A 15s keep-alive comment keeps proxies from
reaping idle connections.

---

## 5. Front-end

No framework, no build. `public/js/*.js` are native ES modules driven by a tiny event bus
(`store.js`):

* `app.js` — boot, auth forms, view routing, wiring every control, subscribes to bus events
* `chat.js` — transcript rendering (history + live stream), attachments, tool cards, stop/regenerate
* `panels.js` — conversation list, recent searches (view + rail), memory, tools, modes, settings, account
* `api.js` — fetch wrapper (cookies + `x-blue-csrf`) and the SSE frame reader
* `markdown.js` — escape-first markdown renderer (headings, lists, tables, blockquotes,
  copyable code and autolinks); HTML fences render in a static sandboxed preview with scripts,
  links and external requests disabled
* `ui.js` — element helpers, toasts, modals, relative time, theme

Streaming renders into a *new* `.msg-body` per text segment with tool cards in between, so a
transcript reads like a real agent log ("searching… → tool card → answer") rather than one
merged blob.

---

## 6. Operational notes

* The local server is one process; Vercel exports the same Express app as a Node.js Function. `GET /api/status` reports configured providers, database kind and search backends.
* Back up local `data/blue.db` (plus `-wal`/`-shm` while running) and `data/.session-secret`. For Vercel, use Neon/Postgres backups; function filesystems are ephemeral.
* `BLUE_SEARCH_OFFLINE=true` disables outbound search; `BLUE_FORCE_LOCAL_ENGINE=true` forces the offline planner instead of model providers.
* Rate limits are stored atomically in the configured database, so they are shared across serverless instances. Vercel production requires Postgres and a stable 32+ character `BLUE_SESSION_SECRET`.
* See [VERCEL.md](VERCEL.md) for Git import, preview/production environments, deployment settings and smoke checks.

# Public Vercel deployment with visitor-owned AI keys

These instructions describe **public BYOK mode** on this branch. They supersede the README's older self-hosted instruction to add owner model/search keys. Do not set owner AI or search keys on a public deployment.

## Branch and deployment settings

1. Review and merge the BYOK pull request into `arena/bd6d01f4-project-blue` before deploying that branch. The implementation branch is `byok/public-vercel-request-keys`; it may be used as an isolated Vercel Preview for validation. No deployment or merge is performed by this change.
2. In Vercel, import `adarsh135/Project-Blue`. Explicitly choose the reviewed branch as the project's Production Branch; do not assume Vercel selects it automatically. Use Node.js 22 (at least 22.5). There is no frontend build command or output directory. Keep `api/index.js` and `vercel.json`.
3. Provision a Neon Postgres database. Set `DATABASE_URL` (pooled Neon connection string) or `POSTGRES_URL` in the appropriate Vercel environment. Never use SQLite or `/tmp` for durable Vercel data. Database setup/migrations run at function cold start, so check migration permissions and cold-start latency.
4. Set `BLUE_SESSION_SECRET` to a stable random value of at least 32 characters. Generate it locally with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. Keep it secret and stable across replicas.
5. Set `BLUE_PUBLIC_BYOK=true` explicitly in both Production and Preview. Public mode also defaults on whenever `VERCEL` is set. **Do not set it to false on an internet-facing deployment.** `false` is a deliberate return to trusted, self-hosted mode, which may use owner environment credentials and allows the original network tools.
6. Remove `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY`, `OPENAI_BASE_URL`, and `OLLAMA_BASE_URL` from public deployment settings. Public mode ignores these even if accidentally configured. Optional model-name variables (`OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`) select defaults only; choose currently supported models for your visitors. Old model aliases may no longer exist.
7. Redeploy manually after environment changes, then validate in an isolated Preview with disposable, restricted provider credentials. Keep request-header/body capture disabled in Vercel logging, proxies, analytics and error monitoring. The application never intentionally logs the provider-key header, but infrastructure operators are part of the trust boundary.

`vercel.json` requests a 60-second function duration. Confirm plan support; the provider request timeout is 45 seconds and database/tool/multiple-round overhead can still exceed the total function duration. Large attachment requests remain subject to Vercel's payload limit as well as the app's 4 MiB request and 2 MiB attachment limits.

## Visitor flow

Create an account or sign in. The page shows a password field labeled **Your AI provider key (this tab only)**. Enter a key issued to you by OpenAI, Anthropic or Google Gemini. Choose the matching provider and a model available to that key in Settings, then chat. The offline Blue Local Engine remains available without a provider key when selected explicitly.

The key is held in tab JavaScript memory and sent only as `x-blue-provider-key` on chat requests. It is not included in chat JSON, model prompts, saved settings, cookies, localStorage, sessionStorage or SQL. Clear key, page navigation/reload, or logout removes it from the UI's memory. Password fields may still be inspected by the browser user; this is not a vault. Do not paste keys into chat or upload them as attachments: ordinary chat/attachment content is intentionally stored.

The HTTPS application server must see the key transiently to call the selected provider. This is **not** end-to-end encryption and visitors must trust the deployment operator and its logging infrastructure. No key validation call occurs on entry; provider authentication and quota are checked when a chat request is made. Never use real secrets in issue reports or screenshots.

API clients retain their normal Blue account/API-key authentication and add a **separate** `x-blue-provider-key` header to `POST /api/chat` or `POST /api/sessions/:id/messages`. Pass `provider` and `model` in the JSON body. For explicitly local requests use `provider: "local"`; no visitor key is required. Do not confuse a Blue `blue_sk_…` login/API credential with a model provider key.

## Isolation and outbound policy

- AsyncLocalStorage gives each chat request its own credential context. Provider config reads only that context in public mode, never an owner key. The context is cleared when the response ends or disconnects; overlapping requests do not overwrite each other.
- OpenAI, Anthropic and Gemini use fixed HTTPS provider endpoints. Custom OpenAI-compatible URLs and Ollama are unavailable in public mode. Gemini credentials are moved out of the query string to `x-goog-api-key` before network transmission.
- Public mode installs a process-wide fetch policy for the existing agent/model/tool adapters. Model calls are limited to exact, credentialed POSTs to the three fixed provider APIs. Search uses a separate, credential-free allowlist for the DuckDuckGo Instant Answer endpoint and two fixed HTML result endpoints, with bounded query parameters, POST bodies, timeouts and redirects rejected. Other destinations are rejected. Model/upstream errors are replaced with generic errors before reaching the agent logs/SSE; streaming body errors are also sanitized.
- The Neon driver is explicitly given the original fetch function for trusted SQL traffic. Database requests do not use visitor credentials or the agent/tool allowlist. Future integrations must be reviewed before bypassing or changing this policy.
- **Web search and multi-query deep research** use the fixed DuckDuckGo endpoints above, with request throttling and challenge detection. This is keyless and may be rate-limited by the provider; public mode intentionally ignores owner commercial-search keys. **Arbitrary page fetching, custom outbound destinations, loopback/private/metadata addresses and redirect chains remain blocked.** The `fetch_page` control may still appear in the UI but will fail closed in public mode. Restoring arbitrary page reading requires a separately reviewed DNS/IP-pinning and redirect-safe SSRF design—not just a protocol check.
- Existing login, account isolation, CSRF and per-account chat rate limits remain in place. Missing or malformed provider headers are rejected before chat handling. The current app may fall back to its limited local engine on provider failure; this never consumes an owner provider key.

## Costs and abuse

Visitors pay their own provider's model charges, subject to their quota and selected model. This does **not** guarantee zero hosting cost: Vercel functions, bandwidth, storage, Neon database usage and abuse can still incur charges or exhaust free quotas. Review current plan terms and usage policies yourself; use budgets/alerts and platform abuse controls. No billing settings, spending limits or hosting resources are changed by this PR.

Registration is public and rate limits are not comprehensive bot protection. Before broad promotion, consider a registration gate/CAPTCHA, storage retention, account deletion, usage monitoring and platform-level rate controls. These are not implemented by this focused change. Use restricted provider keys with low limits and rotate suspected exposed keys.

## Validation required before public release

Run `npm ci && npm test` on Node.js 22.5+ and require the BLUE CI workflow to pass before merging. The automated suite uses fake credentials and mocked network calls to test concurrent credential isolation, header validation and lifecycle cleanup, missing-key rejection, owner-key isolation, strict provider/search egress allowlists, Gemini header transport, generic upstream errors, and Neon’s independent transport.

Also test on a private Preview:

- Sign up/sign in, save remote provider/model settings, send a chat, reload history, clear the key and verify a remote chat is rejected without an upstream request.
- Try two separate browser profiles with distinct disposable keys and concurrent chats. Check no cross-user settings, prompts or credentials appear.
- Confirm SQL cold-start migrations, login and chat persistence work against Neon even with no visitor key. Confirm SSE streams and aborts properly on Vercel.
- Test revoked/wrong keys and a mock redirect/error response. Confirm no raw upstream error body, key or credential-bearing URL appears in application logs, SSE, saved messages or database settings.
- Confirm arbitrary page-fetch attempts make no outbound request; fixed DuckDuckGo requests work under the allowlist, reject injected parameters and cannot follow redirects; and custom base URLs/Ollama cannot be enabled from account settings.
- Inspect headers/body capture at every proxy/monitoring layer and verify caches never retain API responses.

The repository integration has triggered a Vercel deployment, but no live provider calls, migration against a real Neon database, billing changes or browser end-to-end validation have been performed here. Passing unit tests alone is not a production security audit.

## Agent workspace release

Deploy the exact reviewed commit from `blue/agent-workspace`. `main` still contains only
a README; deploying main will not deploy this app. The serverless bundle includes
`public/` and `skills/`. `workspace_items` is created alongside the existing schema,
after `users`, on SQLite and Postgres.

This version adds credential-free GET requests to three fixed GitHub paths for connected
public repositories: `/repos/{owner}/{repo}`, `/readme` and `/issues?state=open&per_page=10`.
Headers are rebuilt without credentials, redirects are rejected and responses are bounded.
No OAuth credential store or generic URL/MCP proxy is introduced.

Hosting setup requires a project-specific Neon database connection in `DATABASE_URL`,
a stable `BLUE_SESSION_SECRET` and `BLUE_PUBLIC_BYOK=true`. A successful Vercel build
does not prove the database is configured: verify `/api/status`, registration, chat,
workspace save/reload and account isolation against the deployed app before publishing.
Keep deployment protection until that verification succeeds. Free-tier availability and
usage quotas do not guarantee unlimited free service; no paid plan is required by this code.

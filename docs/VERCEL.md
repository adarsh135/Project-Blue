# Deploy Project Blue on Vercel

Project Blue's Vercel path is a Node.js Function that exports the existing Express app. `vercel.json` rewrites site and API routes to `api/index.js`; Express then serves both the API and the `public/` frontend. The local `server/index.js` listener is not imported by the function.

For automatic Git deployments, use Vercel Dashboard → **New Project** to import this GitHub repository and enable the Git integration. Vercel can then create Preview deployments for branch pushes and pull requests; merges to the project's configured production branch create Production deployments. Keep the repository's default production branch (usually `main`) selected, and use non-production branches for review. Adding the Git integration and choosing the production branch are account/project settings and cannot be done from this repository alone.

## 1. Create the Vercel project

1. Import `adarsh135/Project-Blue` into Vercel.
2. Use the repository root as the project root, select the **Other** framework preset, and use Node.js **22**. The required version is declared in `package.json`.
3. Do not configure a frontend build command or output directory. Vercel builds the Node function from `api/index.js`; `vercel.json` includes `public/**` in the function bundle.
4. Keep the repository's `vercel.json` rewrite in place. It routes `/`, `/api/*`, `/js/*`, and `/css/*` through the same Express app.

## 2. Configure durable production storage

Vercel functions have an ephemeral filesystem. SQLite is the local development default and is not a production Vercel datastore. Provision a Neon Postgres database and set one of these Vercel environment variables:

- `DATABASE_URL` (preferred), or
- `POSTGRES_URL` (also accepted).

Use the Neon connection string supplied for serverless/HTTP use. The schema and additive Postgres migrations are initialized automatically when the function starts. User accounts, sessions, chats, attachments, memories, search history and shared rate limits are stored in Postgres.

**Do not deploy production accounts to SQLite on `/tmp`.** On Vercel, `/tmp/project-blue` may be used only as a temporary local database when running a non-production preview without a database URL. Production startup intentionally fails if the durable database URL is missing.

## 3. Add secrets and provider keys

Set these in Vercel → Project → Settings → Environment Variables:

| Variable | Required? | Notes |
| --- | --- | --- |
| `BLUE_SESSION_SECRET` | Yes | Stable random value, at least 32 characters. Generate with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. Keep it stable between deploys or browser sessions will be invalidated. |
| `DATABASE_URL` or `POSTGRES_URL` | Yes in production | Neon/Postgres connection string. |
| One of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | Recommended | Without a remote model key Blue falls back to the deterministic offline planner; it is not a general-purpose language model. |
| One of `TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY` | Recommended for research | Without a search key Blue tries keyless DuckDuckGo, which is best-effort and may be blocked or rate-limited. |
| `PUBLIC_URL` | Recommended | Canonical HTTPS origin, especially if using a custom domain. |
| Provider model variables | Optional | `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `OLLAMA_MODEL`; defaults are in `server/config.js`. |

Set the database and session secret separately for **Production**, **Preview**, and **Development** as appropriate. Prefer a separate Neon branch/database and secret for preview deployments. Never commit secrets or paste them into a public issue.

## 4. Deploy and verify

1. Deploy after setting environment variables. Production cold start validates `DATABASE_URL` and `BLUE_SESSION_SECRET` before serving a request.
2. Open the deployment URL. Confirm the sign-in/register page and static CSS/JS load.
3. Create a throwaway account, sign in again, and confirm a chat survives a redeploy. This checks both cookies and durable storage.
4. Test one streamed turn (for example, `calc 21 * 2`), then test research with a configured search provider and an image/document with a model that supports that modality.
5. Check Vercel's Function Logs and Neon metrics for cold-start, query, or provider errors. Avoid posting logs containing secrets or personal data.

The function maximum duration is configured as 60 seconds. Check that this duration is available on your Vercel plan; if not, lower `maxDuration` in `vercel.json` and keep research/provider operations within that budget. The app uses Server-Sent Events for streamed chat; function streaming and timeout behavior should be confirmed on the actual Vercel plan/domain after deployment.

## Storage and capability limits

- Local development: SQLite database in `data/`, protected by `.gitignore`.
- Vercel production: Neon/Postgres. Do not use function-local files for persistence.
- Files are sent inline and persisted with their chat. Up to three files can be attached; per-file and combined payload limits are enforced server-side. Images work with image-capable providers; Gemini handles image, PDF, audio and video input; Anthropic handles image and PDF; OpenAI-compatible providers and Ollama accept text and images in this app. Provider/model-specific limits can be stricter.
- The offline engine can deterministically analyze CSV files and perform supported tools, but does not understand arbitrary images, audio, video or PDFs and is not equivalent to a frontier language model.
- HTML code-fence previews run in a sandboxed opaque-origin iframe with scripts, links and external requests disabled by a restrictive Content Security Policy. They render static markup/styles; this is not an arbitrary code execution service.
- Browser dictation and speech playback depend on browser support and user permissions.

## Troubleshooting

- **Function fails on cold start:** verify Node 22 and production environment variables. A production Vercel instance must have `DATABASE_URL`/`POSTGRES_URL` and a 32+ character `BLUE_SESSION_SECRET`.
- **Static file returns 404:** check that the project root is the repository root and `public/**` is included by the function config; redeploy after changing `vercel.json`.
- **Login works but sessions do not survive deploys:** verify the app is using Neon/Postgres and that `BLUE_SESSION_SECRET` remains unchanged. SQLite on a function filesystem is temporary.
- **SSE closes early:** check function duration/plan limits and logs. Slow providers or multi-query deep research can exceed a short function timeout.
- **An attachment is rejected:** check the MIME type, file size and provider capabilities. A model API may impose limits lower than Project Blue's request limits.
- **Web research fails:** configure a supported search API key, or use the offline/local tools that do not need external search.

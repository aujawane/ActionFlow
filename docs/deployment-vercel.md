# Deploying Parfait to Vercel

This guide deploys the existing Next.js Parfait application to Vercel.
It does **not** include WhisperX, pyannote, GPU workers, or Docker for the app.

## Plan assumptions

Parfait’s long-running API routes assume **Vercel Pro** (or higher):

| Route | `maxDuration` | Why |
|-------|---------------|-----|
| `POST /api/recall/webhook` | 300s | Transcript import + retries + analysis kickoff |
| `POST /api/meetings/[id]/analyze` | 300s | Topic segmentation + per-topic OpenAI work |
| `POST /api/meetings/[id]/sync-status` | 300s | May trigger the same completion pipeline |
| Task / prompt / deliverable AI routes | 60s | Single or small batches of OpenAI calls |

**Vercel Hobby is not recommended.** Hobby function timeouts (~10s) will break meeting analysis and webhook completion.

All API routes that use Node APIs (`crypto`, Supabase admin, OpenAI) run on the **Node.js** runtime (not Edge).

## Architecture

- **Vercel** hosts the Next.js App Router application and API routes.
- **Supabase** hosts Auth + Postgres (already external).
- **Recall.ai** creates meeting bots and delivers webhooks to Vercel.
- **OpenAI** powers analysis, categorization, and deliverables.
- Heavy audio / speaker-resolution workers are intentionally out of scope for this deploy.

## 1. Create the Vercel project

1. Push this branch / repository to GitHub.
2. In Vercel: **Add New Project** → import the Parfait repo.
3. Framework preset: **Next.js**.
4. Root directory: repository root.
5. Build command: `npm run build` (default).
6. Install command: `npm ci` (or Vercel default `npm install`).
7. Output: Next.js defaults (no Docker, no custom output directory).

## 2. Required environment variables

Set these in Vercel → Project → Settings → Environment Variables
for **Production** (and Preview if you want preview deploys to work).

### Core (required)

| Name | Example | Notes |
|------|---------|-------|
| `NEXT_PUBLIC_APP_URL` | `https://your-app.vercel.app` | Public site URL, no trailing slash |
| `INTERNAL_APP_URL` | `https://your-app.vercel.app` | Server self-calls (analyze). Prefer same as public URL |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | **Server only** — never expose to the browser |
| `OPENAI_API_KEY` | `sk-...` | Server only |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Optional; defaults to `gpt-4.1-mini` |
| `RECALL_API_KEY` | Recall token | Server only |
| `RECALL_REGION` | `us-west-2` | Recall API region |
| `RECALL_WEBHOOK_SECRET` | long random string | HMAC + internal analyze auth |

### Optional but needed for those features

| Name | Purpose |
|------|---------|
| `ZOOM_CLIENT_ID` | Zoom Server-to-Server OAuth |
| `ZOOM_CLIENT_SECRET` | Zoom Server-to-Server OAuth |
| `ZOOM_ACCOUNT_ID` | Zoom Server-to-Server OAuth |
| `GOOGLE_CLIENT_ID` | Google OAuth / Meet |
| `GOOGLE_CLIENT_SECRET` | Google OAuth / Meet |
| `GOOGLE_REDIRECT_URI` | Must match Google Cloud console |
| `GOOGLE_REFRESH_TOKEN` | Optional legacy Meet creation fallback |
| `RECALL_WEBHOOK_URL` | Optional ops documentation / explicit webhook URL |

Do **not** put `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `RECALL_API_KEY`, Zoom secrets, or Google client secrets in any `NEXT_PUBLIC_*` variable.

## 3. Callback and webhook URLs

Replace `https://your-app.vercel.app` with your real production domain.

### Recall webhook (required)

```text
https://your-app.vercel.app/api/recall/webhook
```

Configure this exact URL in the Recall.ai webhooks dashboard.
Production verification is **fail-closed**: missing or invalid `x-recall-signature` returns `401`.

### Google OAuth callback

```text
https://your-app.vercel.app/api/integrations/google/callback
```

Add the same URI in Google Cloud Console → OAuth client → Authorized redirect URIs,
and set `GOOGLE_REDIRECT_URI` to that value in Vercel.

### Zoom callback

**Not applicable.** Parfait uses Zoom **Server-to-Server OAuth** (`account_credentials`).
There is no browser OAuth callback URL for Zoom in this codebase.

### Supabase Auth callback

In Supabase → Authentication → URL configuration, allow:

```text
https://your-app.vercel.app/api/auth/callback
```

Also set the Site URL to `https://your-app.vercel.app`.

### Health check

```text
https://your-app.vercel.app/api/health
```

Returns `{ ok: true, service: "parfait", timestamp: "..." }`.

## 4. Post-deploy checklist

1. Open `/api/health` and confirm `ok: true`.
2. Sign up / log in (Supabase Auth).
3. Create a Google Meet meeting (with Google connected) and a Zoom meeting.
4. Confirm a Recall bot joins the call.
5. Confirm webhook events move the meeting through `joining` → `recording` → `processing`/`completed`.
6. Confirm transcript import and `POST /api/meetings/[id]/analyze` produce topics + tasks.
7. Open a task workspace and run Guide Me / Do It For Me.
8. Exercise speaker mapping on a meeting detail page.
9. Confirm `/api/dev/*` returns 404 in production.

## 5. Local vs production URLs

| Context | `NEXT_PUBLIC_APP_URL` / `INTERNAL_APP_URL` | Recall webhook |
|---------|--------------------------------------------|----------------|
| Local | `http://localhost:3000` | ngrok HTTPS URL → `/api/recall/webhook` |
| Vercel production | `https://your-app.vercel.app` | `https://your-app.vercel.app/api/recall/webhook` |

Production code never falls back to `localhost` for internal analysis URLs.

## 6. Security notes

- Recall webhook signature verification fails closed in production.
- Dev-only routes under `/api/dev` are disabled when `NODE_ENV !== "development"`.
- Middleware protects `/dashboard`, `/meetings`, `/tasks`, and `/account`.
- Service-role Supabase access is lazy-initialized and server-only.

## 7. What this deploy intentionally excludes

- Docker for the Next.js app
- WhisperX / pyannote / GPU speaker-resolution workers
- Any separate audio-processing service

Those belong in a later branch and a separate hosting target, not Vercel.

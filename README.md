# Parfait

Parfait is an AI-powered meeting companion that:

- creates Recall.ai meeting bots from a meeting URL
- stores meetings and bot lifecycle state in Supabase
- ingests Recall webhook transcript events into the database

Parfait's execution model is **Commitments → Tasks → Deliverables**. See
[`docs/execution-intelligence.md`](docs/execution-intelligence.md) for the
architecture, extraction stages, persistence model, and evaluation harness.

## Project Overview

Core product flow:

1. User signs in with Supabase Auth.
2. User creates a meeting in `/meetings/new` by pasting a meeting URL.
3. Backend creates a `meetings` row and calls Recall.ai to join the call.
4. Recall webhook events hit `/api/recall/webhook` and update status/transcript rows.
5. User opens the meeting detail page to track status and transcript in near-real time.

## Tech Stack

- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS
- Supabase (Auth + Postgres + RLS)
- OpenAI API (`responses.create`)
- Recall.ai API (bot creation + webhooks)

## Deploy to Vercel

Production deployment instructions live in:

- [`docs/deployment-vercel.md`](docs/deployment-vercel.md)

Summary:

- Host the Next.js app on **Vercel Pro** (Hobby timeouts are too short for analyze/webhook).
- Keep Supabase, OpenAI, Recall, Zoom, and Google as external services.
- Do **not** Dockerize this Next.js app for Vercel.
- Production Recall webhook: `https://<your-domain>/api/recall/webhook`
- Production Google OAuth callback: `https://<your-domain>/api/integrations/google/callback`
- Zoom has **no** OAuth callback URL (Server-to-Server OAuth only).
- Health check: `GET /api/health`

## Environment Variables

Create `.env.local` from `.env.example`:

```bash
cp .env.example .env.local
```

Required variables:

- `NEXT_PUBLIC_APP_URL`  
  Public app base URL.  
  - Local dev: `http://localhost:3000`
- `INTERNAL_APP_URL`  
  Server-side app base URL for internal calls.
  - Local dev: `http://localhost:3000`
- `RECALL_WEBHOOK_URL`  
  Public webhook endpoint configured in Recall.ai.
  - Local dev with ngrok: `https://<your-current-ngrok-domain>/api/recall/webhook`
- `NEXT_PUBLIC_SUPABASE_URL`  
  Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`  
  Supabase anon/public key
- `SUPABASE_SERVICE_ROLE_KEY`  
  Supabase service role key (server-only)
- `OPENAI_API_KEY`  
  OpenAI API key for transcript analysis + prompt generation
- `OPENAI_MODEL`  
  Default model name (example: `gpt-4.1-mini`)
- `RECALL_API_KEY`  
  Recall.ai API token used for bot creation
- `RECALL_REGION`  
  Recall region slug used for bot creation endpoint (for example: `us-west-2`)
- `RECALL_WEBHOOK_SECRET`  
  Shared secret for HMAC signature verification on webhook payloads

## Supabase Setup

1. Create a Supabase project.
2. In Supabase dashboard, copy:
   - Project URL
   - Anon key
   - Service role key
3. Put them into `.env.local`.
4. Run schema in SQL editor:
   - file: `supabase/schema.sql`
5. In **Authentication > Providers**, enable Email provider.
6. (Optional) For easier local testing, disable email confirmation in Auth settings.

What schema creates:

- `profiles`
- `meetings`
- `transcript_segments`
- `extracted_insights`
- `generated_prompts`
- RLS policies so users can only access their own records

## Recall.ai Setup (Current Branch)

1. Create a Recall.ai account and get API key.
2. Put key in:
   - `RECALL_API_KEY`
3. Pick a webhook secret (random strong string) and set:
   - `RECALL_WEBHOOK_SECRET`
4. Ensure the meeting host has an active Google Meet open before creating the bot.
5. User pastes the Google Meet URL in `/meetings/new`.
6. Parfait sends a bot named `Parfait Notetaker` to that Google Meet URL.
7. For local testing, expose local app with ngrok and configure Recall.ai with:
   - `https://<your-ngrok-subdomain>.ngrok-free.app/api/recall/webhook`

Notes:

- Recall API calls are server-side only (`lib/recall/client.ts` + `POST /api/meetings`).
- `RECALL_API_KEY` is never exposed to browser code.
- Local webhook testing requires ngrok.
- Keep `NEXT_PUBLIC_APP_URL` and `INTERNAL_APP_URL` pointed at `http://localhost:3000` for local dev.
- Configure Recall.ai webhook URL as: `https://<your-current-ngrok-domain>/api/recall/webhook`.

## OpenAI Setup

1. Create OpenAI API key.
2. Set:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (optional override)
3. Analysis endpoint:
   - `POST /api/meetings/[id]/analyze`
4. Prompt generation endpoint:
   - `POST /api/meetings/[id]/generate-prompts`

## Run Locally

Install and run:

```bash
npm install
npm run dev
```

Open:

- [http://localhost:3000](http://localhost:3000)

## Expose Local App with ngrok

1. Install ngrok and authenticate once.
2. Start tunnel:

```bash
ngrok http 3000
```

3. Copy HTTPS forwarding URL from ngrok, e.g.:
   - `https://abc123.ngrok-free.app`
4. Keep local app URLs in `.env.local`:
   - `NEXT_PUBLIC_APP_URL=http://localhost:3000`
   - `INTERNAL_APP_URL=http://localhost:3000`
5. Configure the Recall.ai webhooks dashboard endpoint to:
   - `https://abc123.ngrok-free.app/api/recall/webhook`
6. Restart dev server after env changes:

```bash
npm run dev
```

Use the ngrok URL only in the Recall.ai webhooks dashboard so Recall can deliver webhook events to your local `/api/recall/webhook`.

## How to Test Creating a Meeting Bot

1. Start app and sign up/login.
2. Go to `/meetings/new`.
3. Paste a valid meeting URL (Zoom/Meet/Teams depending on Recall support).
4. Submit form.
5. Verify:
   - A row is created in `meetings`
   - `recall_bot_id` is populated
   - status changes from `pending` to `joining`

Optional API-level test (requires authenticated browser session cookie):

```bash
curl -X POST http://localhost:3000/api/meetings \
  -H "Content-Type: application/json" \
  -d '{
    "meetingUrl":"https://meet.google.com/your-link",
    "title":"Parfait test call"
  }'
```

## Transcript Webhook Behavior

- `POST /api/recall/webhook` verifies Recall signature with `RECALL_WEBHOOK_SECRET`.
- Bot lifecycle events update meeting status (`joining`, `recording`, `completed`, `failed`).
- Transcript events insert into `transcript_segments` with:
  - `meeting_id`
  - `speaker`
  - `text`
  - `timestamp`
  - `raw_payload`

## Manual Test: Task Owner Detection

After applying migrations and running `POST /api/meetings/[id]/analyze`, use transcript segments like:

- `Aditya: I'll research pricing.` -> owner `Aditya`, task type `commitment`
- `Sarah: Let me draft the follow-up email.` -> owner `Sarah`, task type `commitment`
- `John: I can look into the API issue.` -> owner `John`, task type `implicit_commitment`
- `Unknown Speaker: This is Maya, I'll prepare the proposal.` -> owner `Maya`, task type `commitment`
- `Alex: Someone needs to write onboarding docs.` -> owner `null`, task type `unassigned_work`

## Useful App Routes

Pages:

- `/` - Landing page
- `/login` - Login/signup
- `/dashboard` - Meetings overview
- `/meetings/new` - Create meeting bot
- `/meetings/[id]` - Transcript, insights, and prompts

API:

- `POST /api/meetings` - create meeting + Recall bot
- `GET /api/meetings` - list user meetings
- `GET /api/meetings/[id]/transcript` - transcript segments
- `POST /api/recall/webhook` - Recall webhook receiver
- `POST /api/meetings/[id]/analyze` - transcript analysis (future branch)
- `POST /api/meetings/[id]/generate-prompts` - Codex/Claude/Lovable prompts (future branch)
- `GET /api/auth/callback` - Supabase auth callback

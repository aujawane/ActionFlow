# Workflow

Workflow is an AI-powered meeting companion that:

- creates Recall.ai meeting bots from a meeting URL
- ingests transcript events through webhooks
- analyzes transcripts with OpenAI into structured delivery insights
- generates build-ready prompts for Codex, Claude Code, and Lovable

## Project Overview

Core product flow:

1. User signs in with Supabase Auth.
2. User creates a meeting in `/meetings/new` by pasting a meeting URL.
3. Backend creates a `meetings` row and calls Recall.ai to join the call.
4. Recall webhook sends transcript and bot status events to `/api/recall/webhook`.
5. User runs Analyze to extract structured insights.
6. User runs Generate Prompts to get tool-specific implementation prompts.

## Tech Stack

- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS
- Supabase (Auth + Postgres + RLS)
- OpenAI API (`responses.create`)
- Recall.ai API (bot creation + webhooks)

## Environment Variables

Create `.env.local` from `.env.example`:

```bash
cp .env.example .env.local
```

Required variables:

- `NEXT_PUBLIC_APP_URL`  
  Public app base URL.  
  - Local dev: `http://localhost:3000`
  - Webhook testing with ngrok: set this to your ngrok HTTPS URL
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

## Recall.ai Setup

1. Create a Recall.ai account and get API key.
2. Put key in:
   - `RECALL_API_KEY`
3. Pick a webhook secret (random strong string) and set:
   - `RECALL_WEBHOOK_SECRET`
4. For local testing, expose local app with ngrok and set:
   - `NEXT_PUBLIC_APP_URL=https://<your-ngrok-subdomain>.ngrok-free.app`

Notes:

- `POST /api/meetings` builds Recall bot payload and sets webhook URL to:
  - `${NEXT_PUBLIC_APP_URL}/api/recall/webhook`
- Webhook signature is verified with SHA256 HMAC in `lib/recall.ts`.

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

## Expose Local Webhook with ngrok

1. Install ngrok and authenticate once.
2. Start tunnel:

```bash
ngrok http 3000
```

3. Copy HTTPS forwarding URL from ngrok, e.g.:
   - `https://abc123.ngrok-free.app`
4. Set in `.env.local`:
   - `NEXT_PUBLIC_APP_URL=https://abc123.ngrok-free.app`
5. Restart dev server after env change:

```bash
npm run dev
```

Now Recall webhooks can reach your local endpoint at:

- `https://abc123.ngrok-free.app/api/recall/webhook`

## How to Test Creating a Meeting Bot

1. Start app and sign up/login.
2. Go to `/meetings/new`.
3. Paste a valid meeting URL (Zoom/Meet/Teams depending on Recall support).
4. Submit form.
5. Verify:
   - A row is created in `meetings`
   - `recall_bot_id` is populated
   - status changes from `pending` to `joining` (then updates via webhook events)

Optional API-level test (requires authenticated browser session cookie):

```bash
curl -X POST http://localhost:3000/api/meetings \
  -H "Content-Type: application/json" \
  -d '{
    "meetingUrl":"https://meet.google.com/your-link",
    "title":"Workflow test call"
  }'
```

## How to Test Transcript Webhook Manually

You can simulate Recall webhook calls by sending JSON with valid signature header.

### 1) Prepare payload

```bash
PAYLOAD='{
  "event":"transcript.partial",
  "data":{
    "bot":{
      "id":"bot_test_123",
      "status":"in_call",
      "metadata":{"meeting_id":"<your-meeting-uuid>"}
    },
    "transcript":{
      "speaker":{"name":"PM"},
      "text":"We need role-based access control in v1.",
      "timestamp":"2026-06-10T12:00:00.000Z"
    }
  }
}'
```

### 2) Sign payload with webhook secret

```bash
SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$RECALL_WEBHOOK_SECRET" | sed 's/^.* //')
```

### 3) Send webhook request

```bash
curl -X POST "http://localhost:3000/api/recall/webhook" \
  -H "Content-Type: application/json" \
  -H "x-recall-signature: sha256=$SIG" \
  --data "$PAYLOAD"
```

Expected behavior:

- endpoint returns `{ "ok": true }`
- new row appears in `transcript_segments`
- related `meetings.status` updates (e.g. `in_progress`, `completed`, `failed`) based on event/status

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
- `POST /api/meetings/[id]/analyze` - transcript analysis
- `POST /api/meetings/[id]/generate-prompts` - Codex/Claude/Lovable prompts
- `POST /api/recall/webhook` - Recall webhook receiver
- `GET /api/auth/callback` - Supabase auth callback

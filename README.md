# ActionFlow MVP

ActionFlow is an AI-powered meeting companion that joins meetings with Recall.ai, ingests transcript webhooks, extracts product/engineering insights with OpenAI, and generates build-ready prompts for Codex, Claude Code, and Lovable.

## Tech Stack

- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS
- Supabase (Auth + Postgres)
- OpenAI API (analysis + prompt generation)
- Recall.ai API (meeting bots + webhook transcript ingestion)

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy and fill env vars:

   ```bash
   cp .env.example .env.local
   ```

3. Run SQL schema in Supabase SQL editor:

   - File: `supabase/schema.sql`

4. Start development server:

   ```bash
   npm run dev
   ```

## Environment Variables

See `.env.example` for all required variables:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `RECALL_API_KEY`
- `RECALL_WEBHOOK_SECRET`

## Core Routes

### Pages

- `/` - Landing page
- `/login` - Login/signup (Supabase Auth)
- `/dashboard` - User meetings dashboard
- `/meetings/new` - Create meeting with URL
- `/meetings/[id]` - Meeting detail (transcript, insights, prompts)

### API

- `POST /api/meetings` - Create meeting and Recall bot
- `GET /api/meetings` - List user meetings
- `GET /api/meetings/[id]/transcript` - Fetch transcript segments
- `POST /api/meetings/[id]/analyze` - Analyze transcript into insights
- `POST /api/meetings/[id]/prompts` - Generate target-specific prompts
- `POST /api/recall/webhook` - Receive Recall webhook events
- `GET /api/auth/callback` - Supabase auth callback

## Notes on External Integrations

- `lib/recall.ts` uses Recall.ai bot creation endpoint and includes a placeholder signature validator. Replace with exact Recall webhook signature verification logic from official docs.
- `lib/analysis.ts` and `lib/prompt-generation.ts` call OpenAI via `openai.responses.create`.
- API routes currently use Supabase service role on the backend and enforce ownership checks before mutating/reading user data.

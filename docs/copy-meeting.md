# Copy one production meeting to staging

This development-only utility copies one meeting and its transcript context
from production Supabase to staging. Production is read-only throughout the
operation.

It copies only:

- `meetings`
- `transcript_segments`
- `meeting_speaker_aliases` when present

It does not copy tasks, commitments, comments, artifacts, topics, or insights.
Run the execution-intelligence analysis in staging to regenerate those tables.

## 1. Install the staging-only transaction helper

In the **staging Supabase SQL editor**, run:

```text
scripts/sql/install-copy-meeting-to-staging-rpc.sql
```

Do not install this helper in production. It is intentionally outside
`supabase/migrations` so normal production migration deployment cannot install
it accidentally.

The helper:

- is executable only by `service_role`;
- validates the staging auth user and profile again inside the transaction;
- checks that the meeting does not already exist;
- inspects staging table columns through PostgreSQL metadata;
- inserts only destination columns also present in each source JSON row;
- lets staging defaults populate staging-only columns;
- inserts the meeting, transcript, and aliases in one PostgreSQL transaction.

Any failed row raises an error and rolls back the complete copy.

## 2. Configure local environment variables

Add these values to `.env.local` or export them in the shell:

```bash
PRODUCTION_SUPABASE_URL=https://production-project.supabase.co
PRODUCTION_SUPABASE_SERVICE_ROLE_KEY=production-service-role-key

STAGING_SUPABASE_URL=https://staging-project.supabase.co
STAGING_SUPABASE_SERVICE_ROLE_KEY=staging-service-role-key
```

Never commit service-role keys. The script refuses to run when the production
and staging URLs are identical.

## 3. Find the staging user ID

The supplied staging user must exist in both:

- Supabase Auth (`auth.users`)
- `public.profiles`

Use the UUID of the staging account that should own the copied meeting.

## 4. Run the copy

```bash
npm run copy-meeting -- <meeting_id> <staging_user_id>
```

Example:

```bash
npm run copy-meeting -- \
  11111111-1111-4111-8111-111111111111 \
  22222222-2222-4222-8222-222222222222
```

Successful output:

```text
Meeting copied.
Transcript segments copied: 42
Ready for execution-intelligence analysis.
```

The copied meeting keeps its original meeting UUID, transcript segment UUIDs,
timestamps, Recall metadata, meeting URL, and platform. Its `meetings.user_id`
is replaced with the supplied staging user UUID.

## Safety and reruns

- The script makes only `SELECT`/Auth-admin read calls to production.
- All writes go through the staging transaction helper.
- No rows are deleted or updated in either project.
- If the meeting already exists in staging, the script aborts without writing.
- A failed transaction can be retried after correcting the reported issue.
- To rerun a successfully copied meeting, use a fresh staging database or
  remove it manually only after independently confirming that is safe; this
  utility never deletes data.

After copying, open the meeting in staging and trigger Analyze Meeting to
generate topics, insights, commitments, and tasks with the new pipeline.


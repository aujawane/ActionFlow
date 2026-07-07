alter table public.meetings
add column if not exists is_pinned boolean not null default false,
add column if not exists deleted_at timestamptz;

create index if not exists meetings_user_deleted_created_idx
on public.meetings (user_id, deleted_at, created_at desc);

create index if not exists meetings_user_pinned_idx
on public.meetings (user_id, is_pinned)
where deleted_at is null;

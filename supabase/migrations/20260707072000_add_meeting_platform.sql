alter table public.meetings
add column if not exists platform text not null default 'google_meet';

alter table public.meetings
drop constraint if exists meetings_platform_check;

alter table public.meetings
add constraint meetings_platform_check
check (platform in ('google_meet', 'zoom', 'unknown'));

create index if not exists meetings_platform_idx
on public.meetings (platform);

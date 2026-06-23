do $$
begin
  if exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'prompt_tool_type'
  ) then
    begin
      alter type public.prompt_tool_type add value if not exists 'general';
    exception
      when duplicate_object then null;
    end;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'generated_prompts'
      and column_name = 'target_tool'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'generated_prompts'
      and column_name = 'tool_type'
  ) then
    alter table public.generated_prompts
    rename column target_tool to tool_type;
  end if;
end $$;

alter table public.generated_prompts
add column if not exists tool_type text;

update public.generated_prompts
set tool_type = coalesce(tool_type, 'general');

alter table public.generated_prompts
drop constraint if exists generated_prompts_target_tool_check;

alter table public.generated_prompts
drop constraint if exists generated_prompts_tool_type_check;

alter table public.generated_prompts
add constraint generated_prompts_tool_type_check
check (tool_type in ('general', 'lovable', 'codex', 'claude_code'));

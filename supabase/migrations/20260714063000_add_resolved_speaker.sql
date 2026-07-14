alter table public.transcript_segments
add column if not exists resolved_speaker text;

update public.transcript_segments as segment
set
  resolved_speaker = alias.display_name,
  speaker = alias.display_name
from public.meeting_speaker_aliases as alias
where alias.meeting_id = segment.meeting_id
  and alias.raw_speaker_label = coalesce(
    nullif(trim(segment.diarized_speaker), ''),
    nullif(trim(segment.speaker), ''),
    'Unknown Speaker'
  )
  and (
    segment.resolved_speaker is distinct from alias.display_name
    or segment.speaker is distinct from alias.display_name
  );

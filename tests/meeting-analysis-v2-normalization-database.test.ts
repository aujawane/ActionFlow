import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const url = process.env.B2_TEST_DATABASE_URL;
const projectId = "00000000-0000-4000-8000-0000000000c2";
const meetingId = "00000000-0000-4000-8000-0000000000b2";
const segmentIds = [0, 1, 2].map((index) =>
  `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`
);
const timestamps = segmentIds.map((_, index) => `2026-11-04T12:00:0${index}.000Z`);
const sourceRows = [
  { speaker: "Ada", participant_name: null, text: "ship acme" },
  { speaker: "Bob", participant_name: " Robert ", text: "no correction" },
  { speaker: null, participant_name: null, text: "model failed" }
];

function sourceHash(row: typeof sourceRows[number]) {
  const speaker = row.participant_name?.trim() || row.speaker?.trim() || "Unknown Speaker";
  const part = (value: string | null) => {
    const normalized = value ?? "";
    return `${Buffer.byteLength(normalized, "utf8")}:${normalized}`;
  };
  return createHash("sha256").update([
    part(speaker), part(row.participant_name), part(row.text)
  ].join("|")).digest("hex");
}

const correction = {
  original_token: "acme", replacement: "Acme", confidence: 0.99,
  reason: "synthetic", source: "model", applied: true
};
function patches() {
  return segmentIds.map((segment_id, index) => ({
    segment_id,
    source_hash: sourceHash(sourceRows[index]),
    source_timestamp: timestamps[index],
    normalized_text: index === 0 ? "ship Acme" : null,
    normalization_corrections: index === 0 ? [correction] : null,
    succeeded: index !== 2
  }));
}
const suggestions = () => [{
  canonical_term: "Acme", observed_alias: "acme", confidence: 0.9,
  evidence_segment_ids: [segmentIds[0]]
}];

type Job = { job_id: string; generation: number };

test("transactional v2 normalization persistence RPC (isolated local scratch database)", { skip: !url }, async (t) => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname), "local scratch database required");
  assert.equal(parsed.pathname, "/actionflow_b2_scratch");

  async function sql(query: string) {
    const { stdout } = await run("psql", [url!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", query]);
    return stdout.trim();
  }
  async function persist(job: Job, patchPayload: unknown = patches(), vocabularyPayload: unknown = suggestions(), at = "2026-11-04T13:00:00.000Z") {
    return JSON.parse(await sql(
      `select public.persist_meeting_normalization_v2('${job.job_id}', ${job.generation}, '${at}'::timestamptz, ` +
      `$patch$${JSON.stringify(patchPayload)}$patch$::jsonb, $vocab$${JSON.stringify(vocabularyPayload)}$vocab$::jsonb)`
    ));
  }
  const claim = async (v = 2): Promise<Job> => {
    const job = JSON.parse(await sql(`select public.claim_meeting_analysis_job${v === 2 ? "_v2" : ""}('${meetingId}')`));
    if (v === 2) {
      await sql(`update public.meeting_analysis_jobs set checkpoint = checkpoint || '{"v2Topology":"b2"}'::jsonb where id='${job.job_id}'`);
    }
    return job;
  };
  const canonical = () => sql(`select jsonb_agg(jsonb_build_object(
    'id', id, 'text', text, 'normalized_text', normalized_text,
    'corrections', normalization_corrections, 'normalized_at', normalized_at,
    'failed_at', normalization_failed_at) order by id)::text
    from public.transcript_segments where meeting_id='${meetingId}'`);
  const checkpoint = (job: Job) => sql(`select checkpoint::text from public.meeting_analysis_jobs where id='${job.job_id}'`);
  const vocabulary = () => sql(`select coalesce(jsonb_agg(jsonb_build_object(
    'canonical', canonical_term, 'aliases', aliases, 'status', status,
    'evidence', evidence_segment_ids) order by lower(canonical_term)), '[]'::jsonb)::text
    from public.project_vocabulary where project_id='${projectId}'`);

  for (const file of [
    "fixtures/analysis-v2/bootstrap.sql",
    "fixtures/analysis-v2/normalization-bootstrap.sql",
    "../supabase/migrations/20260724140000_add_background_analysis_jobs.sql",
    "../supabase/migrations/20260724143000_add_analysis_job_checkpoint.sql",
    "../supabase/migrations/20260905090000_add_transcript_normalization_and_vocabulary.sql",
    "../supabase/migrations/20261016090000_add_analysis_pipeline_v2_units.sql",
    "../supabase/migrations/20261104090000_persist_meeting_normalization_v2.sql"
  ]) await sql(await readFile(new URL(file, import.meta.url), "utf8"));

  await sql(`insert into public.projects(id) values ('${projectId}');
    insert into public.meetings(id, project_id) values ('${meetingId}', '${projectId}');
    insert into public.transcript_segments(id, meeting_id, speaker, participant_name, text, "timestamp") values
      ('${segmentIds[0]}','${meetingId}','Ada',null,'ship acme','${timestamps[0]}'),
      ('${segmentIds[1]}','${meetingId}','Bob',' Robert ','no correction','${timestamps[1]}'),
      ('${segmentIds[2]}','${meetingId}',null,null,'model failed','${timestamps[2]}');
    grant all on public.meeting_analysis_jobs, public.transcript_segments, public.project_vocabulary to service_role;`);

  const v1 = await claim(1);
  await t.test("pipeline v1 cannot use the v2 RPC", async () => {
    await assert.rejects(persist(v1), /requires B2 pipeline/);
  });

  let job = await claim();
  await t.test("valid current generation persists all segments and vocabulary atomically without checkpoint mutation", async () => {
    const beforeCheckpoint = await checkpoint(job);
    assert.deepEqual(await persist(job), { segment_count: 3, vocabulary_candidate_count: 1 });
    const state = JSON.parse(await canonical());
    assert.deepEqual(state.map((row: Record<string, unknown>) => [row.normalized_text, Boolean(row.normalized_at), Boolean(row.failed_at)]), [
      ["ship Acme", true, false], [null, true, false], [null, false, true]
    ]);
    assert.equal(JSON.parse(await vocabulary()).length, 1);
    assert.equal(await checkpoint(job), beforeCheckpoint, "RPC never writes checkpoint.normalization");
  });

  await t.test("same-generation replay is idempotent, including timestamps and vocabulary", async () => {
    const before = { canonical: await canonical(), vocabulary: await vocabulary() };
    await persist(job, patches(), suggestions(), "2026-11-04T14:00:00.000Z");
    await persist(job, patches(), suggestions(), "2026-11-04T15:00:00.000Z");
    assert.deepEqual({ canonical: await canonical(), vocabulary: await vocabulary() }, before);
    assert.equal(await sql(`select count(*) from public.project_vocabulary where project_id='${projectId}' and lower(canonical_term)='acme'`), "1");
  });

  await t.test("duplicate, foreign, malformed and unsupported patches are rejected before all writes", async () => {
    const before = { canonical: await canonical(), vocabulary: await vocabulary() };
    const duplicate = patches(); duplicate[1] = { ...duplicate[1], segment_id: segmentIds[0] };
    await assert.rejects(persist(job, duplicate), /Duplicate normalization segment/);
    const foreign = patches(); foreign[1] = { ...foreign[1], segment_id: "00000000-0000-4000-8000-000000000999" };
    await assert.rejects(persist(job, foreign), /foreign or unexpected|segment set changed/);
    const malformed = patches(); (malformed[1] as Record<string, unknown>).succeeded = "yes";
    await assert.rejects(persist(job, malformed), /Malformed normalization patch/);
    const unsupported = patches(); (unsupported[1] as Record<string, unknown>).raw_text = "not allowed";
    await assert.rejects(persist(job, unsupported), /Malformed normalization patch/);
    assert.deepEqual({ canonical: await canonical(), vocabulary: await vocabulary() }, before);
  });

  await t.test("one invalid correction rolls back every otherwise-valid patch", async () => {
    const before = await canonical();
    const invalid = patches();
    invalid[0].normalized_text = "must not persist";
    invalid[1].normalization_corrections = [{ ...correction, applied: "yes" } as never];
    await assert.rejects(persist(job, invalid), /Malformed normalization correction/);
    assert.equal(await canonical(), before);
  });

  await t.test("source text or timestamp mismatch blocks all canonical writes", async () => {
    const before = await canonical();
    await sql(`update public.transcript_segments set text='changed source' where id='${segmentIds[1]}'`);
    await assert.rejects(persist(job), /transcript source changed/);
    await sql(`update public.transcript_segments set text='no correction' where id='${segmentIds[1]}'`);
    const badTimestamp = patches(); badTimestamp[1].source_timestamp = "2026-11-04T12:00:09.000Z";
    await assert.rejects(persist(job, badTimestamp), /transcript source changed/);
    assert.equal(await canonical(), before);
  });

  await t.test("a deliberate segment-update failure rolls back every segment", async () => {
    const before = await canonical();
    await sql(`create function public.b2_norm_fail_segment() returns trigger language plpgsql as $f$
      begin if new.id='${segmentIds[2]}' then raise exception 'mid-transaction segment failure' using errcode='XX001'; end if; return new; end $f$;
      create trigger b2_norm_fail_segment before update on public.transcript_segments
      for each row execute function public.b2_norm_fail_segment();`);
    const changed = patches(); changed[0].normalized_text = "different canonical result";
    await assert.rejects(persist(job, changed), /mid-transaction segment failure/);
    assert.equal(await canonical(), before);
    await sql(`drop trigger b2_norm_fail_segment on public.transcript_segments; drop function public.b2_norm_fail_segment();`);
  });

  await t.test("a vocabulary failure rolls back transcript changes, and vocabulary replay stays idempotent", async () => {
    const before = { canonical: await canonical(), vocabulary: await vocabulary() };
    await sql(`create function public.b2_norm_fail_vocabulary() returns trigger language plpgsql as $f$
      begin raise exception 'vocabulary failure' using errcode='XX002'; end $f$;
      create trigger b2_norm_fail_vocabulary before insert on public.project_vocabulary
      for each row execute function public.b2_norm_fail_vocabulary();`);
    const changed = patches(); changed[0].normalized_text = "must roll back";
    await assert.rejects(persist(job, changed, [{ ...suggestions()[0], canonical_term: "New term" }]), /vocabulary failure/);
    assert.deepEqual({ canonical: await canonical(), vocabulary: await vocabulary() }, before);
    await sql(`drop trigger b2_norm_fail_vocabulary on public.project_vocabulary; drop function public.b2_norm_fail_vocabulary();`);
    await persist(job, patches(), [{ ...suggestions()[0], observed_alias: "ACME" }]);
    await persist(job, patches(), [{ ...suggestions()[0], observed_alias: "ACME" }]);
    assert.equal(await sql(`select array_to_string(aliases, ',') from public.project_vocabulary where project_id='${projectId}' and lower(canonical_term)='acme'`), "acme,ACME");
  });

  await t.test("terminal and wrong-pipeline jobs fail closed", async () => {
    const before = await canonical();
    await sql(`update public.meeting_analysis_jobs set status='completed' where id='${job.job_id}'`);
    await assert.rejects(persist(job), /terminal/);
    await sql(`update public.meeting_analysis_jobs set status='running', pipeline_version=1 where id='${job.job_id}'`);
    await assert.rejects(persist(job), /requires B2 pipeline/);
    await sql(`update public.meeting_analysis_jobs set pipeline_version=2 where id='${job.job_id}'`);
    assert.equal(await canonical(), before);
  });

  await t.test("a newer generation claimed before old persistence makes the old call mutate zero rows", async () => {
    const before = await canonical();
    const newer = await claim();
    await assert.rejects(persist(job, patches().map((patch) => ({ ...patch, normalized_text: "stale" }))), /Stale analysis generation/);
    assert.equal(await canonical(), before);
    job = newer;
  });

  await t.test("the meeting lock orders persistence before a concurrent newer claim", async () => {
    const changed = patches(); changed[0].normalized_text = "old committed before claim";
    await sql(`create function public.b2_norm_slow_segment() returns trigger language plpgsql as $f$
      begin if new.id='${segmentIds[0]}' then perform pg_sleep(1); end if; return new; end $f$;
      create trigger b2_norm_slow_segment before update on public.transcript_segments
      for each row execute function public.b2_norm_slow_segment();`);
    const oldCall = persist(job, changed, []);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const newerCall = claim();
    await oldCall;
    const newer = await newerCall;
    assert.equal(JSON.parse(await canonical())[0].normalized_text, "old committed before claim");
    await assert.rejects(persist(job, patches()), /Stale analysis generation/);
    await sql(`drop trigger b2_norm_slow_segment on public.transcript_segments; drop function public.b2_norm_slow_segment();`);
    job = newer;
  });

  await t.test("RPC success without checkpoint can be replayed, but superseding between calls blocks the replay", async () => {
    const beforeCheckpoint = await checkpoint(job);
    await persist(job);
    assert.equal(await checkpoint(job), beforeCheckpoint);
    await persist(job);
    const before = await canonical();
    const newer = await claim();
    await assert.rejects(persist(job), /Stale analysis generation/);
    assert.equal(await canonical(), before);
    job = newer;
  });

  await t.test("anon, authenticated and PUBLIC cannot execute the RPC; service_role can", async () => {
    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(sql(`set role ${role}; select public.persist_meeting_normalization_v2('${job.job_id}', ${job.generation}, now(), '[]'::jsonb)`), /permission denied/);
    }
    assert.ok(await sql(`set role service_role; select public.persist_meeting_normalization_v2('${job.job_id}', ${job.generation}, now(), $p$${JSON.stringify(patches())}$p$::jsonb)`));
  });
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import test from "node:test";

const run = promisify(execFile);
const url = process.env.B1_TEST_DATABASE_URL;
const meetingId = "00000000-0000-4000-8000-0000000000b1";

type Job = { job_id: string; generation: number };
type Topic = { topic_index: number; title: string | null; insights: Array<{ category: string; content: string | null }> };

function topic(index: number, title: string | null = `Topic ${index}`, categories = ["product_summary", "requirements"]): Topic {
  return { topic_index: index, title, insights: categories.map((category, i) => ({ category, content: `t${index}-i${i}` })) };
}
function payload(topics: Topic[]) {
  return topics.map((value) => ({
    summary: `Summary ${value.topic_index}`, start_timestamp: "", end_timestamp: "",
    segment_ids: [`seg-${value.topic_index}`], confidence: 0.5, separation_reason: "", ...value,
    insights: value.insights.map((insight) => ({ ...insight, confidence: null }))
  }));
}

test("B1 canonical topic replacement RPC (isolated local scratch database)", { skip: !url }, async (t) => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname), "local scratch database required");
  assert.equal(parsed.pathname, "/actionflow_b1_scratch");
  async function sql(query: string) {
    // VERBOSITY=verbose puts the SQLSTATE in error text, so tests can assert exact codes.
    const { stdout } = await run("psql", [url!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", query]);
    return stdout.trim();
  }
  async function replace(job: Job, topics: unknown[], meetingInsights: unknown[] = []) {
    return JSON.parse(await sql(`select public.replace_meeting_topic_analysis_v2('${job.job_id}', ${job.generation}, $j$${JSON.stringify(topics)}$j$::jsonb, $j$${JSON.stringify(meetingInsights)}$j$::jsonb)`));
  }
  const claim = async (v = 2): Promise<Job> => JSON.parse(await sql(`select public.claim_meeting_analysis_job${v === 2 ? "_v2" : ""}('${meetingId}')`));
  const canonical = () => sql(`select coalesce(string_agg(t.topic_index || ':' || t.title || '=' || coalesce((select string_agg(i.content, ',' order by i.content) from public.extracted_insights i where i.topic_id = t.id), ''), '|' order by t.topic_index), '') from public.meeting_topics t where t.meeting_id = '${meetingId}'`);
  const topicIds = () => sql(`select string_agg(id::text, ',' order by topic_index) from public.meeting_topics where meeting_id = '${meetingId}'`);
  const count = (table: string) => sql(`select count(*) from public.${table} where meeting_id = '${meetingId}'`);

  for (const file of [
    "fixtures/analysis-v2/bootstrap.sql",
    "fixtures/analysis-v2/topics-bootstrap.sql",
    "../supabase/migrations/20260615211000_add_meeting_topics.sql",
    "../supabase/migrations/20260724140000_add_background_analysis_jobs.sql",
    "../supabase/migrations/20260724143000_add_analysis_job_checkpoint.sql",
    "../supabase/migrations/20261016090000_add_analysis_pipeline_v2_units.sql",
    "../supabase/migrations/20261027090000_add_v2_canonical_topic_persistence.sql"
  ]) await sql(await readFile(new URL(file, import.meta.url), "utf8"));
  await sql(`insert into public.meetings(id) values ('${meetingId}'); grant all on public.meeting_analysis_jobs, public.meeting_topics, public.extracted_insights to service_role;`);

  try {
    await t.test("legacy v1 topic rows without topic_index remain valid", async () => {
      await sql(`insert into public.meeting_topics(meeting_id, title) values ('${meetingId}', 'legacy a'), ('${meetingId}', 'legacy b')`);
      assert.equal(await sql(`select count(*) from public.meeting_topics where topic_index is null`), "2");
      await assert.rejects(sql(`insert into public.meeting_topics(meeting_id, title, topic_index) values ('${meetingId}', 'neg', -1)`), /check constraint/);
    });

    const v1 = await claim(1);
    await t.test("a pipeline v1 job cannot use the v2 replacement", async () => {
      await assert.rejects(replace(v1, payload([topic(0)])), /requires pipeline/);
      assert.equal(await count("meeting_topics"), "2");
    });

    const job = await claim();
    let firstIds = "";
    await t.test("successful replacement: one topic per descriptor, insights mapped by ordinal", async () => {
      const result = await replace(job, payload([topic(0), topic(1, "Topic 1", ["decisions"]), topic(2)]));
      assert.deepEqual(result.topics.map((row: { topic_index: number }) => row.topic_index), [0, 1, 2]);
      assert.deepEqual(result.insights.map((row: { topic_index: number; content: string }) => `${row.topic_index}:${row.content}`),
        ["0:t0-i0", "0:t0-i1", "1:t1-i0", "2:t2-i0", "2:t2-i1"]);
      for (const insight of result.insights) {
        assert.equal(insight.topic_id, result.topics[insight.topic_index].id);
      }
      assert.equal(await canonical(), "0:Topic 0=t0-i0,t0-i1|1:Topic 1=t1-i0|2:Topic 2=t2-i0,t2-i1");
      assert.equal(await sql(`select count(*) from public.meeting_topics where title like 'legacy%'`), "0");
      firstIds = await topicIds();
    });

    await t.test("replacement never writes the job checkpoint", async () => {
      assert.equal(await sql(`select checkpoint::text from public.meeting_analysis_jobs where id='${job.job_id}'`), '{"checkpointVersion": 2}');
    });

    await t.test("repeated/ambiguous retry is idempotent: one set, no duplicate topics or insights", async () => {
      const before = await canonical();
      await replace(job, payload([topic(0), topic(1, "Topic 1", ["decisions"]), topic(2)]));
      await Promise.all([1, 2].map(() => replace(job, payload([topic(0), topic(1, "Topic 1", ["decisions"]), topic(2)]))));
      assert.equal(await canonical(), before);
      assert.equal(await count("meeting_topics"), "3");
      assert.equal(await count("extracted_insights"), "5");
      firstIds = await topicIds();
    });

    await t.test("a rejected topic row (23502) raises TF001 and rolls back to the prior canonical set", async () => {
      const before = await canonical();
      await assert.rejects(replace(job, payload([topic(0, "New 0"), topic(1, null)])), /TF001: Canonical topic insert rejected \(23502\)/);
      assert.equal(await canonical(), before);
      assert.equal(await topicIds(), firstIds);
    });

    await t.test("a rejected insight batch (23502) drops only that topic's insights (v1 parity)", async () => {
      const rejected = { ...topic(1), insights: [{ category: "requirements", content: "kept?" }, { category: "risks", content: null }] };
      const result = await replace(job, payload([topic(0), rejected, topic(2)]));
      assert.deepEqual(result.dropped_insight_topic_indexes, [1]);
      assert.equal(await canonical(), "0:Topic 0=t0-i0,t0-i1|1:Topic 1=|2:Topic 2=t2-i0,t2-i1");
      assert.equal(result.insights.length, 4);
    });

    await t.test("'decisions' insights persist (no category constraint, as on staging)", async () => {
      await replace(job, payload([topic(0, "Topic 0", ["decisions", "product_summary"])]));
      assert.equal(await sql(`select string_agg(category, ',' order by category) from public.extracted_insights where meeting_id='${meetingId}'`), "decisions,product_summary");
    });

    // Scratch-only objects simulating each failure class at the exact topic INSERT statement.
    await sql(`
      alter table public.meeting_topics add constraint b1_test_rejects_title check (title <> 'REJECT');
      create function public.b1_test_topic_insert() returns trigger language plpgsql as $f$
      begin
        if new.title = 'CONNECTION' then raise exception 'simulated connection failure' using errcode = '08006'; end if;
        if new.title = 'SERIALIZATION' then raise exception 'simulated serialization failure' using errcode = '40001'; end if;
        if new.title = 'RESOURCES' then raise exception 'simulated resource exhaustion' using errcode = '53200'; end if;
        if new.title = 'SLOW' then perform pg_sleep(2); end if;
        return new;
      end $f$;
      create trigger b1_test_topic_insert before insert on public.meeting_topics
        for each row execute function public.b1_test_topic_insert();`);
    await replace(job, payload([topic(0), topic(1)]));
    const prior = await canonical();
    const priorIds = await topicIds();

    await t.test("[fallback boundary] a check-constraint rejection (23514) raises TF001, prior set intact", async () => {
      await assert.rejects(replace(job, payload([topic(0, "fine"), topic(1, "REJECT")])), /TF001: Canonical topic insert rejected \(23514\)/);
      assert.equal(await canonical(), prior);
      assert.equal(await topicIds(), priorIds);
    });

    await t.test("[fallback boundary] connection, serialization, resource, and timeout errors are NOT TF001", async () => {
      for (const [title, code] of [["CONNECTION", "08006"], ["SERIALIZATION", "40001"], ["RESOURCES", "53200"]]) {
        await assert.rejects(replace(job, payload([topic(0, title)])), (error: Error) => error.message.includes(`ERROR:  ${code}:`) && !error.message.includes("TF001"));
      }
      await assert.rejects(
        sql(`set statement_timeout = 300; select public.replace_meeting_topic_analysis_v2('${job.job_id}', ${job.generation}, $j$${JSON.stringify(payload([topic(0, "SLOW")]))}$j$::jsonb)`),
        (error: Error) => error.message.includes("ERROR:  57014:") && !error.message.includes("TF001"));
      assert.equal(await canonical(), prior);
      assert.equal(await topicIds(), priorIds);
    });

    await t.test("[fallback] whole-meeting replacement after TF001 leaves no partial topic state and is idempotent", async () => {
      const fallback = [{ category: "product_summary", content: "whole", confidence: null }, { category: "decisions", content: "agreed", confidence: null }];
      await replace(job, [], fallback);
      const state = await sql(`select coalesce(string_agg(coalesce(topic_id::text, 'null') || ':' || category || ':' || content, ',' order by content), '') from public.extracted_insights where meeting_id='${meetingId}'`);
      assert.equal(state, "null:decisions:agreed,null:product_summary:whole");
      assert.equal(await count("meeting_topics"), "0");
      await replace(job, [], fallback);
      await Promise.all([replace(job, [], fallback), replace(job, [], fallback)]);
      assert.equal(await sql(`select coalesce(string_agg(coalesce(topic_id::text, 'null') || ':' || category || ':' || content, ',' order by content), '') from public.extracted_insights where meeting_id='${meetingId}'`), state);
      assert.equal(await count("meeting_topics"), "0");
      assert.equal(await sql(`select checkpoint::text from public.meeting_analysis_jobs where id='${job.job_id}'`), '{"checkpointVersion": 2}');
    });

    await sql(`drop trigger b1_test_topic_insert on public.meeting_topics; drop function public.b1_test_topic_insert();
      alter table public.meeting_topics drop constraint b1_test_rejects_title;`);
    await replace(job, payload([topic(0), topic(1, "Topic 1", ["decisions"]), topic(2)]));

    await t.test("missing, duplicate, unordered, or malformed ordinals are rejected before side effects", async () => {
      const before = await canonical();
      for (const bad of [[topic(0), topic(2)], [topic(0), topic(0)], [topic(1), topic(0)], [topic(1)]]) {
        await assert.rejects(replace(job, payload(bad)), /contiguous/);
      }
      await assert.rejects(replace(job, [{ ...payload([topic(0)])[0], topic_index: "0" }]), /contiguous/);
      await assert.rejects(replace(job, [{ ...payload([topic(0)])[0], insights: null }]), /contiguous/);
      await assert.rejects(replace(job, payload([topic(0)]), [{ category: "requirements", content: "x" }]), /Invalid canonical/);
      assert.equal(await canonical(), before);
    });

    await t.test("whole-meeting fallback replaces topics with topic-less insights", async () => {
      const result = await replace(job, [], [{ category: "product_summary", content: "whole", confidence: null }]);
      assert.equal(result.topics.length, 0);
      assert.equal(await count("meeting_topics"), "0");
      assert.equal(await sql(`select string_agg(coalesce(topic_id::text, 'null') || ':' || content, ',') from public.extracted_insights where meeting_id='${meetingId}'`), "null:whole");
      await replace(job, payload([topic(0), topic(1)]));
    });

    await t.test("mismatched expected generation is rejected before side effects", async () => {
      const before = await canonical();
      await assert.rejects(replace({ ...job, generation: job.generation + 1 }, payload([topic(0)])), /Stale/);
      assert.equal(await canonical(), before);
    });

    const newer = await claim();
    await t.test("a newer generation prevents the old canonical finalizer", async () => {
      const before = await canonical();
      await assert.rejects(replace(job, payload([topic(0, "stale")])), /Stale/);
      assert.equal(await canonical(), before);
      await replace(newer, payload([topic(0, "newer")]));
      assert.equal(await canonical(), "0:newer=t0-i0,t0-i1");
    });

    await t.test("a terminal job is rejected", async () => {
      await sql(`update public.meeting_analysis_jobs set status='completed' where id='${newer.job_id}'`);
      await assert.rejects(replace(newer, payload([topic(0)])), /terminal/);
      assert.equal(await canonical(), "0:newer=t0-i0,t0-i1");
    });

    await t.test("clients cannot call the replacement RPC", async () => {
      for (const role of ["anon", "authenticated"]) {
        await assert.rejects(sql(`set role ${role}; select public.replace_meeting_topic_analysis_v2('${newer.job_id}', ${newer.generation}, '[]'::jsonb)`), /permission denied/);
      }
    });
  } finally {
    // Test data only. Caller owns dropping the isolated database/cluster after verification.
    await sql(`delete from public.meetings where id='${meetingId}'`);
  }
});

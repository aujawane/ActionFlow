import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import test from "node:test";

const run = promisify(execFile);
const url = process.env.B0_TEST_DATABASE_URL;
const meetingId = "00000000-0000-4000-8000-000000000001";

test("v2 PostgreSQL lifecycle contract (isolated local scratch database)", { skip: !url }, async (t) => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname), "local scratch database required");
  assert.equal(parsed.pathname, "/actionflow_b0_scratch");
  async function sql(query: string) {
    const { stdout } = await run("psql", [url!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query]);
    return stdout.trim();
  }
  async function rpc(action: string, job: { job_id: string; generation: number }, key: string, attempt = 1, result = '"X"') {
    const extra = action === "complete" ? `, '${result}'::jsonb` : action === "fail" ? ", 'timeout'" : "";
    const name = action === "running" ? "mark_meeting_analysis_job_unit_running" : `${action}_meeting_analysis_job_unit`;
    return JSON.parse(await sql(`select row_to_json(u) from public.${name}('${job.job_id}', 'probe', '${key}', ${attempt}${extra}, 2::smallint, ${job.generation}) u;`));
  }
  const claim = async (v = 2) => JSON.parse(await sql(`select public.claim_meeting_analysis_job${v === 2 ? "_v2" : ""}('${meetingId}')`));
  try {
    // Fresh test database, fail rather than silently accepting an existing schema.
    for (const file of [
      "fixtures/analysis-v2/bootstrap.sql",
      "../supabase/migrations/20260724140000_add_background_analysis_jobs.sql",
      "../supabase/migrations/20260724143000_add_analysis_job_checkpoint.sql",
      "../supabase/migrations/20261016090000_add_analysis_pipeline_v2_units.sql"
    ]) await sql(await readFile(new URL(file, import.meta.url), "utf8"));
    await sql(`insert into public.meetings(id) values ('${meetingId}'); grant all on public.meeting_analysis_jobs to service_role;`);
    const v1 = await claim(1);
    await t.test("v1 claim still produces pipeline_version=1", async () => {
      assert.equal(await sql(`select pipeline_version from public.meeting_analysis_jobs where id='${v1.job_id}'`), "1");
    });
    await t.test("v1 job cannot enter v2 unit RPC", async () => {
      await assert.rejects(rpc("running", v1, "A"), /requires pipeline/);
    });
    const job = await claim();
    await t.test("v2 claim creates version 2 with checkpointVersion=2", async () => {
      assert.equal(await sql(`select pipeline_version || ':' || (checkpoint->>'checkpointVersion') from public.meeting_analysis_jobs where id='${job.job_id}'`), "2:2");
    });
    await t.test("two distinct concurrent unit completions both survive", async () => {
      await Promise.all([rpc("running", job, "A"), rpc("running", job, "B")]);
      await Promise.all([rpc("complete", job, "A", 1, '{"value":"A"}'), rpc("complete", job, "B", 1, '{"value":"B"}')]);
      assert.equal(await sql(`select string_agg(result->>'value', ',' order by unit_key) from public.meeting_analysis_job_units where job_id='${job.job_id}'`), "A,B");
    });
    await t.test("same-unit ambiguous/concurrent completions preserve the first result", async () => {
      await rpc("running", job, "C");
      await rpc("complete", job, "C", 1, '"X"');
      assert.equal((await rpc("complete", job, "C", 2, '"Y"')).result, "X");
      await rpc("running", job, "race");
      const results = await Promise.all([rpc("complete", job, "race", 1, '"X"'), rpc("complete", job, "race", 2, '"Y"')]);
      assert.equal(results[0].result, results[1].result);
    });
    await t.test("completed unit can be read and reused; fail/running cannot erase acceptance", async () => {
      assert.equal((await rpc("running", job, "C", 3)).result, "X");
      assert.equal((await rpc("fail", job, "C", 3)).status, "completed");
      assert.equal(await sql(`select result#>>'{}' from public.meeting_analysis_job_units where job_id='${job.job_id}' and unit_key='C'`), "X");
    });
    await t.test("attempt never decreases and first started_at survives retries", async () => {
      const first = await rpc("running", job, "D", 2);
      const second = await rpc("running", job, "D", 1);
      assert.equal(second.attempt, 2);
      assert.equal(first.started_at, second.started_at);
      assert.equal((await rpc("complete", job, "D", 1)).attempt, 2);
    });
    await t.test("job retry_count never decreases across units", async () => {
      await rpc("running", job, "E", 5);
      await rpc("running", job, "F", 1);
      assert.equal(await sql(`select retry_count from public.meeting_analysis_jobs where id='${job.job_id}'`), "4");
      await sql(`update public.meeting_analysis_jobs set retry_count=0 where id='${job.job_id}'`);
      assert.equal(await sql(`select retry_count from public.meeting_analysis_jobs where id='${job.job_id}'`), "4");
    });
    await t.test("invalid status transitions and attempts rejected; failed units restart", async () => {
      await assert.rejects(rpc("complete", job, "missing"), /must be running/);
      await assert.rejects(rpc("fail", job, "missing"), /must be running/);
      await assert.rejects(rpc("running", job, "bad", 0), /Invalid unit/);
      await rpc("running", job, "failed");
      await rpc("fail", job, "failed");
      await assert.rejects(rpc("complete", job, "failed"), /must be running/);
      assert.equal((await rpc("running", job, "failed", 2)).status, "running");
      await sql(`insert into public.meeting_analysis_job_units(job_id,stage,unit_key) values ('${job.job_id}', 'probe','pending')`);
      await assert.rejects(rpc("complete", job, "pending"), /must be running/);
      await assert.rejects(sql(`update public.meeting_analysis_job_units set status='invalid' where job_id='${job.job_id}'`), /check constraint/);
    });
    await t.test("expected generation/version and checkpoint mismatch rejected", async () => {
      await assert.rejects(rpc("running", { ...job, generation: 999 }, "bad"), /Stale/);
      await assert.rejects(sql(`select public.mark_meeting_analysis_job_unit_running('${job.job_id}', 'probe','bad',1,1::smallint)`), /requires pipeline/);
      await sql(`update public.meeting_analysis_jobs set checkpoint='{}' where id='${job.job_id}'`);
      await assert.rejects(rpc("running", job, "bad"), /requires pipeline/);
      await sql(`update public.meeting_analysis_jobs set checkpoint='{"checkpointVersion":2}' where id='${job.job_id}'`);
    });
    await t.test("units cannot overwrite canonical checkpoint", async () => {
      assert.equal(await sql(`select checkpoint::text from public.meeting_analysis_jobs where id='${job.job_id}'`), '{"checkpointVersion": 2}');
    });
    const newer = await claim();
    await t.test("reanalysis creates a clean generation without inherited units", async () => {
      assert.equal(newer.generation, job.generation + 1);
      assert.equal(await sql(`select count(*) from public.meeting_analysis_job_units where job_id='${newer.job_id}'`), "0");
    });
    await t.test("different jobs can share stage/unit_key", async () => {
      await rpc("running", newer, "A");
      assert.equal(await sql("select count(*) from public.meeting_analysis_job_units where stage='probe' and unit_key='A'"), "2");
    });
    await t.test("stale generation cannot complete or claim a unit", async () => {
      await assert.rejects(rpc("complete", job, "F"), /Stale/);
      await assert.rejects(rpc("running", job, "old"), /Stale/);
    });
    await t.test("terminal parent rejects every mutation", async () => {
      await sql(`update public.meeting_analysis_jobs set status='completed' where id='${newer.job_id}'`);
      for (const action of ["running", "complete", "fail"]) await assert.rejects(rpc(action, newer, "A"), /terminal/);
    });
    await t.test("RLS and grants prevent client reads, writes, and lifecycle calls", async () => {
      for (const role of ["anon", "authenticated"]) {
        for (const query of ["select * from public.meeting_analysis_job_units", "delete from public.meeting_analysis_job_units", `select public.claim_meeting_analysis_job_v2('${meetingId}')`, `select public.mark_meeting_analysis_job_unit_running('${newer.job_id}', 'probe','bad',1)`]) {
          await assert.rejects(sql(`set role ${role}; ${query}`), /permission denied/);
        }
      }
      assert.equal(await sql("select relrowsecurity from pg_class where oid='public.meeting_analysis_job_units'::regclass"), "t");
      // Exercise SECURITY INVOKER grants for the actual execution role.
      assert.ok(await sql(`set role service_role; select public.claim_meeting_analysis_job_v2('${meetingId}')`));
    });
    await t.test("unit rows cascade when their job is deleted", async () => {
      await sql(`delete from public.meeting_analysis_jobs where id='${job.job_id}'`);
      assert.equal(await sql(`select count(*) from public.meeting_analysis_job_units where job_id='${job.job_id}'`), "0");
    });
  } finally {
    // Test data only. Caller owns dropping the isolated database/cluster after verification.
    await sql(`delete from public.meetings where id='${meetingId}'`);
  }
});

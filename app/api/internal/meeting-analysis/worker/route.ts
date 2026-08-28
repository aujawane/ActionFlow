import { after, NextResponse } from "next/server";

import {
  ANALYSIS_STAGE_ORDER,
  ANALYSIS_STAGES,
  markAnalysisJobTerminal,
  StaleAnalysisError,
  type WorkerAnalysisStage
} from "@/lib/meeting-analysis/jobs";
import { runMeetingAnalysisStage } from "@/lib/meeting-analysis/worker";
import { getAppBaseUrl, requireEnv } from "@/lib/env";

/** Never logs full error objects/stacks (which can embed request payloads) -- only a short,
 * human-readable message, matching what already gets returned to the client in the 500 body. */
function sanitizedErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * One analysis stage per invocation. Long meetings chain stages via after()
 * so each hop gets a fresh Vercel function duration budget.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

function isWorkerStage(value: unknown): value is WorkerAnalysisStage {
  return (
    typeof value === "string" &&
    (ANALYSIS_STAGE_ORDER as readonly string[]).includes(value)
  );
}

async function dispatchNextStage(input: {
  meetingId: string;
  jobId: string;
  generation: number;
  stage: WorkerAnalysisStage;
  requestOrigin?: string;
}) {
  const internalSecret = requireEnv("RECALL_WEBHOOK_SECRET");
  const baseUrl = getAppBaseUrl({ requestOrigin: input.requestOrigin });
  const response = await fetch(
    `${baseUrl}/api/internal/meeting-analysis/worker`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-parfait-internal-secret": internalSecret
      },
      body: JSON.stringify({
        meetingId: input.meetingId,
        jobId: input.jobId,
        generation: input.generation,
        stage: input.stage
      })
    }
  );
  if (!response.ok) {
    const text = await response.text();
    console.warn("[meeting-analysis-worker] Failed to chain next stage", {
      status: response.status,
      body: text,
      stage: input.stage,
      job_id: input.jobId
    });
  }
}

export async function POST(request: Request) {
  const configuredInternalSecret = process.env.RECALL_WEBHOOK_SECRET?.trim();
  const suppliedInternalSecret = request.headers
    .get("x-parfait-internal-secret")
    ?.trim();
  if (
    !configuredInternalSecret ||
    suppliedInternalSecret !== configuredInternalSecret
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    meetingId?: string;
    jobId?: string;
    generation?: number;
    stage?: string;
    retryCount?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const meetingId = body.meetingId?.trim();
  const jobId = body.jobId?.trim();
  const generation = body.generation;
  const stage = body.stage;
  if (
    !meetingId ||
    !jobId ||
    typeof generation !== "number" ||
    !isWorkerStage(stage)
  ) {
    return NextResponse.json(
      { error: "meetingId, jobId, generation, and stage are required" },
      { status: 400 }
    );
  }

  const logContext = { job_id: jobId, meeting_id: meetingId, generation, stage };
  const stageStartedAt = Date.now();
  console.info("[meeting-analysis-worker] stage start", logContext);

  try {
    const result = await runMeetingAnalysisStage({
      meetingId,
      jobId,
      generation,
      stage,
      retryCount: body.retryCount
    });

    console.info("[meeting-analysis-worker] stage success", {
      ...logContext,
      next_stage: result.nextStage,
      done: result.done,
      elapsed_ms: Date.now() - stageStartedAt
    });

    if (result.nextStage) {
      const requestOrigin = new URL(request.url).origin;
      after(() =>
        dispatchNextStage({
          meetingId,
          jobId,
          generation,
          stage: result.nextStage!,
          requestOrigin
        })
      );
    }

    return NextResponse.json({
      ok: true,
      stage,
      nextStage: result.nextStage,
      done: result.done
    });
  } catch (error) {
    const elapsedMs = Date.now() - stageStartedAt;

    if (error instanceof StaleAnalysisError || (error as Error)?.name === "StaleAnalysisError") {
      // assertAnalysisJobStillCurrent() already persisted status="stale" before throwing --
      // nothing further to mark here, and a stale generation must never be reported as "failed".
      console.info("[meeting-analysis-worker] stage stale", { ...logContext, elapsed_ms: elapsedMs });
      return NextResponse.json(
        { ok: false, stale: true, error: (error as Error).message },
        { status: 409 }
      );
    }

    const message = sanitizedErrorMessage(error, "Analysis stage failed");
    console.error("[meeting-analysis-worker] stage failure", {
      ...logContext,
      elapsed_ms: elapsedMs,
      error: message
    });

    // runMeetingAnalysisStage() already marks the job failed for errors raised inside its own
    // work (see lib/meeting-analysis/worker.ts), but assertAnalysisJobStillCurrent() and
    // markAnalysisJobRunning() run before that try block, and a failure persisting *that* state
    // would itself throw uncaught. This is a defensive, idempotent backstop: reusing the same
    // terminal-state helper here guarantees the job is never left stuck in "running" no matter
    // where in the stage the failure originated, without duplicating the update logic.
    try {
      await markAnalysisJobTerminal({
        jobId,
        status: "failed",
        stage,
        progress: ANALYSIS_STAGES[stage].progress,
        error: message
      });
    } catch (persistError) {
      console.error("[meeting-analysis-worker] failed to persist terminal failure state", {
        ...logContext,
        persist_error: sanitizedErrorMessage(persistError, "Unknown persistence error")
      });
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

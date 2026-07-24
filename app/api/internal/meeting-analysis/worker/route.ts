import { after, NextResponse } from "next/server";

import {
  ANALYSIS_STAGE_ORDER,
  StaleAnalysisError,
  type WorkerAnalysisStage
} from "@/lib/meeting-analysis/jobs";
import { runMeetingAnalysisStage } from "@/lib/meeting-analysis/worker";
import { getAppBaseUrl, requireEnv } from "@/lib/env";

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

  try {
    const result = await runMeetingAnalysisStage({
      meetingId,
      jobId,
      generation,
      stage,
      retryCount: body.retryCount
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
    if (error instanceof StaleAnalysisError || (error as Error)?.name === "StaleAnalysisError") {
      return NextResponse.json(
        { ok: false, stale: true, error: (error as Error).message },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Analysis stage failed"
      },
      { status: 500 }
    );
  }
}

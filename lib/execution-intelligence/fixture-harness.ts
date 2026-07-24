import { createHash } from "node:crypto";

import type { EvaluationSet } from "./evaluation";
import { runExecutionIntelligence } from "./pipeline";

export type ExecutionEvaluationFixture = {
  id: string;
  transcript: string;
  expected: EvaluationSet;
};

export function fixtureSegmentId(id: string) {
  const hex = createHash("sha256").update(id).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function buildFixtureTranscript(fixture: ExecutionEvaluationFixture) {
  return `[${fixtureSegmentId(fixture.id)}] ${fixture.transcript}`;
}

export async function runLiveExecutionFixture(
  fixture: ExecutionEvaluationFixture
): Promise<
  | { ok: true; prediction: EvaluationSet; latencyMs: number }
  | { ok: false; error: string; latencyMs: number }
> {
  const startedAt = Date.now();
  const result = await runExecutionIntelligence({
    fallbackUsed: true,
    generation: 1,
    source: {
      meetingId: fixtureSegmentId(`meeting-${fixture.id}`),
      meetingDate: "2026-07-23T12:00:00.000Z",
      transcript: buildFixtureTranscript(fixture),
      topics: [],
      insights: []
    },
    dependencies: {
      persistGraph: async () => ({ ok: true, commitments: [], tasks: [] })
    }
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      latencyMs: Date.now() - startedAt
    };
  }
  return {
    ok: true,
    prediction: {
      commitments: result.graph.commitments.map((item) => ({
        title: item.title,
        owner: item.owner,
        due_date: item.due_date,
        source_quote: item.source_quote
      })),
      tasks: result.graph.tasks.map((item) => ({
        title: item.title,
        owner: item.owner,
        due_date: item.due_date,
        source_quote: item.source_quote
      }))
    },
    latencyMs: Date.now() - startedAt
  };
}

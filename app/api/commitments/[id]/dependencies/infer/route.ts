import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedCommitment } from "@/lib/project-access";
import { inferAndApplyDependenciesForCommitment } from "@/lib/task-dependency-inference";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingTask, TaskDependency } from "@/lib/types";

/** Manual "Re-evaluate dependencies" trigger (see CommitmentCorrectionMenu) -- the deliberate,
 * user-initiated re-run path for after restructuring work (tasks added/moved, Project Brain
 * changes) that section 15/23 of the brief scopes out of automatic re-triggering, to avoid
 * excessive repeated model calls. Reuses the exact same inference/validation/persistence core
 * the post-analysis best-effort pass uses (lib/task-dependency-inference.ts) -- no second
 * implementation, no new ownership model. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;

  const commitment = await getOwnedCommitment(id, auth.user.id);
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }

  const [{ data: tasks, error: tasksError }, { data: meeting }] = await Promise.all([
    supabaseAdmin.from("meeting_tasks").select("*").eq("commitment_id", id),
    supabaseAdmin
      .from("meetings")
      .select("execution_graph_generation")
      .eq("id", commitment.meeting_id)
      .maybeSingle()
  ]);
  if (tasksError) {
    return NextResponse.json(
      { error: "Failed to load commitment tasks.", details: tasksError.message },
      { status: 500 }
    );
  }

  const commitmentTasks = (tasks ?? []) as MeetingTask[];
  if (commitmentTasks.length < 2) {
    return NextResponse.json({
      dependencies: [],
      diagnostics: {
        commitmentId: id,
        candidateTaskCount: commitmentTasks.length,
        proposedEdgeCount: 0,
        acceptedEdgeCount: 0,
        rejectedInvalidCount: 0,
        rejectedCycleCount: 0,
        lockedTaskCount: 0
      }
    });
  }

  const taskIds = commitmentTasks.map((task) => task.id);
  const { data: existingDependencies, error: dependenciesError } = await supabaseAdmin
    .from("task_dependencies")
    .select("*")
    .in("task_id", taskIds);
  if (dependenciesError) {
    return NextResponse.json(
      { error: "Failed to load existing dependencies.", details: dependenciesError.message },
      { status: 500 }
    );
  }

  const result = await inferAndApplyDependenciesForCommitment({
    commitment,
    tasks: commitmentTasks,
    existingDependencies: (existingDependencies ?? []) as TaskDependency[],
    // No cached topic-transcript context outside the analysis pipeline -- inference here relies
    // on per-task stored evidence (source_quote, description) plus commitment context, which is
    // deliberately lighter than the post-analysis run (see final report).
    currentGeneration: (meeting as { execution_graph_generation?: number } | null)
      ?.execution_graph_generation ?? null
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, details: result.details, diagnostics: result.diagnostics },
      { status: 502 }
    );
  }

  return NextResponse.json({
    dependencies: result.dependencies,
    diagnostics: result.diagnostics
  });
}

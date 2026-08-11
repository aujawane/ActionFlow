import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canonicalTranscriptOrder } from "@/lib/transcript-order";

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const meetingId = new URL(request.url).searchParams.get("meetingId")?.trim();
  if (!meetingId) {
    return NextResponse.json({ error: "meetingId is required." }, { status: 400 });
  }
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!meeting) return NextResponse.json({ error: "Meeting not found." }, { status: 404 });

  const [segments, events, commitments, tasks, job] = await Promise.all([
    supabaseAdmin.from("transcript_segments").select("id, timestamp, speaker, text, raw_payload").eq("meeting_id", meetingId).order("timestamp"),
    supabaseAdmin.from("meeting_conversation_events").select("*").eq("meeting_id", meetingId).order("created_at"),
    supabaseAdmin.from("meeting_commitments").select("*").eq("meeting_id", meetingId).order("created_at"),
    supabaseAdmin.from("meeting_tasks").select("*").eq("meeting_id", meetingId).order("created_at"),
    supabaseAdmin.from("meeting_analysis_jobs").select("generation, status, current_stage, checkpoint").eq("meeting_id", meetingId).order("generation", { ascending: false }).limit(1).maybeSingle()
  ]);
  const error = segments.error ?? events.error ?? commitments.error ?? tasks.error ?? job.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const checkpoint = job.data?.checkpoint as {
    engine?: "independent" | "v4";
    state?: {
      debugTrace?: unknown;
      topicActions?: unknown;
      mergedActions?: unknown;
      extractedCommitments?: unknown;
      relationshipDecisions?: unknown;
      verificationDecisions?: unknown;
      graph?: unknown;
    };
    v4State?: {
      debugTrace?: unknown;
      normalization?: unknown;
      topicWorkItems?: unknown;
      mergedWorkItems?: unknown;
      globalCorrections?: unknown;
      globalAdditions?: unknown;
      workItems?: unknown;
      eligibleWorkItems?: unknown;
      acceptanceCriteriaItems?: unknown;
      draftGroups?: unknown;
      verifiedGroups?: unknown;
      groupDecisions?: unknown;
      workItemDecisions?: unknown;
      recoveryDecisions?: unknown;
      preConsolidationTree?: unknown;
      consolidationDecisions?: unknown;
      consolidationSuggestions?: unknown;
      consolidationProvenance?: unknown;
      completionSignatures?: unknown;
      finalValidation?: unknown;
      tree?: unknown;
      graph?: unknown;
    };
  } | null;
  const engine = checkpoint?.engine ?? "independent";
  const state = checkpoint?.state;
  const v4State = checkpoint?.v4State;
  const independentExecution = state?.debugTrace ?? (state ? {
    version: "independent-commitments-tasks-v1",
    topic_actions: state.topicActions ?? [],
    merged_actions: state.mergedActions ?? [],
    extracted_commitments: state.extractedCommitments ?? [],
    relationship_decisions: state.relationshipDecisions ?? [],
    verification_decisions: state.verificationDecisions ?? [],
    final_graph: state.graph ?? null
  } : null);
  // Phase 8: expose every stage of the hardened V4 pipeline in one place -- normalization,
  // raw topic work items, the merged ledger, scope/role reconciliation, the eligible/criteria
  // subsets actually handed to grouping, excluded items with reasons, both grouping passes' raw
  // output, deterministic assembly's decisions, the pre-consolidation tree, task-consolidation
  // candidates/proposals/suggestions, final validation, and the persisted graph -- so a bad tree
  // is traceable without guessing or rerunning anything.
  const v4Execution = v4State?.debugTrace ?? (v4State ? {
    version: "execution-tree-v4-hardened-2",
    normalization: v4State.normalization ?? null,
    topic_work_items: v4State.topicWorkItems ?? [],
    merged_work_items: v4State.mergedWorkItems ?? [],
    global_corrections: v4State.globalCorrections ?? [],
    global_additions: v4State.globalAdditions ?? [],
    corrected_work_items: v4State.workItems ?? [],
    eligible_work_items: v4State.eligibleWorkItems ?? [],
    acceptance_criteria_items: v4State.acceptanceCriteriaItems ?? [],
    draft_groups: v4State.draftGroups ?? [],
    verified_groups: v4State.verifiedGroups ?? [],
    group_decisions: v4State.groupDecisions ?? [],
    work_item_decisions: v4State.workItemDecisions ?? [],
    recovery_decisions: v4State.recoveryDecisions ?? [],
    pre_consolidation_tree: v4State.preConsolidationTree ?? null,
    consolidation_decisions: v4State.consolidationDecisions ?? [],
    consolidation_suggestions: v4State.consolidationSuggestions ?? [],
    consolidation_provenance: v4State.consolidationProvenance ?? {},
    completion_signatures: v4State.completionSignatures ?? {},
    final_validation: v4State.finalValidation ?? null,
    final_tree: v4State.tree ?? null,
    final_graph: v4State.graph ?? null
  } : null);

  return NextResponse.json({
    meeting_id: meetingId,
    pipeline: {
      transcript: canonicalTranscriptOrder(segments.data ?? []),
      conversation_events: events.data ?? [],
      execution_graph: {
        commitments: commitments.data ?? [],
        tasks: tasks.data ?? []
      },
      execution_intelligence_v2: {
        generation: job.data?.generation ?? null,
        status: job.data?.status ?? null,
        stage: job.data?.current_stage ?? null,
        status_note: "Legacy stage names are retained for durable-job compatibility.",
        engine,
        independent_execution: independentExecution,
        execution_tree_v4: v4Execution
      }
    }
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

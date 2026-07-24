import {
  commitmentCandidateSchema,
  taskCandidateSchema,
  type ExecutionGraph
} from "./schemas";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DroppedItem = {
  kind: "commitment" | "task";
  index: number;
  clientRef: string | null;
  details: string;
};

function repairUuidFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = { ...(value as Record<string, unknown>) };
  if (typeof item.topic_id === "string" && !UUID_PATTERN.test(item.topic_id)) {
    item.topic_id = null;
  }
  if (Array.isArray(item.source_segment_ids)) {
    item.source_segment_ids = item.source_segment_ids.filter(
      (id): id is string => typeof id === "string" && UUID_PATTERN.test(id)
    );
  }
  if (
    typeof item.execution_classification !== "string" ||
    ![
      "committed",
      "proposed",
      "requirement",
      "future_consideration"
    ].includes(item.execution_classification)
  ) {
    item.execution_classification = "committed";
  }
  if (!Array.isArray(item.consolidated_from_refs)) {
    item.consolidated_from_refs = [];
  }
  return item;
}

export function salvageExecutionGraph(raw: unknown):
  | {
      ok: true;
      graph: ExecutionGraph;
      dropped: DroppedItem[];
      inputItemCount: number;
    }
  | { ok: false; details: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, details: "Execution graph root must be an object." };
  }
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.commitments) || !Array.isArray(root.tasks)) {
    return {
      ok: false,
      details: "Execution graph must contain commitment and task arrays."
    };
  }

  const dropped: DroppedItem[] = [];
  const commitments = root.commitments.flatMap((value, index) => {
    const repaired = repairUuidFields(value);
    const parsed = commitmentCandidateSchema.safeParse(repaired);
    if (parsed.success) return [parsed.data];
    dropped.push({
      kind: "commitment",
      index,
      clientRef:
        repaired && typeof repaired === "object" && !Array.isArray(repaired)
          ? String((repaired as Record<string, unknown>).client_ref ?? "") || null
          : null,
      details: parsed.error.message
    });
    return [];
  });
  const tasks = root.tasks.flatMap((value, index) => {
    const repaired = repairUuidFields(value);
    const parsed = taskCandidateSchema.safeParse(repaired);
    if (parsed.success) return [parsed.data];
    dropped.push({
      kind: "task",
      index,
      clientRef:
        repaired && typeof repaired === "object" && !Array.isArray(repaired)
          ? String((repaired as Record<string, unknown>).client_ref ?? "") || null
          : null,
      details: parsed.error.message
    });
    return [];
  });

  return {
    ok: true,
    graph: { commitments, tasks },
    dropped,
    inputItemCount: root.commitments.length + root.tasks.length
  };
}

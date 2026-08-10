import type { ExecutionTree } from "../work-item-schemas";

export type GateFailure = { rule: string; detail: string };
export type GateResult = { ok: boolean; failures: GateFailure[]; notes: string[] };

const REQUIRED_COMMITMENT_PATTERNS: Array<{ label: string; patterns: RegExp[] }> = [
  {
    label: "Deliver Parfait before next Tuesday",
    patterns: [/parfait/i, /deploy|deliver|running|vercel/i]
  },
  {
    label: "Validate/pilot Chatter using real Parfait meeting context",
    patterns: [/chatter/i, /validat|pilot|test/i]
  },
  {
    label: "Establish/clarify enterprise OpenAI/Codex access",
    patterns: [/enterprise/i, /openai|codex/i]
  }
];

const PERSONAL_LOGISTICS_PATTERNS = [/birthday/i, /\b21st\b/i, /family party/i, /come back on the/i];
const COMPLETED_WORK_PATTERNS = [
  /gave you credentials/i,
  /fulfilled my (blocking )?commitment/i,
  /already (gave|provided|fixed)/i
];
const STRATEGIC_DISCUSSION_PATTERNS = [/loop.?engineering/i, /\bai patterns?\b/i, /feedback loops?/i];

type Commitment = ExecutionTree["commitments"][number];

function allActiveItems(tree: ExecutionTree) {
  const items: Array<{ ref: string; title: string }> = [];
  for (const commitment of tree.commitments) {
    items.push({ ref: commitment.ref, title: commitment.title });
    for (const task of commitment.tasks) items.push({ ref: task.ref, title: task.title });
  }
  for (const task of tree.standalone_tasks) items.push({ ref: task.ref, title: task.title });
  return items;
}

/**
 * Hard go/no-go assertions for the Chatter benchmark meeting (see
 * docs/execution-intelligence-v2.md and the "Stabilize Execution Intelligence V4" task). Not a
 * fuzzy scoring metric -- every rule here is a concrete structural or content requirement pulled
 * directly from the two real commitments this meeting is known to contain plus the specific
 * failure modes (cardinality bug, AI-loop misclassification) this stabilization pass targets.
 * Intentionally does not enforce an exact commitment count: an extra commitment is only a failure
 * when it has no accepted-deliverable evidence of its own (rule `no_unsupported_strategic_commitment`).
 */
export function evaluateChatterGate(tree: ExecutionTree): GateResult {
  const failures: GateFailure[] = [];
  const notes: string[] = [];

  const matchedCommitments = new Map<string, Commitment>();
  for (const required of REQUIRED_COMMITMENT_PATTERNS) {
    const matchesAll = (text: string) => required.patterns.every((pattern) => pattern.test(text));
    const match = tree.commitments.find(
      (commitment) => matchesAll(commitment.title) || (commitment.description && matchesAll(commitment.description))
    );
    if (!match) {
      failures.push({
        rule: "required_commitment_present",
        detail: `No commitment found matching "${required.label}".`
      });
    } else {
      matchedCommitments.set(required.label, match);
    }
  }

  const distinctRefs = new Set(Array.from(matchedCommitments.values()).map((c) => c.ref));
  if (matchedCommitments.size === 3 && distinctRefs.size < 3) {
    failures.push({
      rule: "commitments_not_conflated",
      detail:
        "Vercel deployment, Chatter validation, and enterprise access must be three separate commitments, not merged into one."
    });
  }

  for (const commitment of tree.commitments) {
    if (Array.from(matchedCommitments.values()).some((match) => match.ref === commitment.ref)) continue;
    const looksStrategic = STRATEGIC_DISCUSSION_PATTERNS.some(
      (pattern) => pattern.test(commitment.title) || (commitment.description && pattern.test(commitment.description))
    );
    const hasAcceptedActionEvidence =
      commitment.tasks.some((task) => task.acceptance_state === "accepted" && task.work_item_role === "action") ||
      Boolean(commitment.explicit_outcome_evidence?.source_quote?.trim());
    if (looksStrategic && !hasAcceptedActionEvidence) {
      failures.push({
        rule: "no_unsupported_strategic_commitment",
        detail: `Commitment "${commitment.title}" (${commitment.ref}) reads as strategic/discussion-only with no accepted-deliverable evidence.`
      });
    } else if (looksStrategic) {
      notes.push(
        `Commitment "${commitment.title}" (${commitment.ref}) mentions patterns/loops but has accepted-deliverable evidence; allowed.`
      );
    }
  }

  const chatterCommitment = matchedCommitments.get("Validate/pilot Chatter using real Parfait meeting context");
  if (chatterCommitment) {
    notes.push(`Chatter commitment has ${chatterCommitment.tasks.length} child task(s) after consolidation.`);
    if (chatterCommitment.tasks.length > 8) {
      failures.push({
        rule: "chatter_tasks_consolidated",
        detail: `Chatter commitment has ${chatterCommitment.tasks.length} child tasks -- looks unconsolidated (expected roughly 4 independently completable steps).`
      });
    }
  }

  const childRefs = new Set(tree.commitments.flatMap((commitment) => commitment.tasks.map((task) => task.ref)));
  const standaloneRefs = new Set(tree.standalone_tasks.map((task) => task.ref));
  for (const ref of childRefs) {
    if (standaloneRefs.has(ref)) {
      failures.push({
        rule: "no_child_also_standalone",
        detail: `Task ${ref} appears as both a child task and a standalone task.`
      });
    }
  }

  const vercelCommitment = matchedCommitments.get("Deliver Parfait before next Tuesday");
  if (vercelCommitment && vercelCommitment.group_basis === "explicit_deliverable" && vercelCommitment.tasks.length === 0) {
    failures.push({
      rule: "vercel_commitment_not_emptied",
      detail: "The Vercel/Parfait deployment commitment lost its only child task."
    });
  }

  for (const item of allActiveItems(tree)) {
    if (PERSONAL_LOGISTICS_PATTERNS.some((pattern) => pattern.test(item.title))) {
      failures.push({
        rule: "no_personal_logistics",
        detail: `"${item.title}" (${item.ref}) reads as personal logistics, not project execution.`
      });
    }
    if (COMPLETED_WORK_PATTERNS.some((pattern) => pattern.test(item.title))) {
      failures.push({
        rule: "no_completed_work_as_pending",
        detail: `"${item.title}" (${item.ref}) reads as already-completed work, not a pending item.`
      });
    }
  }

  return { ok: failures.length === 0, failures, notes };
}

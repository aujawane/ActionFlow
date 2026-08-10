import type { ExecutionTree, WorkItem } from "../work-item-schemas";
import type { GateFailure, GateResult } from "./chatter-gate";

export type { GateFailure, GateResult } from "./chatter-gate";

const PEER_COMPONENT_PATTERNS = [
  /\bdomain\b/i,
  /\bfaq\b/i,
  /founder'?s? story/i,
  /\bimages?\b/i,
  /\bplaceholders?\b/i,
  /ingredients?|packaging/i
];

const FUTURE_SCOPE_TOPIC_PATTERNS = [
  /checkout/i,
  /\border(ing|s)?\b.*(management|system)?/i,
  /\blogin\b|\bsign ?up\b/i,
  /customer accounts?/i,
  /recurring (product )?subscriptions?/i,
  /subscription[- ]management/i,
  /chatbot/i,
  /instagram/i,
  /full e-?commerce|e-?commerce checkout/i
];

const UNSUPPORTED_EMAIL_MIGRATION_PATTERNS = [/email/i, /migrat/i];
const EXACT_FORBIDDEN_TASK_TITLES = [/^use an ?e-?commerce website\.?$/i];

function allActiveItems(tree: ExecutionTree) {
  const items: Array<{ ref: string; title: string; owner: string | null }> = [];
  for (const commitment of tree.commitments) {
    items.push({ ref: commitment.ref, title: commitment.title, owner: commitment.owner });
    for (const task of commitment.tasks) items.push({ ref: task.ref, title: task.title, owner: task.owner });
  }
  for (const task of tree.standalone_tasks) items.push({ ref: task.ref, title: task.title, owner: task.owner });
  return items;
}

/**
 * Hard go/no-go assertions for the real "Meeting with Jamleh" website benchmark (project
 * "Jamileh's Product Website", goal "Deliver Informational Website First Release"). Mirrors
 * `chatter-gate.ts`'s style: concrete structural/content checks pulled directly from the
 * transcript's actual content and the later "informational site first, e-commerce later"
 * sequencing statement, not a fuzzy scoring metric.
 */
export function evaluateWebsiteGate(input: {
  tree: ExecutionTree;
  futureScopeItems: WorkItem[];
  excludedWorkItems: Array<WorkItem & { exclusion_reason: string | null }>;
}): GateResult {
  const { tree } = input;
  const failures: GateFailure[] = [];
  const notes: string[] = [];

  if (tree.commitments.length !== 1) {
    failures.push({
      rule: "one_primary_commitment",
      detail: `Expected exactly one active commitment, found ${tree.commitments.length}: ${tree.commitments
        .map((c) => c.title)
        .join(", ") || "(none)"}.`
    });
  }
  const commitment = tree.commitments[0];

  if (commitment) {
    if (!commitment.owner || !/aditya/i.test(commitment.owner)) {
      failures.push({
        rule: "primary_owner_aditya",
        detail: `Website commitment owner is "${commitment.owner ?? "null"}", expected Aditya.`
      });
    }
    if (commitment.owner?.trim().toLowerCase() === "team") {
      failures.push({ rule: "owner_not_team", detail: 'Commitment owner is the literal string "Team".' });
    }

    const jamilehTasks = commitment.tasks.filter((task) => task.owner && /jamileh/i.test(task.owner));
    if (jamilehTasks.length === 0) {
      failures.push({
        rule: "jamileh_child_tasks_present",
        detail: "No child task under the website commitment is owned by Jamileh."
      });
    }
    const jamilehNotAction = jamilehTasks.filter(
      (task) => task.work_item_role !== "action" && task.work_item_role !== "input_dependency"
    );
    for (const task of jamilehNotAction) {
      failures.push({
        rule: "jamileh_inputs_are_tasks_not_criteria",
        detail: `Jamileh's "${task.title}" (${task.ref}) is role=${task.work_item_role}, expected action or input_dependency.`
      });
    }

    if (commitment.acceptance_criteria.length === 0) {
      failures.push({
        rule: "acceptance_criteria_present",
        detail: "Website commitment has zero acceptance criteria; requirements should be attached, not dropped."
      });
    }
  }

  for (const other of tree.commitments) {
    if (commitment && other.ref === commitment.ref) continue;
    for (const pattern of PEER_COMPONENT_PATTERNS) {
      if (pattern.test(other.title) || (other.description && pattern.test(other.description))) {
        failures.push({
          rule: "no_peer_commitment_for_component",
          detail: `"${other.title}" (${other.ref}) reads as a component of the website deliverable, not its own commitment.`
        });
        break;
      }
    }
  }

  const activeItems = allActiveItems(tree);
  for (const item of activeItems) {
    for (const pattern of FUTURE_SCOPE_TOPIC_PATTERNS) {
      if (pattern.test(item.title)) {
        failures.push({
          rule: "future_scope_not_active",
          detail: `"${item.title}" (${item.ref}) is a future-scope feature (e-commerce/accounts/subscriptions/chatbot/Instagram) but appears in the active tree.`
        });
        break;
      }
    }
    if (EXACT_FORBIDDEN_TASK_TITLES.some((pattern) => pattern.test(item.title.trim()))) {
      failures.push({
        rule: "no_use_an_ecommerce_website_task",
        detail: `"${item.title}" (${item.ref}) is exactly the forbidden manufactured task title.`
      });
    }
    if (UNSUPPORTED_EMAIL_MIGRATION_PATTERNS.every((pattern) => pattern.test(item.title))) {
      failures.push({
        rule: "no_unsupported_email_migration",
        detail: `"${item.title}" (${item.ref}) proposes an email migration with no support for it in scope.`
      });
    }
  }

  const dismissedHistoricalPattern = /full e-?commerce|checkout|subscription/i;
  for (const item of activeItems) {
    if (dismissedHistoricalPattern.test(item.title)) {
      notes.push(`"${item.title}" (${item.ref}) mentions historically-dismissed e-commerce scope; verify it is legitimately in-scope, not a stale artifact.`);
    }
  }

  if (tree.standalone_tasks.length > 0) {
    notes.push(
      `${tree.standalone_tasks.length} standalone task(s) present: ${tree.standalone_tasks.map((t) => t.title).join(", ")}. Zero is valid and expected for this meeting -- verify none were manufactured merely to populate the section.`
    );
  }

  return { ok: failures.length === 0, failures, notes };
}

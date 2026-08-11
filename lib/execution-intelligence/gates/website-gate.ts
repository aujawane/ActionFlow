import type { ExecutionTree, WorkItem } from "../work-item-schemas";
import type { GateFailure, GateResult } from "./chatter-gate";

export type { GateFailure, GateResult } from "./chatter-gate";

const PEER_COMPONENT_PATTERNS = [
  /\bdomain\b/i,
  /\bfaq\b/i,
  /founder'?s? story/i,
  /\bimages?\b/i,
  /\bplaceholders?\b/i,
  /ingredients?|packaging/i,
  // A narrower or broader restatement of the same "first release/first draft" deliverable is a
  // duplicate, not a distinct peer commitment (see work-item-prompts.ts's "ONE DELIVERABLE, ONE
  // ANCHOR" rule).
  /informational.*(first release|release)|first release/i,
  // "Which product variants to offer" / "market-test" is scope/acceptance-criteria territory,
  // never its own commitment, unless a genuinely separate accepted deliverable exists.
  /(develop|market-test|market test).*product lines?|product lines?.*(develop|market-test|market test)/i
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

// A future-scope word appearing alongside a deferral cue ("before the e-commerce piece is done",
// "e-commerce remains later scope") is the CORRECT way to describe the "informational site first,
// e-commerce later" sequencing -- not a leak. Only flag when the topic is mentioned with no such
// cue in the SAME sentence/clause -- an unrelated deferral cue elsewhere in the text (e.g. a due
// date like "before August 1") must not blanket-suppress a genuine leak in a different sentence.
const DEFERRAL_CUE_PATTERN = /\b(before|until|later|remain|future scope|not yet|afterward|after)\b/i;

function clauses(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((clause) => clause.trim().length > 0);
}

function hasUnsuppressedFutureScopeMatch(text: string, pattern: RegExp): boolean {
  return clauses(text).some((clause) => pattern.test(clause) && !DEFERRAL_CUE_PATTERN.test(clause));
}

// Requires "email" plus a service/infrastructure signal -- broad enough to catch "link existing
// domain and email to the deployment" (no literal "migrat[e|ion]") without flagging a legitimate
// communication action like "email Jamileh the FAQ answers".
const UNSUPPORTED_EMAIL_MIGRATION_PATTERNS = [/email/i, /domain|deploy|migrat|hosting|host\b|service|setup/i];
const EXACT_FORBIDDEN_TASK_TITLES = [/^use an ?e-?commerce website\.?$/i];

function allActiveItems(tree: ExecutionTree) {
  const items: Array<{ ref: string; title: string; description: string | null; owner: string | null }> = [];
  for (const commitment of tree.commitments) {
    items.push({
      ref: commitment.ref,
      title: commitment.title,
      description: commitment.description,
      owner: commitment.owner
    });
    for (const task of commitment.tasks) {
      items.push({ ref: task.ref, title: task.title, description: task.description, owner: task.owner });
    }
  }
  for (const task of tree.standalone_tasks) {
    items.push({ ref: task.ref, title: task.title, description: task.description, owner: task.owner });
  }
  return items;
}

function itemText(item: { title: string; description: string | null }) {
  // Joined with ". " (not a bare space) so title and description are always distinct clauses for
  // hasUnsuppressedFutureScopeMatch's sentence-level check, regardless of whether either already
  // ends in punctuation -- an unrelated deferral cue in the title (e.g. a due date) must never
  // suppress a genuine future-scope leak stated in the description, or vice versa.
  return item.description ? `${item.title}. ${item.description}` : item.title;
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
    const text = itemText(item);
    for (const pattern of FUTURE_SCOPE_TOPIC_PATTERNS) {
      if (hasUnsuppressedFutureScopeMatch(text, pattern)) {
        failures.push({
          rule: "future_scope_not_active",
          detail: `"${item.title}" (${item.ref}) is a future-scope feature (e-commerce/accounts/subscriptions/chatbot/Instagram) but appears in the active tree (title or description) with no deferral language.`
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
    if (UNSUPPORTED_EMAIL_MIGRATION_PATTERNS.every((pattern) => pattern.test(text))) {
      failures.push({
        rule: "no_unsupported_email_migration",
        detail: `"${item.title}" (${item.ref}) proposes email hosting/service/migration work with no support for it in scope.`
      });
    }
  }

  const dismissedHistoricalPattern = /full e-?commerce|checkout|subscription/i;
  for (const item of activeItems) {
    if (dismissedHistoricalPattern.test(itemText(item))) {
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

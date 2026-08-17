import { computeReplacedOwners, deriveSupportingPeople } from "@/lib/commitment-people";
import type { CommitmentCorrectionChange } from "@/lib/commitment-correction/schema";
import { isSameOwnerValue } from "@/lib/owner-utils";
import type { MeetingCommitment } from "@/lib/types";

const PRIORITY_VALUES = new Set(["low", "medium", "high"]);
const STATUS_VALUES = new Set(["pending", "in_progress", "completed", "dismissed", "blocked"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UNASSIGNED_TOKEN = "unassigned";

export type ValidatedChangeSummary = { field: string; from: string; to: string };

export type ValidateChangesResult =
  | { ok: true; patch: Record<string, unknown>; summaries: ValidatedChangeSummary[] }
  | { ok: false; error: string };

function isRealCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  // Date silently rolls invalid days/months forward (e.g. Feb 30 -> Mar 2) -- round-trip the
  // parsed date back to the same string to catch that instead of persisting a nonsense date.
  return date.toISOString().slice(0, 10) === value;
}

/** Resolves a model-proposed person string against the REAL, server-loaded participant list --
 * never the client-echoed one. Returns null (reject) if it isn't an exact case/whitespace-
 * insensitive match to exactly one participant (or the literal "Unassigned"). This is the
 * defense-in-depth layer: the prompt asks the model to only ever emit exact participant names or
 * ask a clarifying question when ambiguous, but a hallucinated or slightly-misspelled name must
 * never silently reach the database regardless of what the model claimed. */
function resolveParticipant(value: string, participantOptions: string[]): string | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === UNASSIGNED_TOKEN) return null;
  const match = participantOptions.find((option) => option.trim().toLowerCase() === trimmed.toLowerCase());
  return match ?? undefined;
}

/** Server-side allowlist enforcement + no-op detection + patch assembly. Every value here is
 * validated against the FRESH commitment/participant state passed in by the caller (never trust
 * a client-echoed current_value or a client-supplied participant list) -- this is the one place
 * that decides what is actually allowed to reach the database, independent of whatever the model
 * or a client claims. A single bad change rejects the entire batch (the user asked to apply N
 * changes together; silently dropping one without telling them is worse than asking them to
 * retry) -- no-op changes are filtered out quietly instead, and only fail the batch if every
 * change in it turns out to be a no-op. */
export function validateCommitmentCorrectionChanges(
  changes: CommitmentCorrectionChange[],
  context: { commitment: MeetingCommitment; participantOptions: string[] }
): ValidateChangesResult {
  if (changes.length === 0) {
    return { ok: false, error: "No changes to apply." };
  }

  const currentOwner = context.commitment.lead_owner_name ?? context.commitment.owner ?? null;
  const currentSupportingPeople = deriveSupportingPeople(context.commitment.owners, currentOwner);

  const patch: Record<string, unknown> = {};
  const summaries: ValidatedChangeSummary[] = [];

  for (const change of changes) {
    const proposed = change.proposed_value.trim();

    switch (change.field) {
      case "title": {
        if (!proposed) return { ok: false, error: "A corrected title cannot be empty." };
        if (proposed === context.commitment.title) break;
        patch.title = proposed;
        summaries.push({ field: "Title", from: context.commitment.title, to: proposed });
        break;
      }

      case "description": {
        if (!proposed) return { ok: false, error: "A corrected description cannot be empty." };
        if (proposed === (context.commitment.description ?? "")) break;
        patch.description = proposed;
        summaries.push({
          field: "Description",
          from: context.commitment.description ?? "(none)",
          to: proposed
        });
        break;
      }

      case "owner": {
        const resolved = resolveParticipant(proposed, context.participantOptions);
        if (resolved === undefined) {
          return {
            ok: false,
            error: `"${proposed}" doesn't match anyone in this meeting. Choose an exact participant name.`
          };
        }
        if (isSameOwnerValue(resolved, currentOwner)) break;
        patch.lead_owner_name = resolved;
        summaries.push({
          field: "Owner",
          from: currentOwner?.trim() || "Unassigned",
          to: resolved?.trim() || "Unassigned"
        });
        break;
      }

      case "supporting_person": {
        if (currentSupportingPeople.length === 0) {
          return { ok: false, error: "This commitment has no supporting people to replace." };
        }
        const from = change.supporting_person_from?.trim();
        const fromMatch = from
          ? currentSupportingPeople.find((name) => isSameOwnerValue(name, from))
          : undefined;
        if (!fromMatch) {
          return {
            ok: false,
            error: "Couldn't tell which supporting person to replace -- please name them specifically."
          };
        }
        const resolved = resolveParticipant(proposed, context.participantOptions);
        if (resolved === undefined || resolved === null) {
          return {
            ok: false,
            error: `"${proposed}" doesn't match anyone in this meeting. Choose an exact participant name.`
          };
        }
        if (isSameOwnerValue(resolved, fromMatch)) break;
        // Owners is a shared, whole-array field -- if a previous change in this same batch
        // already touched it (shouldn't happen per the prompt, but never trust that), keep
        // replacing from the latest patch state rather than the pre-batch commitment.
        const baseOwners = "owners" in patch ? patch.owners : context.commitment.owners;
        patch.owners = computeReplacedOwners(baseOwners, fromMatch, resolved);
        summaries.push({ field: "Supporting", from: fromMatch, to: resolved });
        break;
      }

      case "due_date": {
        if (!isRealCalendarDate(proposed)) {
          return { ok: false, error: `"${change.proposed_value}" isn't a valid resolved date.` };
        }
        if (proposed === context.commitment.due_date) break;
        patch.due_date = proposed;
        summaries.push({
          field: "Due date",
          from: context.commitment.due_date ?? "(none)",
          to: proposed
        });
        break;
      }

      case "priority": {
        const normalized = proposed.toLowerCase();
        if (!PRIORITY_VALUES.has(normalized)) {
          return { ok: false, error: `Priority must be low, medium, or high (got "${proposed}").` };
        }
        if (normalized === context.commitment.priority) break;
        patch.priority = normalized;
        summaries.push({ field: "Priority", from: context.commitment.priority, to: normalized });
        break;
      }

      case "status": {
        const normalized = proposed.toLowerCase();
        if (!STATUS_VALUES.has(normalized)) {
          return {
            ok: false,
            error: `Status must be pending, in progress, completed, dismissed, or blocked (got "${proposed}").`
          };
        }
        if (normalized === context.commitment.status) break;
        patch.status = normalized;
        summaries.push({ field: "Status", from: context.commitment.status, to: normalized });
        break;
      }

      default:
        // Unreachable given the zod enum, kept as a defense-in-depth guard -- the model must
        // never be able to reach an unsupported field simply because it passed JSON parsing.
        return { ok: false, error: "Unsupported field." };
    }
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "No changes to apply." };
  }

  return { ok: true, patch, summaries };
}

import { isSameOwnerValue } from "@/lib/owner-utils";
import { stringArray } from "@/lib/project-execution";

/** commitment.owners is a JSON array that may redundantly include the primary owner alongside
 * genuine supporting people, and extraction can occasionally repeat a name -- dedupe
 * case/whitespace-insensitively so the same person never appears as two selectable/reportable
 * entries. Shared between the (removed) structured supporting-person picker and the AI
 * correction assistant's server-side validator, so both agree on what "the supporting people"
 * list means for a given commitment. */
export function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(name.trim());
  }
  return result;
}

/** Replaces exactly one matched entry in a commitment's owners array, leaving every other entry
 * (including the primary owner, if it happens to also appear in this array) untouched -- a safe,
 * targeted correction rather than a blind whole-array overwrite. */
export function computeReplacedOwners(
  owners: unknown,
  personToReplace: string,
  replacementPerson: string
): string[] {
  return stringArray(owners).map((name) =>
    isSameOwnerValue(name, personToReplace) ? replacementPerson : name
  );
}

/** commitment.owners minus whichever name is the current owner -- the canonical "supporting
 * people" list (matches commitments-panel.tsx's own display rule), deduped. */
export function deriveSupportingPeople(owners: unknown, currentOwner: string | null): string[] {
  return dedupeNames(stringArray(owners).filter((name) => !isSameOwnerValue(name, currentOwner)));
}

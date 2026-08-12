"use client";

const UNASSIGNED_VALUE = "";

export type TaskOwnerSelectOption = { value: string; label: string };

export type TaskOwnerSelectState =
  | { mode: "empty" }
  | { mode: "select"; selectedValue: string; options: TaskOwnerSelectOption[] };

/** Pure decision logic behind the owner dropdown, exported separately so it can be unit tested
 * without a DOM/React-rendering harness (this repo has neither). If the task's current owner
 * isn't among the resolved meeting participants (e.g. set before Speaker Mapping resolved
 * identities), it is kept as its own selected option rather than silently discarded -- clearly
 * labeled as not a resolved meeting participant -- so opening the dropdown never rewrites
 * ownership on its own. */
export function resolveTaskOwnerSelectState(
  ownerValue: string | null,
  participantOptions: string[]
): TaskOwnerSelectState {
  const trimmedOwner = ownerValue?.trim() || null;
  const ownerInOptions = trimmedOwner
    ? participantOptions.some((option) => option.toLowerCase() === trimmedOwner.toLowerCase())
    : true;

  if (participantOptions.length === 0 && !trimmedOwner) {
    return { mode: "empty" };
  }

  const options: TaskOwnerSelectOption[] = [
    { value: UNASSIGNED_VALUE, label: "Unassigned" },
    ...(!ownerInOptions && trimmedOwner
      ? [{ value: trimmedOwner, label: `${trimmedOwner} (current — not in this meeting)` }]
      : []),
    ...participantOptions.map((name) => ({ value: name, label: name }))
  ];

  return { mode: "select", selectedValue: trimmedOwner ?? UNASSIGNED_VALUE, options };
}

/** The model's canonical "no owner" representation is null, never the literal string
 * "Unassigned" -- the empty-string option value maps back to that here. */
export function ownerSelectValueToOwner(value: string): string | null {
  return value || null;
}

/** Shared owner-assignment control for a task, used by both Commitment Workspace and Task
 * Workspace. Replaces free-text owner entry with a dropdown of this task's source meeting's
 * resolved participants (see lib/meeting-participants.ts) -- selecting a name commits
 * immediately, there is no per-keystroke state to lose focus over. */
export function TaskOwnerSelect({
  ownerValue,
  options,
  onCommit,
  ariaLabel,
  disabled,
  className = "inline-edit-field"
}: {
  ownerValue: string | null;
  options: string[];
  onCommit: (value: string | null) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const state = resolveTaskOwnerSelectState(ownerValue, options);

  if (state.mode === "empty") {
    return (
      <select className={className} aria-label={ariaLabel} value="" disabled>
        <option value="">No meeting participants available</option>
      </select>
    );
  }

  return (
    <select
      className={className}
      aria-label={ariaLabel}
      value={state.selectedValue}
      disabled={disabled}
      onChange={(event) => onCommit(ownerSelectValueToOwner(event.target.value))}
    >
      {state.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

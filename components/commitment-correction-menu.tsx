"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { ActionMenu } from "@/components/action-menu";
import { EntityCorrectionAssistant } from "@/components/entity-correction-assistant";
import { Modal, ModalActions } from "@/components/modal";
import { isCommittedWork } from "@/lib/execution-display";
import type { MeetingCommitment, TaskDependency } from "@/lib/types";

type DialogKind =
  | "future_scope"
  | "promote"
  | "evidence"
  | "correction"
  | "reevaluate_dependencies"
  | null;

/** Commitment counterpart to TaskCorrectionMenu. hasActiveChildren lets the caller (which
 * usually already has the commitment's task list in scope -- Commitment Workspace, Meeting
 * Detail's CommitmentsPanel) hide "Move to Future Scope" up front when it would strand active
 * child tasks; the server independently re-checks the same rule (see
 * /api/commitments/[id]/classification), so this is a UX nicety, not the safety boundary.
 *
 * "Correct with Parfait" replaced the old option-heavy "Report incorrect extraction" form (radio
 * reasons + a structured owner/supporting-person picker) with a conversational correction
 * assistant -- see components/entity-correction-assistant.tsx and lib/commitment-correction/*.
 * It no longer needs a meetingParticipantOptions prop (every call site updated) -- the correction
 * assistant resolves participants itself, server-side, from fresh data on every turn. */
export function CommitmentCorrectionMenu({
  commitment,
  hasActiveChildren = false,
  onCommitmentUpdated,
  onDependenciesRefreshed
}: {
  commitment: MeetingCommitment;
  hasActiveChildren?: boolean;
  onCommitmentUpdated: (commitment: MeetingCommitment) => void;
  /** AI dependency inference is quiet, secondary utility (see "Re-evaluate dependencies" below),
   * not shown at all when the caller has no dependency list to refresh. */
  onDependenciesRefreshed?: (dependencies: TaskDependency[]) => void;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reevaluateSummary, setReevaluateSummary] = useState<string | null>(null);

  function closeDialog() {
    setDialog(null);
    setError(null);
    setBusy(false);
    setReevaluateSummary(null);
  }

  async function submitClassification(next: "committed" | "future_consideration") {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/commitments/${commitment.id}/classification`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_classification: next })
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok || !result.commitment) {
      setError(result.error || "Failed to update this commitment.");
      return;
    }
    onCommitmentUpdated(result.commitment as MeetingCommitment);
    router.refresh();
    closeDialog();
  }

  async function submitReevaluateDependencies() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/commitments/${commitment.id}/dependencies/infer`, {
      method: "POST"
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setError(result.error || "Failed to re-evaluate dependencies.");
      return;
    }
    const accepted = result.diagnostics?.acceptedEdgeCount ?? 0;
    setReevaluateSummary(
      accepted === 0
        ? "No confident dependency relationships were found."
        : `${accepted} dependency relationship${accepted === 1 ? "" : "s"} applied.`
    );
    if (result.dependencies) {
      onDependenciesRefreshed?.(result.dependencies as TaskDependency[]);
    }
    router.refresh();
  }

  const isActive = isCommittedWork(commitment);
  const items = [
    isActive && !hasActiveChildren
      ? { label: "Move to Future Scope", onSelect: () => setDialog("future_scope") }
      : null,
    !isActive ? { label: "Promote to active work", onSelect: () => setDialog("promote") } : null,
    commitment.source_quote
      ? { label: "View source evidence", onSelect: () => setDialog("evidence") }
      : null,
    // Quiet, secondary utility -- intentional re-run for after restructuring work, not a
    // primary CTA. Only meaningful for active commitments (Future Scope work never gets AI
    // dependency inference -- see final report section 22).
    isActive && onDependenciesRefreshed
      ? { label: "Re-evaluate dependencies", onSelect: () => setDialog("reevaluate_dependencies") }
      : null,
    { label: "Correct with Parfait", onSelect: () => setDialog("correction") }
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <>
      <ActionMenu label={`More actions for ${commitment.title}`} items={items} />

      <Modal open={dialog === "future_scope"} title="Move to Future Scope?" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Move to Future Scope?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          This commitment will no longer count as active execution work or appear in Active
          Commitments. You can promote it back to active at any time.
        </p>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submitClassification("future_consideration")}
            disabled={busy}
            className="premium-button px-4 py-2 text-sm"
          >
            {busy ? "Working…" : "Move to Future Scope"}
          </button>
        </ModalActions>
      </Modal>

      <Modal open={dialog === "promote"} title="Promote to active work?" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Promote to active work?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          This will become an active commitment, counted toward Active Commitments and progress.
        </p>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submitClassification("committed")}
            disabled={busy}
            className="premium-button px-4 py-2 text-sm"
          >
            {busy ? "Working…" : "Promote to active work"}
          </button>
        </ModalActions>
      </Modal>

      <Modal
        open={dialog === "reevaluate_dependencies"}
        title="Re-evaluate dependencies?"
        onClose={closeDialog}
      >
        <h2 className="text-base font-semibold text-slate-950">Re-evaluate dependencies?</h2>
        {reevaluateSummary ? (
          <>
            <p className="mt-2 text-sm leading-6 text-slate-600">{reevaluateSummary}</p>
            <ModalActions>
              <button
                type="button"
                onClick={closeDialog}
                className="secondary-button px-4 py-2 text-sm"
              >
                Close
              </button>
            </ModalActions>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Parfait will re-analyze this commitment&apos;s tasks and update AI-inferred
              dependencies. Dependencies you&apos;ve set or changed yourself are never
              overwritten.
            </p>
            {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
            <ModalActions>
              <button
                type="button"
                onClick={closeDialog}
                className="tertiary-button px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitReevaluateDependencies()}
                disabled={busy}
                className="premium-button px-4 py-2 text-sm"
              >
                {busy ? "Re-evaluating…" : "Re-evaluate dependencies"}
              </button>
            </ModalActions>
          </>
        )}
      </Modal>

      <Modal open={dialog === "evidence"} title="Source evidence" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Source evidence</h2>
        <p className="mt-1 text-xs text-slate-500">Why Parfait created this commitment.</p>
        {commitment.source_quote ? (
          <blockquote className="mt-3 border-l-2 border-brand-200 pl-3 text-sm italic leading-6 text-slate-600">
            &ldquo;{commitment.source_quote}&rdquo;
          </blockquote>
        ) : (
          <p className="mt-3 text-sm text-slate-500">No source quote was captured.</p>
        )}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="secondary-button px-4 py-2 text-sm">
            Close
          </button>
        </ModalActions>
      </Modal>

      <Modal open={dialog === "correction"} title="Correct with Parfait" onClose={closeDialog}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Correct with Parfait</h2>
            <p className="mt-1 truncate text-xs text-slate-500">{commitment.title}</p>
          </div>
        </div>
        <div className="mt-3">
          <EntityCorrectionAssistant
            entityType="commitment"
            entityId={commitment.id}
            onApplied={(updated) => {
              onCommitmentUpdated(updated as MeetingCommitment);
              router.refresh();
            }}
          />
        </div>
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Done
          </button>
        </ModalActions>
      </Modal>
    </>
  );
}

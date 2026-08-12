"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { ActionMenu } from "@/components/action-menu";
import { Modal, ModalActions } from "@/components/modal";
import { isCommittedWork } from "@/lib/execution-display";
import type { MeetingCommitment } from "@/lib/types";

const REPORT_REASONS: Array<{ value: string; label: string }> = [
  { value: "wrong_owner", label: "Wrong owner" },
  { value: "wrong_classification", label: "Wrong classification" },
  { value: "duplicate", label: "Duplicate" },
  { value: "missing_context", label: "Missing/incorrect context" },
  { value: "not_execution_work", label: "Should not be execution work" },
  { value: "other", label: "Other" }
];

type DialogKind = "future_scope" | "promote" | "evidence" | "report" | null;

/** Commitment counterpart to TaskCorrectionMenu. hasActiveChildren lets the caller (which
 * usually already has the commitment's task list in scope -- Commitment Workspace, Meeting
 * Detail's CommitmentsPanel) hide "Move to Future Scope" up front when it would strand active
 * child tasks; the server independently re-checks the same rule (see
 * /api/commitments/[id]/classification), so this is a UX nicety, not the safety boundary. */
export function CommitmentCorrectionMenu({
  commitment,
  hasActiveChildren = false,
  onCommitmentUpdated
}: {
  commitment: MeetingCommitment;
  hasActiveChildren?: boolean;
  onCommitmentUpdated: (commitment: MeetingCommitment) => void;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("wrong_owner");
  const [reportNote, setReportNote] = useState("");
  const [reportSubmitted, setReportSubmitted] = useState(false);

  function closeDialog() {
    setDialog(null);
    setError(null);
    setBusy(false);
    setReportSubmitted(false);
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

  async function submitReport() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/commitments/${commitment.id}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reportReason, note: reportNote.trim() || undefined })
    });
    setBusy(false);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setError(result.error || "Failed to send report.");
      return;
    }
    setReportSubmitted(true);
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
    {
      label: "Report incorrect extraction",
      onSelect: () => setDialog("report"),
      variant: "destructive" as const
    }
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

      <Modal open={dialog === "report"} title="Report incorrect extraction" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Report incorrect extraction</h2>
        {reportSubmitted ? (
          <>
            <p className="mt-3 text-sm text-slate-600">
              Thanks -- this was recorded on the commitment&apos;s history.
            </p>
            <ModalActions>
              <button type="button" onClick={closeDialog} className="secondary-button px-4 py-2 text-sm">
                Close
              </button>
            </ModalActions>
          </>
        ) : (
          <>
            <fieldset className="mt-3 space-y-1.5">
              <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                What&apos;s wrong?
              </legend>
              {REPORT_REASONS.map((reason) => (
                <label key={reason.value} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="commitment-report-reason"
                    value={reason.value}
                    checked={reportReason === reason.value}
                    onChange={() => setReportReason(reason.value)}
                    className="accent-brand-600"
                  />
                  {reason.label}
                </label>
              ))}
            </fieldset>
            <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Note (optional)
              <textarea
                className="premium-input mt-2 min-h-16"
                value={reportNote}
                maxLength={1000}
                onChange={(event) => setReportNote(event.target.value)}
                placeholder="Anything that would help explain the issue"
              />
            </label>
            {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
            <ModalActions>
              <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={submitReport}
                disabled={busy}
                className="premium-button px-4 py-2 text-sm"
              >
                {busy ? "Sending…" : "Send report"}
              </button>
            </ModalActions>
          </>
        )}
      </Modal>
    </>
  );
}

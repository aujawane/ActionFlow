import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isSameOwnerValue } from "../lib/owner-utils";

// ============================================================
// 22. The one-character textarea bug -- root cause and fix.
//
// Root cause: Modal's focus-management useEffect depended on `[open, onClose]`. `onClose` was
// bound to an unmemoized `closeDialog` function declared fresh in every render of
// TaskCorrectionMenu/CommitmentCorrectionMenu, so typing one character into the Note textarea
// (setReportNote -> re-render -> new closeDialog reference) made React treat `onClose` as a
// changed dependency, tearing down and re-running the effect on every keystroke. The cleanup
// function called `previouslyFocused.current?.focus()`, yanking focus off the textarea back onto
// whatever had focus before the dialog originally opened.
//
// Fix (components/modal.tsx): read onClose through a ref that is updated every render but never
// listed as an effect dependency, so the effect now only depends on `open` and never tears down
// mid-typing. This is a single-file fix at the true source of the bug, not a per-textarea
// `.focus()` hack, and it protects every dialog in both correction menus (not just the report
// dialog), since all of them share this same onClose-identity-instability pattern.
//
// No DOM/RTL harness exists in this repo (see task-owner-select.test.ts's own note on this), so
// this is asserted at the source level, consistent with the rest of the suite. Manually verified
// in-browser: clicking the Note textarea once and typing a full sentence no longer loses focus
// after each character.
// ============================================================

test("Modal: the focus-management effect no longer depends on `onClose` (the actual cause of the per-keystroke focus loss)", async () => {
  const source = await readFile(new URL("../components/modal.tsx", import.meta.url), "utf8");
  const effectBlock = source.slice(source.indexOf("useEffect(() => {"), source.indexOf("if (!open) return null;"));
  assert.match(effectBlock, /\}, \[open\]\);/);
  assert.doesNotMatch(effectBlock, /\}, \[open, onClose\]\);/);
});

test("Modal: onClose is read through a ref inside the effect, not captured directly, so a new onClose identity from the caller never tears the effect down mid-interaction", async () => {
  const source = await readFile(new URL("../components/modal.tsx", import.meta.url), "utf8");
  assert.match(source, /const onCloseRef = useRef\(onClose\);/);
  assert.match(source, /onCloseRef\.current = onClose;/);
  assert.match(source, /onCloseRef\.current\(\);/);
});

test("Modal: the fix is not the textarea-refocus hack the brief explicitly ruled out", async () => {
  const source = await readFile(new URL("../components/modal.tsx", import.meta.url), "utf8");
  const taskMenuSource = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  const commitmentMenuSource = await readFile(
    new URL("../components/commitment-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /textareaRef/);
  assert.doesNotMatch(taskMenuSource, /textareaRef/);
  assert.doesNotMatch(commitmentMenuSource, /textareaRef/);
});

test("task correction menu: the Note textarea remains a plain stable controlled component (no key, no remount trigger) -- the textarea itself was never the bug", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /value=\{reportNote\}/);
  assert.match(source, /onChange=\{\(event\) => setReportNote\(event\.target\.value\)\}/);
  // The Note label + textarea themselves carry no key prop (a key tied to changing state is
  // the other classic remount trigger) -- scoped to just that label/textarea pair, since the
  // radio-reason list above it legitimately uses `key={reason.value}` for its mapped items.
  const noteLabelIndex = source.indexOf("Note (optional)");
  const textareaEnd = source.indexOf("/>", source.indexOf("<textarea", noteLabelIndex));
  const noteBlock = source.slice(noteLabelIndex, textareaEnd);
  assert.doesNotMatch(noteBlock, /key=\{/);
});

test("entity correction assistant: the composer textarea is also a plain stable controlled component -- same discipline for the new chat UI", async () => {
  const source = await readFile(
    new URL("../components/entity-correction-assistant.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /value=\{input\}/);
  assert.doesNotMatch(source, /textareaRef/);
  const textareaBlock = source.slice(
    source.indexOf("<textarea"),
    source.indexOf("/>", source.indexOf("<textarea"))
  );
  assert.doesNotMatch(textareaBlock, /key=\{/);
});

// ============================================================
// isSameOwnerValue -- real, executable unit coverage (pure logic, no DOM needed).
// ============================================================

test("isSameOwnerValue: identical names are the same", () => {
  assert.equal(isSameOwnerValue("Aditya Ujawane", "Aditya Ujawane"), true);
});

test("isSameOwnerValue: case and surrounding whitespace differences are still the same owner", () => {
  assert.equal(isSameOwnerValue("aditya ujawane", "  Aditya Ujawane  "), true);
});

test("isSameOwnerValue: null and empty/whitespace-only strings are both canonical Unassigned", () => {
  assert.equal(isSameOwnerValue(null, null), true);
  assert.equal(isSameOwnerValue(null, "   "), true);
});

test("isSameOwnerValue: a genuinely different owner is different", () => {
  assert.equal(isSameOwnerValue("Francesca Todarello", "Aditya Ujawane"), false);
});

test("isSameOwnerValue: Unassigned vs a named owner is different", () => {
  assert.equal(isSameOwnerValue(null, "Aditya Ujawane"), false);
});

// ============================================================
// 23. Wrong owner correction -- task pathway.
// ============================================================

test("task correction menu: selecting Wrong owner reveals the corrected-owner section, built from the shared TaskOwnerSelect (not a second owner selector)", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /import \{ TaskOwnerSelect \} from "@\/components\/task-owner-select";/);
  assert.match(source, /import \{ isSameOwnerValue \} from "@\/lib\/owner-utils";/);
  assert.match(source, /reportReasonIsActionable \? \(/);
  assert.match(source, /<TaskOwnerSelect\s/);
  assert.match(source, /ariaLabel="Correct owner"/);
});

test("task correction menu: current owner is displayed, falling back to Unassigned", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /\{task\.owner\?\.trim\(\) \|\| "Unassigned"\}/);
});

test("task correction menu: meeting participant options are threaded in as a prop, not reconstructed inside the modal", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /meetingParticipantOptions = \[\]/);
  assert.match(source, /options=\{meetingParticipantOptions\}/);
});

test("task correction menu: the same owner reselected (or Unassigned reselected when already Unassigned) is rejected as a no-op", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /const ownerCorrectionChanged =\s*reportReasonIsActionable && !isSameOwnerValue\(correctedOwner, reportOwnerBaseline\);/
  );
  assert.match(source, /disabled=\{busy \|\| !canSubmitReport\}/);
});

test("task correction menu: applying the correction PATCHes the canonical task route (the same one TaskOwnerSelect already uses), not a bespoke owner endpoint", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /fetch\(`\/api\/tasks\/\$\{task\.id\}`, \{\s*method: "PATCH"/);
  assert.match(source, /body: JSON\.stringify\(\{ owner: correctedOwner \}\)/);
  assert.match(source, /onTaskUpdated\(ownerResult\.task as MeetingTask\)/);
  assert.doesNotMatch(source, /\/api\/tasks\/\$\{task\.id\}\/owner/);
});

test("task correction menu: the report is still sent (and note preserved) after an actionable correction", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /fetch\(`\/api\/tasks\/\$\{task\.id\}\/report`, \{\s*method: "POST"/
  );
  assert.match(source, /reason: reportReason, note: reportNote\.trim\(\) \|\| undefined/);
});

test("task correction menu: button copy is 'Apply correction' only when actionable, otherwise plain 'Send report'", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /"Apply correction"/);
  assert.match(source, /: "Send report"/);
});

test("task correction menu: a failed owner correction stops before sending the report and preserves form state (dialog stays open, reason/owner/note untouched)", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  const submitFn = source.slice(
    source.indexOf("async function submitReport()"),
    source.indexOf("const isActive = isCommittedWork(task);")
  );
  const failureBranch = submitFn.slice(
    submitFn.indexOf("if (!ownerResponse.ok || !ownerResult.task) {"),
    submitFn.indexOf("onTaskUpdated(ownerResult.task as MeetingTask);")
  );
  assert.match(failureBranch, /setError\(ownerResult\.error \|\| "Failed to apply the owner correction\."\);/);
  assert.match(failureBranch, /return;/);
  // The failure branch must not touch dialog/reason/note/owner state -- only busy and error.
  assert.doesNotMatch(failureBranch, /setDialog/);
  assert.doesNotMatch(failureBranch, /setReportReason/);
  assert.doesNotMatch(failureBranch, /setReportNote/);
  assert.doesNotMatch(failureBranch, /setCorrectedOwner/);
});

test("task correction menu: a report failure after a successful correction surfaces a partial-failure message rather than silently succeeding", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /ownerJustCorrected\s*\?\s*"Owner corrected, but the report could not be saved\. You can try sending it again\."/
  );
});

test("task correction menu: retrying after a report-only failure does not re-apply an already-successful owner correction", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /reportReasonIsActionable && ownerCorrectionChanged && !correctionApplied/
  );
});

// ============================================================
// Commitment "Wrong owner" correction is superseded by the "Correct with Parfait" chat
// assistant -- see tests/commitment-correction.test.ts for its coverage. The commitment PATCH
// route's owner/manual-override logic itself was extracted to lib/commitment-mutations.ts (both
// the general PATCH route and the correction assistant's apply endpoint now call it), so its
// coverage lives there too.
//
// Manual-override / reanalysis preservation for the TASK pathway remains intact and unchanged --
// the task PATCH route still marks provenance identically to every other Phase 6 correction.
// ============================================================

test("task PATCH route: owner corrections from the report modal still mark manual_override_fields/preserve_on_reanalysis and stay authorization-gated", async () => {
  const source = await readFile(new URL("../app/api/tasks/[id]/route.ts", import.meta.url), "utf8");
  assert.match(source, /getOwnedTask\(id, auth\.user\.id\)/);
  assert.match(source, /preserve_on_reanalysis: true/);
  assert.match(source, /mergeManualOverrideFields/);
});

// ============================================================
// 24. Report-only categories are unaffected -- no mutation is attempted for anything but
// wrong_owner (tasks) / wrong_owner + wrong_supporting_person (commitments) in this pass.
// ============================================================

test("task correction menu: only wrong_owner is actionable; every other reason stays report-only", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /const reportReasonIsActionable = reportReason === "wrong_owner";/);
});

test("task correction menu: the owner-correction PATCH is only ever reached when the reason is actionable and something actually changed", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /if \(reportReasonIsActionable && ownerCorrectionChanged && !correctionApplied\) \{/
  );
});

// ============================================================
// Note is preserved across a reason switch (no reset tied to reportReason) and across a failed
// submission -- neither path calls setReportNote outside the textarea's own onChange.
// ============================================================

test("task correction menu: switching report reason never resets the note (only the textarea's own onChange calls setReportNote)", async () => {
  const source = await readFile(
    new URL("../components/task-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  const setReportNoteCalls = source.match(/setReportNote\([^)]*\)/g) ?? [];
  assert.equal(setReportNoteCalls.length, 1);
  assert.match(setReportNoteCalls[0], /event\.target\.value/);
});

// ============================================================
// meetingParticipantOptions threading: every surface that still renders a TaskCorrectionMenu
// with report capability has a real (or explicitly empty-default) participant list available.
// CommitmentCorrectionMenu no longer takes this prop at all -- the "Correct with Parfait"
// assistant resolves participants itself, server-side (see tests/commitment-correction.test.ts).
// ============================================================

test("meeting participant options reach every TaskCorrectionMenu call site", async () => {
  const checks: Array<[string, RegExp]> = [
    ["../components/commitment-workspace.tsx", /<TaskCorrectionMenu[\s\S]{0,200}meetingParticipantOptions=\{meetingParticipantOptions\}/],
    ["../components/task-workspace-task-state.tsx", /<TaskCorrectionMenu[\s\S]{0,200}meetingParticipantOptions=\{meetingParticipantOptions\}/],
    ["../components/standalone-tasks-panel.tsx", /<TaskCorrectionMenu[\s\S]{0,200}meetingParticipantOptions=\{meetingParticipantOptions\}/],
    ["../components/ideas-requirements-panel.tsx", /<TaskCorrectionMenu[\s\S]{0,200}meetingParticipantOptions=\{meetingParticipantOptions\}/],
    ["../app/meetings/[id]/page.tsx", /<IdeasRequirementsPanel[\s\S]{0,200}meetingParticipantOptions=\{meetingParticipantOptions\}/]
  ];
  for (const [file, pattern] of checks) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, pattern, `${file} did not match ${pattern}`);
  }
});

test("commitment correction menu no longer accepts meetingParticipantOptions -- the correction assistant resolves participants server-side instead", async () => {
  const source = await readFile(
    new URL("../components/commitment-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  const propsBlock = source.slice(
    source.indexOf("export function CommitmentCorrectionMenu({"),
    source.indexOf("const router = useRouter();")
  );
  assert.doesNotMatch(propsBlock, /meetingParticipantOptions/);
});

// ============================================================
// Report persistence itself is unchanged -- same table, same metadata shape, same auth chain.
// ============================================================

test("report routes: unchanged storage shape (task_comments/commitment_comments, role system, extraction_report metadata) and still authorization-gated", async () => {
  const taskReport = await readFile(
    new URL("../app/api/tasks/[id]/report/route.ts", import.meta.url),
    "utf8"
  );
  const commitmentReport = await readFile(
    new URL("../app/api/commitments/[id]/report/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(taskReport, /getOwnedTask\(id, auth\.user\.id\)/);
  assert.match(taskReport, /kind: "extraction_report"/);
  assert.match(commitmentReport, /getOwnedCommitment\(id, auth\.user\.id\)/);
  assert.match(commitmentReport, /kind: "extraction_report"/);
});

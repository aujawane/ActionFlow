"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  FileDropZone,
  ImportNotice,
  MissingDateWarning,
  PasteEditor,
  PreviewPanel,
  ResumeNotice,
  SOURCE_TABS,
  SourceTabs
} from "@/components/import-transcript-parts";
import {
  effectiveTitle,
  ImportSession,
  type ImportMode,
  type SessionDeps
} from "@/lib/transcript-import/client-session";
import { formatReadableDate } from "@/lib/format-date";

type ProjectOption = { id: string; name: string };

function browserDeps(): SessionDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    newId: () => crypto.randomUUID(),
    // Created lazily and guarded inside the session: storage is absent while rendering on the server
    // and can throw in private windows.
    storage: {
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key)
    },
    now: () => Date.now()
  };
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function ImportTranscriptForm({ projects }: { projects: ProjectOption[] }) {
  const router = useRouter();
  const [session] = useState(() => new ImportSession(browserDeps()));
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const [now, setNow] = useState(() => Date.now());
  const [dragging, setDragging] = useState(false);
  const dateRef = useRef<HTMLInputElement>(null);

  // Pick up an import interrupted by a page refresh (storage only exists in the browser).
  useEffect(() => {
    session.restore();
  }, [session]);

  // Count down a Retry-After wait.
  useEffect(() => {
    if (state.retryAt === null || state.retryAt <= Date.now()) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (state.retryAt !== null && current >= state.retryAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state.retryAt]);

  // A finished import continues on the normal meeting page, which already shows analysis progress.
  useEffect(() => {
    if (state.phase === "complete" && state.redirectTo) {
      router.push(state.redirectTo as Route);
      router.refresh();
    }
  }, [router, state.phase, state.redirectTo]);

  const lock = session.lock();
  const busy = state.phase === "previewing" || state.phase === "submitting";
  const finished = state.phase === "complete" || state.phase === "saved_not_queued" || state.phase === "blocked";
  const contentDisabled = busy || finished || lock === "all";
  const detailsDisabled = contentDisabled || lock === "details";
  const secondsLeft = state.retryAt !== null ? Math.max(0, Math.ceil((state.retryAt - now) / 1000)) : 0;
  const canSubmit = session.canSubmit() && secondsLeft === 0;
  const { input } = state;
  // The preview stays on screen while sending and after an unknown outcome, so the user can see what
  // is being retried. It is only editable (confirmable, re-sendable) while "previewed".
  const hasPreview = state.preview !== null && (state.phase === "previewed" || state.phase === "submitting" || state.phase === "retry_needed");
  const awaitingConfirmation = state.phase === "previewed" || state.phase === "submitting";
  const fieldErrors = state.fieldErrors;
  const resumed = state.resumedFrom;
  const dateMissing = input.meetingDate === "";

  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = SOURCE_TABS.findIndex((tab) => tab.mode === input.mode);
    const next = SOURCE_TABS[(index + (event.key === "ArrowRight" ? 1 : SOURCE_TABS.length - 1)) % SOURCE_TABS.length];
    if (session.setInput({ mode: next.mode })) {
      window.requestAnimationFrame(() => document.getElementById(`import-tab-${next.mode}`)?.focus());
    }
  }

  function chooseFile(file: File | null | undefined) {
    if (file) session.setInput({ file });
  }

  async function onPreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (hasPreview) return;
    await session.preview();
  }

  const retryActions = (
    <>
      <button
        type="button"
        className="premium-button !px-4 !py-2 text-xs"
        disabled={!canSubmit}
        onClick={() => void session.submit()}
      >
        {secondsLeft > 0 ? `Retry in ${secondsLeft}s` : "Retry import"}
      </button>
      <button type="button" className="secondary-button !px-4 !py-2 text-xs" onClick={() => session.startNewImport()}>
        Start new import
      </button>
    </>
  );

  return (
    <form onSubmit={onPreview} noValidate className="premium-card max-w-3xl space-y-6 p-5 sm:p-6" aria-busy={busy}>
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Import a transcript</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Analyze a meeting that already happened. Upload a transcript file or paste the text, check the preview, then Parfait extracts the commitments, tasks and decisions.
        </p>
      </div>

      {resumed && !state.snapshot ? (
        <div className="space-y-3">
          <ResumeNotice
            title={resumed.title}
            mode={resumed.mode}
            fileName={resumed.fileName}
            startedAtLabel={formatReadableDate(new Date(resumed.startedAt).toISOString())}
          />
          <button type="button" className="secondary-button !px-3 !py-1.5 text-xs" onClick={() => session.startNewImport()}>
            Start new import
          </button>
        </div>
      ) : null}

      <fieldset className="space-y-3" disabled={contentDisabled}>
        <legend className="sr-only">Transcript</legend>
        <SourceTabs
          mode={input.mode}
          disabled={detailsDisabled}
          onChange={(mode: ImportMode) => session.setInput({ mode })}
          onKeyDown={onTabKeyDown}
        />
        <div
          role="tabpanel"
          id={`import-panel-${input.mode}`}
          aria-labelledby={`import-tab-${input.mode}`}
        >
          {input.mode === "upload" ? (
            <FileDropZone
              file={input.file ? { name: input.file.name, size: input.file.size } : null}
              error={fieldErrors.file}
              disabled={contentDisabled}
              dragging={dragging}
              resumeFileName={resumed?.mode === "upload" ? resumed.fileName : null}
              onRemove={() => session.setInput({ file: null })}
              inputProps={{
                onChange: (event) => {
                  chooseFile(event.target.files?.[0]);
                  event.target.value = "";
                }
              }}
              dropProps={{
                onDragOver: (event) => {
                  event.preventDefault();
                  if (!contentDisabled) setDragging(true);
                },
                onDragLeave: () => setDragging(false),
                onDrop: (event) => {
                  event.preventDefault();
                  setDragging(false);
                  if (!contentDisabled) chooseFile(event.dataTransfer.files?.[0]);
                }
              }}
            />
          ) : (
            <PasteEditor
              text={input.text}
              error={fieldErrors.text}
              disabled={contentDisabled}
              onChange={(event) => session.setInput({ text: event.target.value })}
            />
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-slate-100 pt-5" disabled={detailsDisabled}>
        <legend className="sr-only">Meeting details</legend>
        <h3 className="text-sm font-semibold text-slate-900">Meeting details</h3>

        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700" htmlFor="import-title">
            Meeting title <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id="import-title"
            className="premium-input"
            value={input.title}
            maxLength={200}
            placeholder={effectiveTitle({ ...input, title: "" })}
            aria-describedby={fieldErrors.title ? "import-title-error" : undefined}
            aria-invalid={fieldErrors.title ? true : undefined}
            onChange={(event) => session.setInput({ title: event.target.value })}
          />
          {fieldErrors.title ? (
            <p id="import-title-error" role="alert" className="text-xs text-rose-700">
              {fieldErrors.title}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-700" htmlFor="import-date">
              Meeting date
              <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[0.6875rem] font-semibold text-brand-800">Recommended</span>
            </label>
            <input
              id="import-date"
              ref={dateRef}
              type="date"
              className="premium-input"
              value={input.meetingDate}
              min="1990-01-01"
              max={todayIso()}
              aria-describedby={fieldErrors.meetingDate ? "import-date-error" : "import-date-help"}
              aria-invalid={fieldErrors.meetingDate ? true : undefined}
              onChange={(event) => session.setInput({ meetingDate: event.target.value })}
            />
            <p id="import-date-help" className="text-xs leading-5 text-slate-500">
              Adding the original meeting date helps Parfait interpret deadlines like &ldquo;tomorrow&rdquo; or &ldquo;next Friday&rdquo; correctly.
            </p>
            {fieldErrors.meetingDate ? (
              <p id="import-date-error" role="alert" className="text-xs text-rose-700">
                {fieldErrors.meetingDate}
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700" htmlFor="import-project">
              Project <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <select
              id="import-project"
              className="premium-input"
              value={input.projectId}
              aria-describedby={fieldErrors.projectId ? "import-project-error" : undefined}
              aria-invalid={fieldErrors.projectId ? true : undefined}
              onChange={(event) => session.setInput({ projectId: event.target.value })}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {fieldErrors.projectId ? (
              <p id="import-project-error" role="alert" className="text-xs text-rose-700">
                {fieldErrors.projectId}
              </p>
            ) : null}
          </div>
        </div>
      </fieldset>

      {state.error && state.phase !== "retry_needed" && state.phase !== "blocked" && !fieldErrorsCoverError(state.error, fieldErrors) ? (
        <ImportNotice
          error={state.error}
          secondsLeft={secondsLeft}
          actions={
            state.error.kind === "session" ? (
              <Link href={"/login" as Route} className="secondary-button !px-3 !py-1.5 text-xs">
                Sign in
              </Link>
            ) : undefined
          }
        />
      ) : null}

      {state.phase === "retry_needed" && state.error ? (
        <ImportNotice error={state.error} secondsLeft={secondsLeft} actions={retryActions} />
      ) : null}

      {state.phase === "blocked" && state.error ? (
        <ImportNotice
          error={state.error}
          actions={
            <>
              {state.meetingId ? (
                <Link href={`/meetings/${state.meetingId}` as Route} className="secondary-button !px-3 !py-1.5 text-xs">
                  Open meeting
                </Link>
              ) : null}
              <button type="button" className="premium-button !px-4 !py-2 text-xs" onClick={() => session.startNewImport()}>
                Start new import
              </button>
            </>
          }
        />
      ) : null}

      {state.phase === "saved_not_queued" && state.redirectTo ? (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-semibold">Transcript saved, but analysis didn&rsquo;t start</p>
          <p className="mt-1 text-xs leading-5 text-amber-900">
            Your meeting was created with {state.segmentCount?.toLocaleString("en-US") ?? "all"} transcript segments. Open it and choose <strong>Analyze Meeting</strong> to start the analysis. You won&rsquo;t need to import again.
          </p>
          <Link href={state.redirectTo as Route} className="premium-button mt-3 !px-4 !py-2 text-xs">
            Open meeting
          </Link>
        </div>
      ) : null}

      {state.phase === "complete" && state.redirectTo ? (
        <div role="status" className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
          <p className="font-semibold">Import started</p>
          <p className="mt-1 text-xs text-brand-800">
            Opening your meeting. If nothing happens,{" "}
            <Link href={state.redirectTo as Route} className="font-semibold underline underline-offset-2">
              open it now
            </Link>
            .
          </p>
        </div>
      ) : null}

      {!hasPreview && !finished && state.phase !== "retry_needed" ? (
        <div>
          <button type="submit" className="premium-button w-full sm:w-auto" disabled={busy}>
            {state.phase === "previewing" ? "Reading transcript..." : "Preview transcript"}
          </button>
        </div>
      ) : null}

      {hasPreview && state.preview ? (
        <div className="space-y-4 border-t border-slate-100 pt-5">
          <PreviewPanel preview={state.preview} />

          {dateMissing ? <MissingDateWarning onAddDate={() => dateRef.current?.focus()} /> : null}

          <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white/80 px-4 py-3 text-sm text-slate-800" htmlFor="import-confirm">
            <input
              id="import-confirm"
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              checked={state.confirmed || state.snapshot !== null}
              disabled={busy || state.phase === "retry_needed"}
              onChange={(event) => session.setConfirmed(event.target.checked)}
            />
            <span>
              The speakers and content look right.
              <span className="mt-0.5 block text-xs text-slate-500">Analysis uses AI and usually takes a few minutes. You&rsquo;ll follow its progress on the meeting page.</span>
            </span>
          </label>

          {awaitingConfirmation ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <button
                type="button"
                className="premium-button w-full sm:w-auto"
                disabled={!canSubmit}
                onClick={() => void session.submit()}
              >
                {state.phase === "submitting" ? "Importing..." : secondsLeft > 0 ? `Try again in ${secondsLeft}s` : "Analyze transcript"}
              </button>
              <p className="text-xs text-slate-500" aria-live="polite">
                {state.phase === "submitting" ? "Importing your transcript. Don\u2019t close this page." : state.confirmed ? "Ready to analyze." : "Confirm the preview to continue."}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

    </form>
  );
}

/** A field-level message is already shown beside its input; don't repeat it in the banner. */
function fieldErrorsCoverError(
  error: { field?: string },
  fieldErrors: Record<string, string | undefined>
): boolean {
  return Boolean(error.field && fieldErrors[error.field]);
}

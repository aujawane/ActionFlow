import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";

import {
  formatBytes,
  SUPPORTED_EXTENSIONS,
  type ImportError,
  type ImportMode
} from "@/lib/transcript-import/client-session";
import { MAX_TRANSCRIPT_BYTES } from "@/lib/transcript-import/limits";
import type { DetectedTranscriptFormat } from "@/lib/transcript-import/parse";
import type { TranscriptImportPreview } from "@/lib/transcript-import/prepare";

/** Presentational pieces of the import form. No router, no network: props in, markup out. */

// ---------------------------------------------------------------------------- add-meeting switch

export type AddMeetingMode = "bot" | "import";

export function AddMeetingModeNav({ mode }: { mode: AddMeetingMode }) {
  const items: Array<{ mode: AddMeetingMode; label: string; hint: string; href: string }> = [
    { mode: "bot", label: "Send Parfait bot", hint: "Join a live meeting", href: "/meetings/new" },
    { mode: "import", label: "Import transcript", hint: "Analyze a past meeting", href: "/meetings/new?mode=import" }
  ];
  return (
    <nav aria-label="How to add a meeting" className="grid max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
      {items.map((item) => {
        const active = item.mode === mode;
        return (
          <Link
            key={item.mode}
            href={item.href as Route}
            aria-current={active ? "page" : undefined}
            className={`rounded-xl border px-4 py-3 text-left transition focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/25 ${
              active
                ? "border-brand-500 bg-brand-50 text-brand-900 shadow-sm"
                : "border-slate-200 bg-white/80 text-slate-700 hover:border-brand-200 hover:bg-brand-50/50"
            }`}
          >
            <span className="block text-sm font-semibold">{item.label}</span>
            <span className={`mt-0.5 block text-xs ${active ? "text-brand-800" : "text-slate-500"}`}>{item.hint}</span>
          </Link>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------- source tabs

export const SOURCE_TABS: Array<{ mode: ImportMode; label: string }> = [
  { mode: "upload", label: "Upload file" },
  { mode: "paste", label: "Paste transcript" }
];

export function SourceTabs({
  mode,
  disabled,
  onChange,
  onKeyDown
}: {
  mode: ImportMode;
  disabled?: boolean;
  onChange?: (mode: ImportMode) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div role="tablist" aria-label="Transcript source" className="inline-flex w-full rounded-xl bg-slate-100 p-1 sm:w-auto">
      {SOURCE_TABS.map((tab) => {
        const selected = tab.mode === mode;
        return (
          <button
            key={tab.mode}
            type="button"
            role="tab"
            id={`import-tab-${tab.mode}`}
            aria-selected={selected}
            aria-controls={`import-panel-${tab.mode}`}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange?.(tab.mode)}
            onKeyDown={onKeyDown}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/25 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none ${
              selected ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------- file drop zone

export function FileDropZone({
  file,
  error,
  disabled,
  dragging,
  inputProps,
  dropProps,
  onRemove,
  resumeFileName
}: {
  file: { name: string; size: number } | null;
  error?: string | null;
  disabled?: boolean;
  dragging?: boolean;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
  dropProps?: React.HTMLAttributes<HTMLLabelElement>;
  onRemove?: () => void;
  /** After a page refresh: the file the interrupted import used. */
  resumeFileName?: string | null;
}) {
  return (
    <div>
      <label
        htmlFor="import-file"
        {...dropProps}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition focus-within:ring-4 focus-within:ring-brand-500/25 sm:py-10 ${
          dragging ? "border-brand-500 bg-brand-50" : error ? "border-rose-300 bg-rose-50/40" : "border-slate-300 bg-slate-50/60 hover:border-brand-300 hover:bg-brand-50/40"
        } ${disabled ? "pointer-events-none opacity-60" : ""}`}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-8 w-8 text-brand-600" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4m0 0 4 4m-4-4L8 8" />
          <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
        </svg>
        <span className="text-sm font-semibold text-slate-800">
          {file ? "Choose a different file" : "Drag a transcript here, or browse"}
        </span>
        <span className="text-xs text-slate-500">
          {SUPPORTED_EXTENSIONS.join("  ")} · up to {formatBytes(MAX_TRANSCRIPT_BYTES)}
        </span>
        <input
          id="import-file"
          type="file"
          accept={SUPPORTED_EXTENSIONS.join(",")}
          disabled={disabled}
          aria-describedby={error ? "import-file-error" : "import-file-help"}
          aria-invalid={error ? true : undefined}
          className="sr-only"
          {...inputProps}
        />
      </label>
      <p id="import-file-help" className="mt-2 text-xs text-slate-500">
        Supported: <strong className="font-semibold">.txt</strong>, <strong className="font-semibold">.md</strong>,{" "}
        <strong className="font-semibold">.vtt</strong> and <strong className="font-semibold">.srt</strong>. PDFs, documents, audio and video aren&rsquo;t supported.
      </p>
      {resumeFileName && !file ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Choose the same file again ({resumeFileName}) to continue this import.
        </p>
      ) : null}
      {file ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5" data-testid="selected-file">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">{file.name}</p>
            <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
          </div>
          <button type="button" onClick={onRemove} disabled={disabled} className="secondary-button shrink-0 !px-3 !py-1.5 text-xs" aria-label={`Remove ${file.name}`}>
            Remove
          </button>
        </div>
      ) : null}
      {error ? (
        <p id="import-file-error" role="alert" className="mt-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------- paste editor

export const PASTE_PLACEHOLDER = `Alex: Thanks for joining. Let's settle the signup flow today.
Jordan: I'd prefer a single page. I'll review the draft by Monday.
Alex: Agreed. I'll send the requirements by Friday.`;

export function PasteEditor({
  text,
  error,
  disabled,
  onChange
}: {
  text: string;
  error?: string | null;
  disabled?: boolean;
  onChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
}) {
  const empty = text.trim().length === 0;
  return (
    <div>
      <label htmlFor="import-text" className="sr-only">
        Transcript text
      </label>
      <textarea
        id="import-text"
        value={text}
        onChange={onChange}
        disabled={disabled}
        spellCheck={false}
        placeholder={PASTE_PLACEHOLDER}
        aria-describedby={error ? "import-text-error" : "import-text-help"}
        aria-invalid={error ? true : undefined}
        className="premium-input min-h-[16rem] resize-y font-mono text-[13px] leading-6 sm:min-h-[20rem]"
      />
      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <p id="import-text-help" className="text-xs text-slate-500">
          {empty
            ? "Paste speaker-labeled dialogue (Name: text), timestamped blocks, subtitles or plain paragraphs."
            : "Parfait reads the speaker names and order exactly as pasted."}
        </p>
        <p className="text-xs tabular-nums text-slate-500" aria-live="polite">
          {text.length.toLocaleString("en-US")} characters
        </p>
      </div>
      {error ? (
        <p id="import-text-error" role="alert" className="mt-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------- preview

const FORMAT_LABELS: Record<DetectedTranscriptFormat, string> = {
  speaker_labeled: "Speaker-labeled",
  timestamped_speaker_blocks: "Timestamped speaker blocks",
  plain_text: "Plain text",
  webvtt: "WebVTT subtitles",
  srt: "SRT subtitles"
};

export function formatLabel(format: DetectedTranscriptFormat): string {
  return FORMAT_LABELS[format] ?? format;
}

export function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function PreviewPanel({ preview }: { preview: TranscriptImportPreview }) {
  // The missing-date notice has its own prominent callout; every other warning is listed here.
  const warnings = preview.warnings.filter((warning) => warning.code !== "meeting_date_missing");
  const speakerNames = preview.speakers.map((speaker) => speaker.label);
  const samples = preview.sampleSegments;
  return (
    <section aria-labelledby="import-preview-heading" className="space-y-4 rounded-2xl border border-slate-200 bg-white/90 p-4 sm:p-5">
      <h3 id="import-preview-heading" className="text-sm font-semibold text-slate-900">
        Transcript preview
      </h3>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Format</dt>
          <dd className="mt-0.5 font-medium text-slate-900">{formatLabel(preview.format)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Segments</dt>
          <dd className="mt-0.5 font-medium text-slate-900">{preview.segmentCount.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Speakers</dt>
          <dd className="mt-0.5 font-medium text-slate-900">
            {speakerNames.length > 0 ? speakerNames.join(", ") : "None detected"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Time information</dt>
          <dd className="mt-0.5 font-medium text-slate-900">
            {preview.hasTimeOffsets ? "Times from the start of the recording" : "Not provided"}
          </dd>
        </div>
      </dl>

      {warnings.length > 0 ? (
        <ul className="space-y-1.5" aria-label="Parsing notes">
          {warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              {warning.message}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-xs leading-5 text-slate-500">
        Parfait uses the speaker names found in your transcript. If a name looks wrong, correct it in the source and preview again.
      </p>

      <ol className="space-y-2" aria-label="Sample of the parsed transcript">
        {samples.map((sample, position) => {
          const previous = samples[position - 1];
          const gap = previous ? sample.index - previous.index - 1 : 0;
          return (
            <li key={sample.index}>
              {gap > 0 ? (
                <p className="py-1 text-center text-xs text-slate-400">
                  … {gap.toLocaleString("en-US")} more segment{gap === 1 ? "" : "s"} …
                </p>
              ) : null}
              <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2">
                <p className="text-xs font-semibold text-slate-600">
                  {sample.speaker}
                  {sample.startOffsetMs !== null ? (
                    <span className="ml-2 font-normal text-slate-400">{formatOffset(sample.startOffsetMs)}</span>
                  ) : null}
                </p>
                <p className="mt-0.5 break-words text-sm text-slate-800">{sample.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------- notices

export function MissingDateWarning({ onAddDate }: { onAddDate?: () => void }) {
  return (
    <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <p className="font-semibold">No meeting date</p>
      <p className="mt-1 text-xs leading-5 text-amber-900">
        Without the original date, Parfait reads deadlines such as &ldquo;tomorrow&rdquo; or &ldquo;next Friday&rdquo; relative to today, which may be wrong for a past meeting.
      </p>
      {onAddDate ? (
        <button type="button" onClick={onAddDate} className="mt-2 text-xs font-semibold text-amber-950 underline underline-offset-2 hover:text-amber-800">
          Add the meeting date
        </button>
      ) : null}
    </div>
  );
}

export function ImportNotice({
  error,
  secondsLeft,
  actions
}: {
  error: ImportError;
  /** Seconds until the action may be retried, when the server asked us to wait. */
  secondsLeft?: number | null;
  actions?: ReactNode;
}) {
  const calm = error.kind === "in_progress" || error.kind === "incomplete" || error.kind === "unknown_outcome";
  return (
    <div
      role="alert"
      data-kind={error.kind}
      className={`rounded-xl border px-4 py-3 text-sm ${calm ? "border-amber-300 bg-amber-50 text-amber-950" : "border-rose-200 bg-rose-50 text-rose-800"}`}
    >
      <p>{error.message}</p>
      {secondsLeft && secondsLeft > 0 ? (
        <p className="mt-1 text-xs opacity-80" aria-live="polite">
          You can retry in {secondsLeft} second{secondsLeft === 1 ? "" : "s"}.
        </p>
      ) : null}
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function ResumeNotice({ title, startedAtLabel, mode, fileName }: { title: string; startedAtLabel?: string | null; mode: ImportMode; fileName: string | null }) {
  return (
    <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <p className="font-semibold">An import is in progress</p>
      <p className="mt-1 text-xs leading-5 text-amber-900">
        &ldquo;{title}&rdquo;{startedAtLabel ? ` was started ${startedAtLabel}` : " was started"}, but this page was reloaded before it finished.{" "}
        {mode === "upload"
          ? `Choose the same file again${fileName ? ` (${fileName})` : ""}`
          : "Paste the same transcript again"}{" "}
        to finish it without creating a duplicate, or start a new import. Your transcript isn&rsquo;t stored in the browser.
      </p>
    </div>
  );
}

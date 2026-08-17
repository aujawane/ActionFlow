"use client";

import { renderMarkdownText } from "@/lib/parfait-response/markdown";
import type { ParfaitResponse, ParfaitResponseSection } from "@/lib/types";

/**
 * The one place Parfait chat responses become UI. The model decides WHAT matters (answer /
 * evidence / blocker / next action / decision / list / warning); everything here decides HOW it
 * looks. Every chat surface that adopts the shared response contract renders through this
 * component instead of reimplementing bubble/section markup -- see the PR description for which
 * surfaces have migrated and which remain on the legacy (Markdown-safe) fallback below.
 *
 * Two independent render paths, chosen by which prop is present:
 *  - `response` (a parsed ParfaitResponse): the structured, section-aware layout.
 *  - `legacyText` (a plain string that may contain bold/italic/code/list/quote markdown syntax,
 *    written by a model with no structure instructions): rendered through the small Markdown-safe
 *    parser in lib/parfait-response/markdown.tsx -- never dangerouslySetInnerHTML, never raw
 *    model HTML.
 * If neither is present, renders nothing (callers decide what an empty assistant turn means).
 */
export function ParfaitResponseRenderer({
  response,
  legacyText,
  onFollowUp
}: {
  response?: ParfaitResponse | null;
  legacyText?: string | null;
  /** Omit to hide follow-up suggestions entirely (e.g. a surface with no way to resend a typed
   * question). When provided, clicking a suggestion calls this with the suggestion text -- the
   * caller decides whether that means "send immediately" or "populate the composer". */
  onFollowUp?: (text: string) => void;
}) {
  if (response) {
    return (
      <div className="max-w-3xl space-y-2.5">
        <p className="text-[15px] leading-[1.6] text-slate-800">{response.answer}</p>

        {response.sections && response.sections.length > 0 ? (
          <div className="space-y-2">
            {response.sections.map((section, index) => (
              <ParfaitSectionCard key={index} section={section} />
            ))}
          </div>
        ) : null}

        {onFollowUp && response.followUps && response.followUps.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {response.followUps.slice(0, 3).map((followUp) => (
              <button
                key={followUp}
                type="button"
                onClick={() => onFollowUp(followUp)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-brand-700 transition hover:border-brand-200 hover:bg-brand-50"
              >
                {followUp}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (!legacyText) return null;

  return (
    <div className="max-w-3xl space-y-2 whitespace-normal text-[15px] leading-[1.6] text-slate-700 [&_ol]:pl-5 [&_ul]:pl-5">
      {renderMarkdownText(legacyText)}
    </div>
  );
}

function sectionLabel(section: ParfaitResponseSection): string {
  if (section.title) return section.title;
  switch (section.type) {
    case "evidence":
      return "From the meeting";
    case "blocker":
      return "Blocker";
    case "next_action":
      return "Next action";
    case "decision":
      return "Decision";
    case "warning":
      return "Warning";
    case "list":
      return "";
  }
}

function ParfaitSectionCard({ section }: { section: ParfaitResponseSection }) {
  if (section.type === "list") {
    return (
      <div>
        {section.title ? (
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {section.title}
          </p>
        ) : null}
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-slate-700">
          {section.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ol>
      </div>
    );
  }

  if (section.type === "evidence") {
    const sourceLine = [section.source?.speaker, formatEvidenceTimestamp(section.source?.timestamp)]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="rounded-lg border-l-2 border-slate-300 bg-slate-50 px-3 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {sectionLabel(section)}
        </p>
        <p className="mt-1 text-sm italic leading-6 text-slate-700">&ldquo;{section.content}&rdquo;</p>
        {sourceLine ? <p className="mt-1 text-xs text-slate-400">{sourceLine}</p> : null}
      </div>
    );
  }

  if (section.type === "blocker" || section.type === "warning") {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
          {sectionLabel(section)}
        </p>
        <p className="mt-1 text-sm leading-6 text-amber-900">{section.content}</p>
      </div>
    );
  }

  // next_action / decision -- a subtle green (Parfait's "execution" accent), next_action a touch
  // more prominent than a decision note.
  const isNextAction = section.type === "next_action";
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        isNextAction ? "border-emerald-200 bg-emerald-50" : "border-emerald-100 bg-emerald-50/60"
      }`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
        {sectionLabel(section)}
      </p>
      <p className="mt-1 text-sm leading-6 text-emerald-950">{section.content}</p>
    </div>
  );
}

function formatEvidenceTimestamp(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const asDate = new Date(timestamp);
  if (!Number.isNaN(asDate.getTime()) && /\d{4}-\d{2}-\d{2}/.test(timestamp)) {
    return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(asDate);
  }
  return timestamp;
}

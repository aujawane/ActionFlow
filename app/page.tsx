import Link from "next/link";

const features = [
  "Recall.ai bot joins your call automatically",
  "Near real-time transcript ingestion via webhook",
  "OpenAI-powered requirement and architecture extraction",
  "One-click prompt generation for Codex, Claude Code, and Lovable"
];

export default function LandingPage() {
  return (
    <section className="space-y-10">
      <div className="max-w-3xl space-y-4">
        <p className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">
          MVP
        </p>
        <h1 className="text-4xl font-bold tracking-tight text-slate-900">
          Turn product meetings into build-ready engineering prompts.
        </h1>
        <p className="text-lg text-slate-600">
          ActionFlow joins meetings with Recall.ai, captures live transcript
          data, extracts actionable requirements, and produces polished prompts
          your coding AI can execute immediately.
        </p>
        <div className="flex gap-3">
          <Link
            href="/login"
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Get Started
          </Link>
          <Link
            href="/dashboard"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            View Dashboard
          </Link>
        </div>
      </div>

      <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-6">
        {features.map((feature) => (
          <p key={feature} className="text-sm text-slate-700">
            - {feature}
          </p>
        ))}
      </div>
    </section>
  );
}

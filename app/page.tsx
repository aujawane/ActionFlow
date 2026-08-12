import Link from "next/link";

const features = [
  "Recall.ai bot joins your call automatically",
  "Near real-time transcript ingestion via webhook",
  "Commitments and tasks extracted from the conversation",
  "Parfait can execute tasks directly into reviewable deliverables"
];

export default function LandingPage() {
  return (
    <section className="space-y-10">
      <div className="premium-card overflow-hidden p-8 sm:p-10">
        <div className="max-w-3xl space-y-5">
        <p className="inline-flex rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-800 shadow-sm">
          AI Execution Platform
        </p>
        <h1 className="text-4xl font-bold tracking-tight text-slate-950 sm:text-5xl">
          Turn meetings into executed work.
        </h1>
        <p className="max-w-2xl text-lg leading-8 text-slate-600">
          Parfait joins your meetings with Recall.ai, turns the conversation into commitments
          and tasks, then helps execute them into deliverables you can review and accept.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/login"
            className="premium-button"
          >
            Get Started
          </Link>
          <Link
            href="/projects"
            className="secondary-button"
          >
            View Projects
          </Link>
        </div>
        </div>
      </div>

      <div className="grid gap-3 rounded-2xl border border-white/70 bg-white/80 p-6 shadow-2xl shadow-slate-900/10 backdrop-blur sm:grid-cols-2">
        {features.map((feature) => (
          <p
            key={feature}
            className="rounded-xl border border-brand-100 bg-brand-50/50 px-4 py-3 text-sm font-medium text-slate-700 transition hover:-translate-y-0.5 hover:bg-brand-50 hover:text-brand-900"
          >
            {feature}
          </p>
        ))}
      </div>
    </section>
  );
}

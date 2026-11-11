import Link from "next/link";

import { SiteFrame } from "@/components/public-site/site-frame";
import { primaryCta, secondaryCta, textLink } from "@/components/public-site/styles";

const steps = [
  {
    title: "Add your meeting",
    body: "Paste a Google Meet or Zoom link. Parfait Notetaker joins as a visible participant and transcribes the conversation."
  },
  {
    title: "Parfait structures it",
    body: "The transcript is analyzed for what was committed to, who owns what, what was decided, and what is still open."
  },
  {
    title: "You review and correct",
    body: "Everything Parfait extracts is editable. Fix an owner, merge duplicates, or move an item out of scope."
  },
  {
    title: "Work keeps moving",
    body: "Track commitments and tasks across meetings in a project, and turn tasks into reviewable deliverables."
  }
];

const capabilities = [
  {
    title: "Commitments and tasks",
    body: "Separate real commitments from passing ideas, then break them into tasks with owners and due dates when they were stated."
  },
  {
    title: "Decisions and context",
    body: "Keep the decisions, requirements, and reasoning behind them alongside the transcript they came from."
  },
  {
    title: "Project memory",
    body: "Group meetings into projects so commitments and context accumulate in one place instead of being rediscovered each week."
  },
  {
    title: "Ask Parfait",
    body: "Ask questions about a meeting or a project and get answers grounded in what was actually said."
  },
  {
    title: "Reviewable deliverables",
    body: "Have Parfait draft the work a task calls for, then review, edit, and accept it yourself."
  },
  {
    title: "Follow-up drafts",
    body: "Generate follow-up email drafts from a meeting's tasks. Parfait only drafts; it never sends email on your behalf."
  }
];

export function HomePage({ signedIn }: { signedIn: boolean }) {
  return (
    <SiteFrame signedIn={signedIn}>
      {/* Hero */}
      <section aria-labelledby="hero-heading" className="mx-auto w-full max-w-6xl px-4 pb-16 pt-14 sm:px-6 sm:pb-24 sm:pt-20">
        <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-6">
            <h1
              id="hero-heading"
              className="text-4xl font-bold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl"
            >
              Turn meetings into action.
            </h1>
            <p className="max-w-xl text-lg leading-8 text-slate-700">
              Parfait captures the commitments, tasks, decisions, and context that come out of
              your meetings, so your team knows what happens next.
            </p>
            <div className="flex flex-wrap gap-3">
              {signedIn ? (
                <Link href="/dashboard" className={primaryCta}>
                  Open Parfait
                </Link>
              ) : (
                <>
                  <Link href="/login" className={primaryCta}>
                    Get started
                  </Link>
                  <Link href="/login" className={secondaryCta}>
                    Sign in
                  </Link>
                </>
              )}
              <a href="#how-it-works" className={secondaryCta}>
                See how it works
              </a>
            </div>
            <p className="max-w-xl text-sm leading-6 text-slate-600">
              Parfait is for meetings where everyone has been told they are being recorded and
              transcribed. Learn more in our{" "}
              <Link href="/privacy" className={textLink}>
                Privacy Policy
              </Link>{" "}
              and{" "}
              <Link href="/terms" className={textLink}>
                Terms of Service
              </Link>
              .
            </p>
          </div>

          <figure className="premium-card p-5 sm:p-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  From a meeting
                </p>
                <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-900">
                  Example
                </span>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Commitment
                </p>
                <p className="mt-1.5 text-sm font-semibold text-slate-900">
                  Send the revised proposal to the client
                </p>
                <p className="mt-1 text-sm text-slate-600">Owner: Craig · Due: Friday</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Decision
                </p>
                <p className="mt-1.5 text-sm font-semibold text-slate-900">
                  Launch to the pilot group first, then expand
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Open question
                </p>
                <p className="mt-1.5 text-sm font-semibold text-slate-900">
                  Who confirms the final pricing?
                </p>
              </div>
            </div>
            <figcaption className="mt-4 text-xs leading-5 text-slate-600">
              Illustrative example for explanation only, not real customer data.
            </figcaption>
          </figure>
        </div>
      </section>

      {/* How it works */}
      <section
        id="how-it-works"
        aria-labelledby="how-heading"
        className="scroll-mt-6 border-y border-slate-200/80 bg-white/70"
      >
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="max-w-2xl">
            <h2 id="how-heading" className="text-3xl font-bold tracking-tight text-slate-950">
              From conversation to follow-through
            </h2>
            <p className="mt-3 text-base leading-7 text-slate-700">
              Most meeting follow-up gets lost between the call and the next one. Parfait gives
              the conversation a structure you can act on.
            </p>
          </div>
          <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step, index) => (
              <li key={step.title} className="premium-card p-5">
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-700 text-sm font-bold text-white"
                >
                  {index + 1}
                </span>
                <h3 className="mt-4 text-base font-semibold text-slate-950">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-700">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Capabilities */}
      <section
        id="capabilities"
        aria-labelledby="capabilities-heading"
        className="mx-auto w-full max-w-6xl scroll-mt-6 px-4 py-16 sm:px-6 sm:py-20"
      >
        <div className="max-w-2xl">
          <h2 id="capabilities-heading" className="text-3xl font-bold tracking-tight text-slate-950">
            What Parfait does
          </h2>
          <p className="mt-3 text-base leading-7 text-slate-700">
            One workspace for what your meetings produce, organized around the work that comes
            out of them.
          </p>
        </div>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((item) => (
            <li key={item.title} className="premium-card p-6">
              <h3 className="text-base font-semibold text-slate-950">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Trust */}
      <section aria-labelledby="trust-heading" className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6 sm:pb-20">
        <div className="premium-card grid gap-8 p-6 sm:p-10 lg:grid-cols-[1fr_1fr]">
          <div>
            <h2 id="trust-heading" className="text-2xl font-bold tracking-tight text-slate-950">
              AI assists. You stay in control.
            </h2>
            <p className="mt-3 text-base leading-7 text-slate-700">
              Parfait&apos;s analysis is generated by AI and can be incomplete or wrong. That is
              why every commitment, task, and deliverable is designed to be reviewed and
              corrected by you before anyone relies on it.
            </p>
          </div>
          <div className="space-y-3 text-sm leading-6 text-slate-700">
            <p>
              <span className="font-semibold text-slate-950">Sign in your way.</span> Use email
              and password, or Continue with Google. Signing in with Google shares only your basic
              profile: name, email address, and profile picture.
            </p>
            <p>
              <span className="font-semibold text-slate-950">Clear about your data.</span> Our{" "}
              <Link href="/privacy" className={textLink}>
                Privacy Policy
              </Link>{" "}
              explains what we collect, which service providers process it, and what choices you
              have.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section aria-labelledby="cta-heading" className="border-t border-slate-200/80 bg-slate-950">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-6 px-4 py-14 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="max-w-xl">
            <h2 id="cta-heading" className="text-2xl font-bold tracking-tight text-white">
              Make the next meeting count.
            </h2>
            <p className="mt-2 text-base leading-7 text-slate-300">
              Bring a meeting into Parfait and see what happens next, clearly written down.
            </p>
          </div>
          {signedIn ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center justify-center rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              Open Parfait
            </Link>
          ) : (
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              Get started
            </Link>
          )}
        </div>
      </section>
    </SiteFrame>
  );
}

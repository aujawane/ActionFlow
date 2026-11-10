import Link from "next/link";

import { focusRing, primaryCta, secondaryCta, navLink } from "@/components/public-site/styles";

/** Public navigation shared by the homepage and legal pages. `signedIn` swaps the Sign in / Get
 * started pair for a single "Open Parfait" action; the auth routes themselves are unchanged. */
export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="border-b border-white/70 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <Link
          href="/"
          className={`flex items-center gap-3 rounded-lg text-lg font-semibold text-slate-950 ${focusRing}`}
        >
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-2xl bg-brand-700 text-sm font-bold text-white shadow-lg shadow-brand-700/20"
          >
            P
          </span>
          <span>Parfait</span>
        </Link>

        <nav
          aria-label="Primary"
          className="order-last flex w-full items-center gap-5 text-sm sm:order-none sm:w-auto sm:flex-1 sm:justify-end"
        >
          <Link href="/#how-it-works" className={`hidden sm:inline-block ${navLink}`}>
            Product
          </Link>
          <Link href="/privacy" className={navLink}>
            Privacy
          </Link>
          <Link href="/terms" className={navLink}>
            Terms
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          {signedIn ? (
            <Link href="/dashboard" className={primaryCta}>
              Open Parfait
            </Link>
          ) : (
            <>
              <Link href="/login" className={secondaryCta}>
                Sign in
              </Link>
              <Link href="/login" className={primaryCta}>
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

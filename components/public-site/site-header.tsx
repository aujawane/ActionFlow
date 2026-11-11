import Link from "next/link";
import { ParfaitLogo } from "@/components/parfait-logo";

import { focusRing, primaryCta, secondaryCta, navLink } from "@/components/public-site/styles";

/** Public navigation shared by the homepage and legal pages. `signedIn` swaps the Log in / Sign up
 * pair for a single "Open Parfait" action; the auth routes themselves are unchanged. */
export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="border-b border-white/70 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <Link
          href="/"
          aria-label="Parfait home"
          className={`flex items-center rounded-lg ${focusRing}`}
        >
          <ParfaitLogo height={32} decorative />
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
                Log in
              </Link>
              <Link href="/login" className={primaryCta}>
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

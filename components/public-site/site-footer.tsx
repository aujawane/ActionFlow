import Link from "next/link";

import { navLink } from "@/components/public-site/styles";
import { LEGAL_OPERATOR_NAME, SITE_NAME } from "@/lib/public-site";

export function SiteFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <footer className="border-t border-slate-200/80 bg-white/70">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          <span className="font-semibold text-slate-900">{SITE_NAME}</span> · AI-powered meeting
          execution workspace
        </p>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/privacy" className={navLink}>
            Privacy Policy
          </Link>
          <Link href="/terms" className={navLink}>
            Terms of Service
          </Link>
          <Link href={signedIn ? "/dashboard" : "/login"} className={navLink}>
            {signedIn ? "Open Parfait" : "Sign in"}
          </Link>
        </nav>
        <p className="text-slate-500">
          © {new Date().getFullYear()} {LEGAL_OPERATOR_NAME ?? SITE_NAME}
        </p>
      </div>
    </footer>
  );
}

import type { ReactNode } from "react";

import { SiteFooter } from "@/components/public-site/site-footer";
import { SiteHeader } from "@/components/public-site/site-header";
import { focusRing } from "@/components/public-site/styles";

/** Page chrome for every public page: skip link, header, <main id="main-content">, footer. */
export function SiteFrame({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className={`sr-only z-50 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 focus:not-sr-only focus:absolute focus:left-4 focus:top-4 ${focusRing}`}
      >
        Skip to content
      </a>
      <SiteHeader signedIn={signedIn} />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <SiteFooter signedIn={signedIn} />
    </div>
  );
}

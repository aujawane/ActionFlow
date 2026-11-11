import type { ReactNode } from "react";

import { SiteFrame } from "@/components/public-site/site-frame";
import { LegalSectionNav } from "@/components/public-site/legal-section-nav";
import { focusRing, navLink, textLink } from "@/components/public-site/styles";
import { LEGAL_CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE } from "@/lib/public-site";

export type LegalSectionContent = {
  id: string;
  title: string;
  /** Short text for the desktop contents list; the section heading itself always uses `title`. */
  navLabel?: string;
  body: ReactNode;
};

/** Contact line used by both legal documents. Renders a mailto link once LEGAL_CONTACT_EMAIL is
 * set in lib/public-site.ts; until then it says so plainly instead of inventing an address. */
export function ContactDetails({ topic }: { topic: string }) {
  if (LEGAL_CONTACT_EMAIL) {
    return (
      <p>
        For {topic}, email us at{" "}
        <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className={textLink}>
          {LEGAL_CONTACT_EMAIL}
        </a>
        .
      </p>
    );
  }
  return (
    <p>
      The contact address for {topic} is not yet published on this page. It will be added here
      before general availability.
    </p>
  );
}

export function LegalDocument({
  title,
  lead,
  sections,
  signedIn
}: {
  title: string;
  lead: ReactNode;
  sections: LegalSectionContent[];
  signedIn: boolean;
}) {
  return (
    <SiteFrame signedIn={signedIn}>
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,46rem)] lg:justify-center lg:gap-10">
          {/* Small screens: contents collapsed so the document itself starts on the first screen. */}
          <details className="premium-card px-5 py-3 lg:hidden">
            <summary
              className={`cursor-pointer rounded-md py-2 text-sm font-semibold text-slate-900 ${focusRing}`}
            >
              On this page
            </summary>
            <nav aria-label={`${title} sections`} className="mt-1 pb-2">
              <ol className="text-sm">
                {sections.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`} className={navLink}>
                      {section.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          </details>

          {/* Large screens: always-visible sticky contents with scrollspy. */}
          <LegalSectionNav
            title={title}
            items={sections.map((section) => ({
              id: section.id,
              label: section.navLabel ?? section.title
            }))}
          />

          <article className="premium-card min-w-0 p-6 sm:p-10">
            <header className="border-b border-slate-200 pb-6">
              <h1 className="text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
                {title}
              </h1>
              <p className="mt-2 text-sm text-slate-600">Effective date: {LEGAL_EFFECTIVE_DATE}</p>
              <div className="mt-5 space-y-3 text-base leading-7 text-slate-700">
                {lead}
              </div>
            </header>

            <div className="divide-y divide-slate-100">
              {sections.map((section) => (
                <section
                  key={section.id}
                  id={section.id}
                  aria-labelledby={`${section.id}-heading`}
                  className="scroll-mt-6 py-8"
                >
                  <h2
                    id={`${section.id}-heading`}
                    className="text-xl font-semibold tracking-tight text-slate-950"
                  >
                    {section.title}
                  </h2>
                  <div className="mt-3 space-y-3 text-base leading-7 text-slate-700 [&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-slate-950 [&_li]:pl-1 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
                    {section.body}
                  </div>
                </section>
              ))}
            </div>
          </article>
        </div>
      </div>
    </SiteFrame>
  );
}

import type { Metadata } from "next";

import { TermsOfService } from "@/components/public-site/terms-content";
import { isVisitorSignedIn } from "@/lib/public-site-session";
import { canonicalUrl, SITE_NAME, SOCIAL_IMAGE } from "@/lib/public-site";

const title = "Terms of Service | Parfait";
const description =
  "The terms for using Parfait, including your responsibilities when recording meetings and the limits of AI-generated output.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: canonicalUrl("/terms") },
  openGraph: { title, description, url: canonicalUrl("/terms"), siteName: SITE_NAME, type: "website", images: [SOCIAL_IMAGE] },
  twitter: { card: "summary_large_image", images: [SOCIAL_IMAGE.url] }
};

/** Public: no authentication is required to read the terms. */
export default async function TermsPage() {
  return <TermsOfService signedIn={await isVisitorSignedIn()} />;
}

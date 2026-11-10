import type { Metadata } from "next";

import { PrivacyPolicy } from "@/components/public-site/privacy-content";
import { isVisitorSignedIn } from "@/lib/public-site-session";
import { canonicalUrl, SITE_NAME } from "@/lib/public-site";

const title = "Privacy Policy | Parfait";
const description =
  "How Parfait collects, uses, stores and shares information, including Google Sign In and Google user data, meeting transcripts and AI processing.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: canonicalUrl("/privacy") },
  openGraph: { title, description, url: canonicalUrl("/privacy"), siteName: SITE_NAME, type: "website" }
};

/** Public: no authentication is required to read the privacy policy. */
export default async function PrivacyPage() {
  return <PrivacyPolicy signedIn={await isVisitorSignedIn()} />;
}

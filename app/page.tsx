import type { Metadata } from "next";

import { HomePage } from "@/components/public-site/home-page";
import { isVisitorSignedIn } from "@/lib/public-site-session";
import { canonicalUrl, SITE_NAME } from "@/lib/public-site";

const title = "Parfait | Turn meetings into action";
const description =
  "Parfait captures the commitments, tasks, decisions, and context that come out of your meetings, so your team knows what happens next.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: canonicalUrl("/") },
  openGraph: { title, description, url: canonicalUrl("/"), siteName: SITE_NAME, type: "website" }
};

/** Public homepage. Signed-out visitors see the product; signed-in users see "Open Parfait"
 * instead of the sign-in actions (they are never redirected away from this page). */
export default async function LandingPage() {
  return <HomePage signedIn={await isVisitorSignedIn()} />;
}

/**
 * Shared constants for Parfait's public pages (/, /privacy, /terms).
 *
 * DRAFT NOTICE (engineering note, intentionally not shown on the public pages): the Privacy
 * Policy and Terms of Service are product-ready drafts written from what the repository actually
 * does. They have NOT been reviewed by an attorney. Have counsel review them, and fill in the
 * null values below, before relying on them for Google OAuth verification or real users.
 */

export const SITE_URL = "https://parfait-app.com";
export const SITE_NAME = "Parfait";

/** Effective date shown on both legal pages. Update it whenever either document changes. */
export const LEGAL_EFFECTIVE_DATE = "November 10, 2026";

/**
 * Contact address for privacy requests, data deletion requests and legal questions, supplied by
 * the operator. If it is ever set back to null, the legal pages render a "not yet published"
 * notice instead of a mailto link.
 */
export const LEGAL_CONTACT_EMAIL: string | null = "support@parfait-app.com";

/**
 * Legal name of the company or person operating Parfait. NOT provided by the repository, so it is
 * deliberately null. While null, the documents refer to the operator simply as "Parfait".
 */
export const LEGAL_OPERATOR_NAME: string | null = null;

/** Pages that render without the authenticated application shell (sidebar, account menu). */
export const PUBLIC_SITE_PATHS = ["/", "/privacy", "/terms"] as const;

export function isPublicSitePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (PUBLIC_SITE_PATHS as readonly string[]).includes(normalized);
}

export function canonicalUrl(path: (typeof PUBLIC_SITE_PATHS)[number]): string {
  return path === "/" ? SITE_URL : `${SITE_URL}${path}`;
}

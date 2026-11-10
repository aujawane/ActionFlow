import { getCurrentUser } from "@/lib/auth";

/**
 * Whether the visitor has a Supabase session, used only to swap "Sign in / Get started" for
 * "Open Parfait" on the public pages. It is read-only, never redirects, and fails closed to
 * "signed out" so a public page can never be broken by an auth lookup problem.
 */
export async function isVisitorSignedIn(): Promise<boolean> {
  try {
    return Boolean(await getCurrentUser());
  } catch {
    return false;
  }
}

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ResetPasswordForm } from "@/components/reset-password-form";
import { getCurrentUser } from "@/lib/auth";
import { RECOVERY_COOKIE_NAME } from "@/lib/password-recovery";

export default async function ResetPasswordPage() {
  const [user, cookieStore] = await Promise.all([getCurrentUser(), cookies()]);
  if (!user || cookieStore.get(RECOVERY_COOKIE_NAME)?.value !== "active") {
    redirect("/forgot-password?error=recovery_session_required");
  }

  return <ResetPasswordForm />;
}

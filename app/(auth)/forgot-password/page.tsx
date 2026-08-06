import { redirect } from "next/navigation";

import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { getCurrentUser } from "@/lib/auth";
import { recoveryErrorMessage } from "@/lib/password-recovery";

export default async function ForgotPasswordPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  return <ForgotPasswordForm initialMessage={recoveryErrorMessage(params.error)} />;
}

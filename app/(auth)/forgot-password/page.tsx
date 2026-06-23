import { redirect } from "next/navigation";

import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { getCurrentUser } from "@/lib/auth";

export default async function ForgotPasswordPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  }

  return <ForgotPasswordForm />;
}

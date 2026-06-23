import { ResetPasswordForm } from "@/components/reset-password-form";
import { requireUser } from "@/lib/auth";

export default async function ResetPasswordPage() {
  await requireUser();

  return <ResetPasswordForm />;
}

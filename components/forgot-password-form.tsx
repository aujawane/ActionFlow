"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function ForgotPasswordForm() {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  const [step, setStep] = useState<"request" | "verify">("request");
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    if (step === "request") {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false }
      });
      setLoading(false);

      if (error) {
        setMessage(error.message);
        return;
      }

      setStep("verify");
      setMessage("Verification code sent to your email.");
      return;
    }

    if (newPassword.length < 8) {
      setLoading(false);
      setMessage("New password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setLoading(false);
      setMessage("New passwords do not match.");
      return;
    }

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: verificationCode.trim(),
      type: "email"
    });

    if (verifyError) {
      setLoading(false);
      setMessage(verifyError.message);
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword
    });
    setLoading(false);

    if (updateError) {
      setMessage(updateError.message);
      return;
    }

    setMessage("Password updated successfully. Redirecting to dashboard...");
    window.location.assign("/dashboard");
    router.refresh();
  }

  return (
    <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold text-slate-900">
        {step === "request" ? "Forgot password" : "Reset your password"}
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Enter your email to receive a verification code, then set a new password.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
        </div>

        {step === "verify" ? (
          <>
            <div className="space-y-1">
              <label
                className="text-sm font-medium text-slate-700"
                htmlFor="verification-code"
              >
                Verification Code
              </label>
              <input
                id="verification-code"
                type="text"
                required
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value)}
                placeholder="Enter the code from your email"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
            </div>
            <div className="space-y-1">
              <label
                className="text-sm font-medium text-slate-700"
                htmlFor="new-password"
              >
                New Password
              </label>
              <input
                id="new-password"
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
            </div>
            <div className="space-y-1">
              <label
                className="text-sm font-medium text-slate-700"
                htmlFor="confirm-new-password"
              >
                Confirm New Password
              </label>
              <input
                id="confirm-new-password"
                type="password"
                required
                minLength={8}
                value={confirmNewPassword}
                onChange={(event) => setConfirmNewPassword(event.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
            </div>
          </>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-70"
        >
          {loading
            ? "Please wait..."
            : step === "request"
              ? "Send Verification Code"
              : "Reset Password"}
        </button>
      </form>

      {message ? <p className="mt-3 text-sm text-slate-600">{message}</p> : null}

      <button
        type="button"
        className="mt-4 text-sm"
        onClick={() => window.location.assign("/login")}
      >
        Back to login
      </button>
    </div>
  );
}

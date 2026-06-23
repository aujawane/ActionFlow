"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type AccountSettingsClientProps = {
  userId: string;
  fullName: string;
  email: string;
  initials: string;
  createdAt: string;
  lastLoginAt: string;
  provider: string;
};

export function AccountSettingsClient({
  userId,
  fullName,
  email,
  initials,
  createdAt,
  lastLoginAt,
  provider
}: AccountSettingsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createSupabaseBrowserClient();
  const [name, setName] = useState(fullName);
  const [savingName, setSavingName] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get("changePassword") === "1") {
      setPasswordModalOpen(true);
    }
  }, [searchParams]);

  async function saveName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingName(true);
    setMessage(null);

    const { error } = await supabase
      .from("profiles")
      .update({ full_name: name.trim() || null })
      .eq("id", userId)
      .select("id")
      .single();

    setSavingName(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Profile updated.");
    router.refresh();
  }

  async function logSecurityEvent(eventType: string, metadata?: Record<string, unknown>) {
    await fetch("/api/account/security-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: eventType, metadata })
    }).catch(() => null);
  }

  async function requestCode() {
    setPasswordLoading(true);
    setPasswordMessage(null);

    const response = await fetch("/api/account/password-code", { method: "POST" });
    const result = (await response.json().catch(() => ({}))) as { error?: string; message?: string };

    setPasswordLoading(false);

    if (!response.ok) {
      setPasswordMessage(result.error || "Unable to send verification code.");
      return;
    }

    setCodeSent(true);
    setPasswordMessage(result.message || "Verification code sent to your email.");
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordLoading(true);
    setPasswordMessage(null);

    if (newPassword.length < 8) {
      setPasswordLoading(false);
      setPasswordMessage("New password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordLoading(false);
      setPasswordMessage("Passwords do not match.");
      return;
    }

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: verificationCode.trim(),
      type: "email"
    });

    if (verifyError) {
      await logSecurityEvent("password_change_failed", { reason: "otp_verification_failed" });
      setPasswordLoading(false);
      setPasswordMessage("Verification failed. Check the code and try again.");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });

    setPasswordLoading(false);

    if (updateError) {
      await logSecurityEvent("password_change_failed", { reason: "password_update_failed" });
      setPasswordMessage(updateError.message);
      return;
    }

    await logSecurityEvent("password_change_verified");
    setPasswordMessage("Password changed successfully.");
    setVerificationCode("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordModalOpen(false);
  }

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <section className="premium-card p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-600 text-xl font-semibold text-white shadow-lg shadow-brand-700/20">
                {initials}
              </div>
              <div>
                <h1 className="text-2xl font-semibold text-slate-900">Account Settings</h1>
                <p className="mt-1 text-sm text-slate-600">
                  Manage your profile information and secure sign-in settings.
                </p>
              </div>
            </div>
          </section>

          <section className="premium-card p-6">
            <h2 className="text-base font-semibold text-slate-900">Profile</h2>
            <form onSubmit={saveName} className="mt-5 space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-700" htmlFor="full-name">
                  Full Name
                </label>
                <input
                  id="full-name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  className="premium-input mt-1"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700" htmlFor="account-email">
                  Email Address
                </label>
                <input
                  id="account-email"
                  type="email"
                  value={email}
                  readOnly
                  autoComplete="email"
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-sm text-slate-600"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={savingName}
                  className="premium-button"
                >
                  {savingName ? "Saving..." : "Save Changes"}
                </button>
                {message ? <p className="text-sm text-slate-600">{message}</p> : null}
              </div>
            </form>
          </section>

          <section className="premium-card p-6">
            <h2 className="text-base font-semibold text-slate-900">Password & Security</h2>
            <p className="mt-2 text-sm text-slate-600">
              Passwords are never displayed or returned by the app. Verify your email before
              changing your password.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setPasswordModalOpen(true)}
                className="premium-button"
              >
                Change Password
              </button>
              <button
                type="button"
                onClick={() => setPasswordModalOpen(true)}
                className="secondary-button"
              >
                View Password
              </button>
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          {[
            ["Profile Initials", initials],
            ["Authentication Provider", provider],
            ["Account Creation Date", createdAt],
            ["Last Login Date", lastLoginAt]
          ].map(([label, value]) => (
            <div key={label} className="premium-card premium-card-hover p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-2 break-words text-sm font-medium text-slate-900">{value}</p>
            </div>
          ))}
        </aside>
      </div>

      {passwordModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="password-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-lg rounded-2xl border border-white/70 bg-white/95 p-6 shadow-2xl shadow-slate-900/20 backdrop-blur">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="password-modal-title" className="text-lg font-semibold text-slate-900">
                  Verify to Manage Password
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  We will send a one-time code to {email}. Passwords cannot be viewed, only changed.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPasswordModalOpen(false)}
                className="rounded-full px-2 py-1 text-slate-500 transition hover:bg-brand-50 hover:text-brand-800"
                aria-label="Close password modal"
              >
                x
              </button>
            </div>

            {!codeSent ? (
              <button
                type="button"
                onClick={requestCode}
                disabled={passwordLoading}
                className="premium-button mt-6 w-full py-2.5"
              >
                {passwordLoading ? "Sending..." : "Send Verification Code"}
              </button>
            ) : (
              <form onSubmit={changePassword} className="mt-6 space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-700" htmlFor="verification-code">
                    Verification Code
                  </label>
                  <input
                    id="verification-code"
                    type="text"
                    inputMode="numeric"
                    required
                    value={verificationCode}
                    onChange={(event) => setVerificationCode(event.target.value)}
                    autoComplete="one-time-code"
                    className="premium-input mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700" htmlFor="new-password">
                    New Password
                  </label>
                  <input
                    id="new-password"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    className="premium-input mt-1"
                  />
                </div>
                <div>
                  <label
                    className="text-sm font-medium text-slate-700"
                    htmlFor="confirm-password"
                  >
                    Confirm New Password
                  </label>
                  <input
                    id="confirm-password"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={8}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    className="premium-input mt-1"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={showPassword}
                    onChange={(event) => setShowPassword(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                  />
                  Show password while typing
                </label>
                <button
                  type="submit"
                  disabled={passwordLoading}
                  className="premium-button w-full py-2.5"
                >
                  {passwordLoading ? "Updating..." : "Update Password"}
                </button>
              </form>
            )}

            {passwordMessage ? <p className="mt-4 text-sm text-slate-600">{passwordMessage}</p> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

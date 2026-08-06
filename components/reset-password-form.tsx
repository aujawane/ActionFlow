"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { PASSWORD_MIN_LENGTH, validateNewPassword } from "@/lib/password-recovery";

export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submittingRef = useRef(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    setMessage(null);

    const validationError = validateNewPassword({ password, confirmPassword });
    if (validationError) {
      setLoading(false);
      submittingRef.current = false;
      setMessage(validationError);
      return;
    }

    let response: Response;
    let result: { error?: string; message?: string };
    try {
      response = await fetch("/api/auth/password-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirmPassword })
      });
      result = (await response.json().catch(() => ({}))) as typeof result;
    } catch {
      setLoading(false);
      submittingRef.current = false;
      setMessage("Unable to reach the server. Please try again.");
      return;
    }
    setLoading(false);
    submittingRef.current = false;

    if (!response.ok) {
      setMessage(result.error || "Unable to update the password.");
      return;
    }

    setMessage(result.message || "Password updated successfully. Redirecting...");
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="premium-card mx-auto w-full max-w-md p-6 sm:p-8">
      <h1 className="text-2xl font-semibold text-slate-900">Create a new password</h1>
      <p className="mt-1 text-sm text-slate-600">
        Choose a new password for your account. Your browser can save it after the update.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-slate-700" htmlFor="new-password">
            New Password
          </label>
          <input
            id="new-password"
            type={showPassword ? "text" : "password"}
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            className="premium-input"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-slate-700" htmlFor="confirm-new-password">
            Confirm New Password
          </label>
          <input
            id="confirm-new-password"
            type={showPassword ? "text" : "password"}
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            className="premium-input"
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
          disabled={loading}
          className="premium-button w-full py-2.5"
        >
          {loading ? "Updating..." : "Update Password"}
        </button>
      </form>

      {message ? (
        <p role="status" className="mt-4 rounded-xl border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-900">
          {message}
        </p>
      ) : null}
    </div>
  );
}

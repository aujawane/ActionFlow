"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  createPasswordChangeController,
  type PasswordChangeController,
  type PasswordChangeEvent
} from "@/lib/password-change";
import { PASSWORD_MIN_LENGTH } from "@/lib/password-recovery";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/** Best-effort audit trail. Sends event names and Supabase error codes only, never secrets. */
function logSecurityEvent(event: PasswordChangeEvent) {
  const metadata =
    event.type === "password_change_failed"
      ? { reason: event.reason }
      : event.type === "password_change_verified"
        ? { method: event.method }
        : undefined;
  void fetch("/api/account/security-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: event.type, metadata })
  }).catch(() => null);
}

/**
 * Signed-in Change Password dialog (Flow A). Tries updateUser({ password }) first and shows the
 * verification-code step only when Supabase answers reauthentication_needed. See
 * lib/password-change.ts for the flow and error handling.
 */
export function ChangePasswordDialog({
  email,
  onClose,
  controller: injectedController
}: {
  email: string;
  onClose: () => void;
  /** Tests inject a controller with a fake auth client; the app builds one from Supabase. */
  controller?: PasswordChangeController;
}) {
  const [controller] = useState(
    () =>
      injectedController ??
      createPasswordChangeController({
        auth: createSupabaseBrowserClient().auth,
        email,
        onEvent: logSecurityEvent
      })
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [showPassword, setShowPassword] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(() => controller.secondsUntilResend());

  // Tick the resend countdown only while a cooldown is active.
  useEffect(() => {
    setResendSeconds(controller.secondsUntilResend());
    if (state.resendAvailableAt === null) return;
    const timer = window.setInterval(() => {
      const remaining = controller.secondsUntilResend();
      setResendSeconds(remaining);
      if (remaining === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [controller, state.resendAvailableAt]);

  const busy = state.pending !== null;

  // Don't let the dialog vanish while Supabase may be applying the new password.
  const changing = state.pending === "update" || state.pending === "verify";

  function close() {
    if (changing) return;
    controller.reset();
    onClose();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const passwordFields = (
    <>
      <div>
        <label className="text-sm font-medium text-slate-700" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type={showPassword ? "text" : "password"}
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={state.newPassword}
          onChange={(event) => controller.setField("newPassword", event.target.value)}
          autoComplete="new-password"
          autoFocus={state.step === "enter-password"}
          disabled={busy}
          className="premium-input mt-1"
        />
        <p className="mt-1 text-xs text-slate-500">At least {PASSWORD_MIN_LENGTH} characters.</p>
      </div>
      <div>
        <label className="text-sm font-medium text-slate-700" htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          type={showPassword ? "text" : "password"}
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={state.confirmPassword}
          onChange={(event) => controller.setField("confirmPassword", event.target.value)}
          autoComplete="new-password"
          disabled={busy}
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
    </>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-white/70 bg-white/95 p-6 shadow-2xl shadow-slate-900/20 backdrop-blur">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="password-modal-title" className="text-lg font-semibold text-slate-900">
              Change password
            </h2>
            {state.step === "enter-password" ? (
              <p className="mt-1 text-sm text-slate-600">
                Choose a new password for {email}. If you haven&apos;t signed in recently, we&apos;ll
                ask you to confirm it&apos;s you with a code sent to that address.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={close}
            disabled={changing}
            className="rounded-full px-2 py-1 text-slate-500 transition hover:bg-brand-50 hover:text-brand-800 disabled:opacity-50"
            aria-label="Close password dialog"
          >
            x
          </button>
        </div>

        {state.notice ? (
          <p
            role="status"
            className="mt-4 rounded-xl border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-900"
          >
            {state.notice}
          </p>
        ) : null}

        {state.step === "enter-password" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void controller.submitPassword();
            }}
            className="mt-6 space-y-4"
          >
            {passwordFields}
            <button type="submit" disabled={busy} className="premium-button w-full py-2.5">
              {state.pending === "update"
                ? "Changing password..."
                : state.pending === "send"
                  ? "Sending verification code..."
                  : "Change password"}
            </button>
          </form>
        ) : null}

        {state.step === "enter-code" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void controller.submitCode();
            }}
            className="mt-6 space-y-4"
          >
            <div>
              <label className="text-sm font-medium text-slate-700" htmlFor="verification-code">
                Verification code
              </label>
              <input
                id="verification-code"
                type="text"
                inputMode="numeric"
                required
                value={state.verificationCode}
                onChange={(event) => controller.setField("verificationCode", event.target.value)}
                autoComplete="one-time-code"
                autoFocus
                disabled={busy}
                className="premium-input mt-1"
              />
              <p className="mt-1 text-xs text-slate-500">
                Check your inbox (and spam folder) for the code from Parfait.
              </p>
            </div>
            {passwordFields}
            <button type="submit" disabled={busy} className="premium-button w-full py-2.5">
              {state.pending === "verify" ? "Changing password..." : "Change password"}
            </button>
            <button
              type="button"
              onClick={() => void controller.resendCode()}
              disabled={busy || resendSeconds > 0}
              className="w-full text-sm font-semibold text-brand-700 transition hover:text-brand-900 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {state.pending === "resend"
                ? "Sending a new code..."
                : resendSeconds > 0
                  ? `Resend code in ${resendSeconds}s`
                  : "Resend code"}
            </button>
          </form>
        ) : null}

        {state.step === "done" ? (
          <button type="button" onClick={close} className="premium-button mt-6 w-full py-2.5">
            Done
          </button>
        ) : null}

        {state.error ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {state.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

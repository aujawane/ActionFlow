"use client";

import { useState } from "react";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    const response = await fetch("/api/auth/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const result = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    setLoading(false);

    if (!response.ok) {
      setMessage(result.error || "Unable to start password reset.");
      return;
    }

    setMessage(result.message || "Check your email for a secure reset link.");
  }

  return (
    <div className="premium-card mx-auto w-full max-w-md p-6 sm:p-8">
      <h1 className="text-2xl font-semibold text-slate-900">Reset your password</h1>
      <p className="mt-1 text-sm text-slate-600">
        Enter your email and we will send a secure reset link if an account exists.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-slate-700" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            className="premium-input"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="premium-button w-full py-2.5"
        >
          {loading ? "Sending..." : "Send Reset Link"}
        </button>
      </form>

      {message ? (
        <p role="status" className="mt-4 rounded-xl border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-900">
          {message}
        </p>
      ) : null}

      <button
        type="button"
        className="mt-5 text-sm font-semibold text-brand-700 transition hover:text-brand-900"
        onClick={() => window.location.assign("/login")}
      >
        Back to sign in
      </button>
    </div>
  );
}

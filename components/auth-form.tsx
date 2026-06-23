"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createSupabaseBrowserClient();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    const action =
      mode === "login"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({
            email,
            password,
            options: {
              data: { full_name: fullName.trim() || undefined },
              emailRedirectTo: `${window.location.origin}/api/auth/callback`
            }
          });

    const { error } = await action;
    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(
      mode === "login"
        ? "Logged in successfully."
        : "Signup successful. Check your inbox if email confirmation is enabled."
    );

    if (mode === "login") {
      const nextPath = searchParams.get("next") || "/dashboard";
      window.location.assign(nextPath);
      router.refresh();
    }
  }

  async function continueWithGoogle() {
    setLoading(true);
    setMessage(null);

    const nextPath = searchParams.get("next") || "/dashboard";
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(
          nextPath
        )}`
      }
    });

    if (error) {
      setLoading(false);
      setMessage(error.message);
    }
  }

  return (
    <div className="mx-auto grid min-h-[calc(100vh-9rem)] w-full max-w-5xl items-center gap-8 lg:grid-cols-[1fr_28rem]">
      <section className="hidden overflow-hidden rounded-3xl bg-slate-950 p-8 text-white shadow-2xl shadow-slate-900/20 lg:block">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand-200">Parfait</p>
        <h1 className="mt-6 text-4xl font-semibold leading-tight">
          Turn meeting conversations into implementation-ready work.
        </h1>
        <p className="mt-4 text-sm leading-6 text-slate-300">
          Sign in to manage transcripts, product insights, and generated prompts from one secure
          workspace.
        </p>
        <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-200">
            Premium workflow
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Capture, analyze, and convert every decision into clear execution context.
          </p>
        </div>
      </section>

      <div className="premium-card p-6 sm:p-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {mode === "login" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {mode === "login"
              ? "Sign in with your saved credentials or Google account."
              : "Use a secure password so your browser can save it for next time."}
          </p>
        </div>

        <button
          type="button"
          onClick={continueWithGoogle}
          disabled={loading}
          className="secondary-button mt-6 w-full gap-2"
        >
          <span aria-hidden="true">G</span>
          Continue with Google
        </button>

        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-200" />
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">or</span>
          <div className="h-px flex-1 bg-slate-200" />
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          {mode === "signup" ? (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700" htmlFor="full-name">
                Full Name
              </label>
              <input
                id="full-name"
                type="text"
                required
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                autoComplete="name"
                className="premium-input"
              />
            </div>
          ) : null}
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
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-700" htmlFor="password">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                className="premium-input pr-16"
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 transition hover:bg-brand-50 hover:text-brand-800"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {mode === "login" ? (
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(event) => setRememberMe(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                />
                Remember me
              </label>
              <Link href="/forgot-password" className="text-sm font-medium text-brand-700">
                Forgot Password?
              </Link>
            </div>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="premium-button w-full py-2.5"
          >
            {loading
              ? "Please wait..."
              : mode === "login"
                ? "Sign In"
                : "Create Account"}
          </button>

          {!rememberMe && mode === "login" ? (
            <p className="text-xs text-slate-500">
              Your browser may still offer to save credentials. Supabase sessions are cookie-based.
            </p>
          ) : null}
        </form>

        {message ? (
          <p
            role={message.toLowerCase().includes("success") ? "status" : "alert"}
            className="mt-4 rounded-xl border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-900"
          >
            {message}
          </p>
        ) : null}

        <div className="mt-6 text-center text-sm text-slate-600">
          {mode === "login" ? "Need an account?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="font-semibold text-brand-700 transition hover:text-brand-900"
            onClick={() => {
              setMode((prev) => (prev === "login" ? "signup" : "login"));
              setMessage(null);
            }}
          >
            {mode === "login" ? "Sign Up" : "Sign In"}
          </button>
        </div>
      </div>
    </div>
  );
}

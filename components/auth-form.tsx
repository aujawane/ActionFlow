"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createSupabaseBrowserClient();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    const action =
      mode === "login"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });

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

  return (
    <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold text-slate-900">
        {mode === "login" ? "Login" : "Create your account"}
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Use Supabase Auth with email/password for MVP access.
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
        <div className="space-y-1">
          <label
            className="text-sm font-medium text-slate-700"
            htmlFor="password"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-70"
        >
          {loading
            ? "Please wait..."
            : mode === "login"
              ? "Login"
              : "Create Account"}
        </button>
      </form>

      {message ? <p className="mt-3 text-sm text-slate-600">{message}</p> : null}

      <button
        type="button"
        className="mt-4 text-sm"
        onClick={() => setMode((prev) => (prev === "login" ? "signup" : "login"))}
      >
        {mode === "login"
          ? "Need an account? Sign up"
          : "Already have an account? Login"}
      </button>
    </div>
  );
}

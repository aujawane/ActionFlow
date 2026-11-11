"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ChangePasswordDialog } from "@/components/change-password-dialog";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type AccountSettingsClientProps = {
  userId: string;
  fullName: string;
  email: string;
  initials: string;
  createdAt: string;
  lastLoginAt: string;
  provider: string;
  /** False for Google-only accounts, which have no Parfait password to change. */
  canChangePassword: boolean;
};

export function AccountSettingsClient({
  userId,
  fullName,
  email,
  initials,
  createdAt,
  lastLoginAt,
  provider,
  canChangePassword
}: AccountSettingsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createSupabaseBrowserClient();
  const [name, setName] = useState(fullName);
  const [savingName, setSavingName] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);

  useEffect(() => {
    if (canChangePassword && searchParams.get("changePassword") === "1") {
      setPasswordModalOpen(true);
    }
  }, [canChangePassword, searchParams]);

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
            {canChangePassword ? (
              <>
                <p className="mt-2 text-sm text-slate-600">
                  Passwords are never displayed or returned by the app. If you haven&apos;t signed
                  in recently, changing yours requires a code sent to your email.
                </p>
                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setPasswordModalOpen(true)}
                    className="premium-button"
                  >
                    Change Password
                  </button>
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-600">
                You sign in with Google, so there is no Parfait password on this account. Manage
                your sign-in security in your Google Account.
              </p>
            )}
          </section>
        </div>

        <aside className="premium-card divide-y divide-slate-100 p-0">
          {[
            ["Profile Initials", initials],
            ["Authentication Provider", provider],
            ["Account Creation Date", createdAt],
            ["Last Login Date", lastLoginAt]
          ].map(([label, value]) => (
            <div key={label} className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1.5 break-words text-sm font-medium text-slate-900">{value}</p>
            </div>
          ))}
          <div className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Legal</p>
            <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
              <Link href="/privacy" className="text-brand-800 underline underline-offset-2">
                Privacy Policy
              </Link>
              <Link href="/terms" className="text-brand-800 underline underline-offset-2">
                Terms of Service
              </Link>
            </p>
          </div>
        </aside>
      </div>

      {passwordModalOpen && canChangePassword ? (
        <ChangePasswordDialog email={email} onClose={() => setPasswordModalOpen(false)} />
      ) : null}
    </>
  );
}

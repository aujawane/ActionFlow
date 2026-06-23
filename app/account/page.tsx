import { Suspense } from "react";

import { AccountSettingsClient } from "@/components/account-settings-client";
import { requireUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getAuthProvider, getInitials, getUserFullName } from "@/lib/user-profile";

function formatAccountDate(value?: string | null) {
  if (!value) {
    return "Not available";
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export default async function AccountPage() {
  const user = await requireUser();

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("full_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  const fullName = getUserFullName(user, profile);
  const email = user.email ?? "No email on file";
  const initials = getInitials(fullName || email);

  return (
    <Suspense fallback={<AccountSettingsSkeleton />}>
      <AccountSettingsClient
        userId={user.id}
        fullName={fullName}
        email={email}
        initials={initials}
        createdAt={formatAccountDate(user.created_at)}
        lastLoginAt={formatAccountDate(user.last_sign_in_at)}
        provider={getAuthProvider(user)}
      />
    </Suspense>
  );
}

function AccountSettingsSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <div className="h-32 animate-pulse rounded-2xl bg-slate-200" />
        <div className="h-80 animate-pulse rounded-2xl bg-slate-200" />
      </div>
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
      </div>
    </div>
  );
}

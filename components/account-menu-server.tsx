import { AccountMenu } from "@/components/account-menu";
import { getCurrentUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getInitials, getUserFullName } from "@/lib/user-profile";

export async function AccountMenuServer() {
  const user = await getCurrentUser();
  if (!user?.email) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  const fullName = getUserFullName(user, profile);

  return (
    <AccountMenu
      fullName={fullName}
      email={user.email}
      initials={getInitials(fullName || user.email)}
    />
  );
}

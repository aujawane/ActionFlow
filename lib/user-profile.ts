import type { User } from "@supabase/supabase-js";

type ProfileLike = {
  full_name?: string | null;
  avatar_url?: string | null;
} | null;

export function getUserFullName(user: User, profile?: ProfileLike) {
  const metadataName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name
      : typeof user.user_metadata?.name === "string"
        ? user.user_metadata.name
        : null;

  return profile?.full_name || metadataName || user.email?.split("@")[0] || "there";
}

export function getFirstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] || "there";
}

export function getInitials(nameOrEmail: string) {
  const normalized = nameOrEmail.trim();
  if (!normalized) {
    return "U";
  }

  const source = normalized.includes("@") ? normalized.split("@")[0] : normalized;
  const parts = source
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return source.slice(0, 2).toUpperCase();
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function getAuthProvider(user: User) {
  const provider =
    user.app_metadata?.provider ||
    user.identities?.[0]?.provider ||
    "email";

  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

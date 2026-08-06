import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { recoveryErrorPath } from "@/lib/password-recovery";

export function authRedirectFor(input: {
  pathname: string;
  hasUser: boolean;
}): string | null {
  const isResetPassword = input.pathname === "/account/reset-password";
  const isProtectedRoute =
    input.pathname.startsWith("/dashboard") ||
    input.pathname.startsWith("/meetings") ||
    input.pathname.startsWith("/tasks") ||
    input.pathname.startsWith("/account");
  const isAuthRoute =
    input.pathname.startsWith("/login") ||
    input.pathname.startsWith("/forgot-password");

  if (!input.hasUser && isResetPassword) {
    return recoveryErrorPath("recovery_session_required");
  }
  if (!input.hasUser && isProtectedRoute) return "/login";
  if (input.hasUser && isAuthRoute) return "/dashboard";
  return null;
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || "",
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: Array<{
            name: string;
            value: string;
            options: CookieOptions;
          }>
        ) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({
            request
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        }
      }
    }
  );

  const {
    data: { user }
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const authRedirect = authRedirectFor({ pathname, hasUser: Boolean(user) });
  if (authRedirect) {
    const redirectUrl = request.nextUrl.clone();
    const destination = new URL(authRedirect, request.url);
    redirectUrl.pathname = destination.pathname;
    redirectUrl.search = destination.search;
    if (destination.pathname === "/login") {
      redirectUrl.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}

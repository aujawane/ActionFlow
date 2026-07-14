import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { createGoogleOAuthUrl } from "@/lib/google-integration";

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  try {
    return NextResponse.redirect(createGoogleOAuthUrl(auth.user.id));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Google OAuth is not configured.";
    return NextResponse.json(
      { error: "Google OAuth is not configured.", details: message },
      { status: 500 }
    );
  }
}

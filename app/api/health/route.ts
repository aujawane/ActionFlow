import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight readiness probe for Vercel and uptime monitors.
 * Does not touch secrets or external providers.
 */
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "parfait",
      timestamp: new Date().toISOString()
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}

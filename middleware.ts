import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Workflow SDK's internal dispatch path (.well-known/workflow/*) must bypass this middleware --
  // intercepting it breaks step resumption. See node_modules/workflow/docs/getting-started/next.mdx.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|\\.well-known/workflow/).*)"]
};

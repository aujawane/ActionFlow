import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { handleTranscriptImport } from "@/lib/transcript-import/http";
import { supabaseTranscriptImportDeps } from "@/lib/transcript-import/supabase-deps";

export const runtime = "nodejs";
// Parsing is fast; the time goes to the transactional segment save and the queue claim. The
// import claim's staleness window (IMPORT_CLAIM_STALE_AFTER_MS) is set well above this.
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleTranscriptImport(request, {
    requireUser: requireApiUser,
    importDeps: supabaseTranscriptImportDeps,
    onImported: (meeting) => {
      revalidatePath("/dashboard");
      revalidatePath(`/meetings/${meeting.id}`);
      if (meeting.project_id) revalidatePath(`/projects/${meeting.project_id}`);
    }
  });
}

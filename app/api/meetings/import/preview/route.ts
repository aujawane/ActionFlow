import { requireApiUser } from "@/lib/api-auth";
import { handleTranscriptPreview } from "@/lib/transcript-import/http";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Parses an upload or paste and describes the result. Never creates a meeting, saves segments,
 * queues analysis or calls a model. */
export async function POST(request: Request) {
  return handleTranscriptPreview(request, { requireUser: requireApiUser });
}

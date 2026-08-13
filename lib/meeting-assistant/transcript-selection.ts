import { applySpeakerAliases } from "@/lib/speaker-aliases";
import { canonicalTranscriptOrder } from "@/lib/transcript-order";
import type { MeetingSpeakerAlias, TranscriptSegment } from "@/lib/types";

/** Context routing (see brief section 7): a single deterministic decision -- does this message
 * plausibly need transcript evidence at all? Everything else (execution graph, people,
 * deliverables) is cheap and structured, so it is always included; transcript retrieval is the
 * one genuinely expensive piece (a meeting can have hundreds of segments), so it is the one thing
 * gated. Intentionally simple pattern matching, not a second LLM call and not a classifier
 * framework -- "who owns what" never needs to reach this, "what did Craig say about pricing"
 * always does. */
const TRANSCRIPT_SIGNAL_PATTERNS: RegExp[] = [
  /\bsaid\b/,
  /\bsay\b/,
  /\bsays\b/,
  /\bmention(ed|s)?\b/,
  /\bdiscuss(ed|ion)?\b/,
  /\btalk(ed)?\s+about\b/,
  /\bquote/,
  /\bexact(ly)?\b/,
  /\bword[\s-]for[\s-]word\b/,
  /\bin\s+(the|this|that)\s+meeting\b/,
  /\bwhat\s+did\b/,
  /\bwhy\s+did\b/,
  /\bwhy\s+does\b/,
  /\bbring\s+up\b/,
  /\braised\b/,
  /\bbrought\s+up\b/
];

export function shouldIncludeTranscriptEvidence(message: string): boolean {
  const normalized = message.toLowerCase();
  return TRANSCRIPT_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "did", "does", "do", "what", "who", "when",
  "where", "why", "how", "to", "of", "in", "on", "at", "for", "and", "or", "about", "that",
  "this", "we", "i", "you", "he", "she", "they", "it", "his", "her", "their", "our", "your",
  "my", "have", "has", "had", "with", "not", "us", "me", "be", "will", "would", "can", "could"
]);

function significantWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9']+/g)
      ?.filter((word) => word.length > 2 && !STOPWORDS.has(word)) ?? []
  );
}

/** Keyword-overlap scoring, no vector database (see brief section 25) -- a segment scores one
 * point per significant message word it contains, plus a large boost when its resolved speaker
 * is named in the message ("what did Craig say" should prioritize Craig's segments). Deterministic
 * and independently testable without any network call. */
export function scoreTranscriptSegments(
  segments: TranscriptSegment[],
  message: string,
  limit = 15
): TranscriptSegment[] {
  if (segments.length === 0) return [];
  const words = significantWords(message);

  const scored = segments.map((segment) => {
    const text = (segment.text ?? "").toLowerCase();
    let score = 0;
    for (const word of words) {
      if (text.includes(word)) score += 1;
    }
    // Boost on a first- or last-name match, not just the full resolved name as one substring --
    // "What did Craig say" should boost "Craig Lauer"'s segments even though the message never
    // says "Craig Lauer" in full.
    const speaker = (segment.speaker ?? "").toLowerCase().trim();
    const speakerNameParts = speaker.split(/\s+/).filter((part) => part.length > 1);
    const speakerMentioned =
      speaker !== "" &&
      speaker !== "unknown speaker" &&
      speakerNameParts.some((part) => words.includes(part));
    if (speakerMentioned) {
      score += 5;
    }
    return { segment, score };
  });

  const relevant = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Nothing scored -- the routing layer still decided evidence was needed (e.g. "what did we
  // discuss" with no distinctive keywords), so fall back to a small chronological sample rather
  // than sending zero evidence. The assistant can still correctly say it found nothing specific.
  const chosen = relevant.length > 0 ? relevant : scored.slice(0, Math.min(limit, 10));

  const chosenIds = new Set(chosen.map((item) => item.segment.id));
  // Sort chronologically by timestamp so the excerpt reads coherently rather than by relevance
  // rank -- independent of the order `segments` was passed in, so this holds regardless of
  // whether the caller already pre-sorted it.
  return segments
    .filter((segment) => chosenIds.has(segment.id))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

export async function selectRelevantTranscriptSegments(input: {
  meetingId: string;
  message: string;
  limit?: number;
}): Promise<{ segments: TranscriptSegment[]; error: { message: string } | null }> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const [{ data: segmentRows, error: segmentsError }, { data: aliasRows }] = await Promise.all([
    supabaseAdmin
      .from("transcript_segments")
      .select("*")
      .eq("meeting_id", input.meetingId)
      .order("timestamp", { ascending: true }),
    supabaseAdmin.from("meeting_speaker_aliases").select("*").eq("meeting_id", input.meetingId)
  ]);
  if (segmentsError) {
    return { segments: [], error: segmentsError };
  }

  const resolved = applySpeakerAliases(
    canonicalTranscriptOrder((segmentRows ?? []) as TranscriptSegment[]),
    (aliasRows ?? []) as MeetingSpeakerAlias[]
  );
  return { segments: scoreTranscriptSegments(resolved, input.message, input.limit ?? 15), error: null };
}

/** Shared response-shape instructions for any Parfait chat agent that adopts the structured
 * response contract (lib/parfait-response/schema.ts). Append this to a surface's existing system
 * prompt -- it governs HOW an answer is structured, not domain rules about what the assistant is
 * allowed to know or do, which stay in each surface's own prompt. Not appended to every AI
 * surface in the app: Meeting Assistant, Project Brain, and the commitment correction assistant
 * each have a specialized response envelope already (generated content / typed change proposals
 * / field-diff proposals) that this generic Q&A shape would conflict with, not improve -- see the
 * rollout notes in the PR description for which surfaces use this and why. */
export const PARFAIT_RESPONSE_INSTRUCTIONS = [
  "Answer the user's question directly in the first sentence. Do not preface it with phrases",
  "like 'Based on the transcript' or 'It appears that' -- just answer.",
  "",
  "Return the minimum structure necessary to make the answer clear. A simple factual question",
  "(e.g. 'who owns this?') needs only `answer`, with an empty `sections` array -- do not invent",
  "sections to fill out the response. A casual or opinion question deserves a normal",
  "conversational `answer` and nothing else.",
  "",
  "Available optional section types: evidence, blocker, next_action, decision, list, warning.",
  "Only include a section when it adds information the answer alone doesn't already convey --",
  "never repeat the same fact across `answer` and a section, or across multiple sections.",
  "",
  "Keep sections concise: evidence is one highly relevant excerpt, blocker is one concise",
  "statement, next_action is one actionable statement, lists are short unless the question",
  "genuinely requires more detail.",
  "",
  "Never fabricate evidence or quotations. Only use an `evidence` section when you were given",
  "actual transcript/meeting content to cite -- if none is available, omit it rather than",
  "inventing one, and include its `source` (meetingId/segmentId/speaker/timestamp) only when you",
  "were actually given those identifiers.",
  "",
  "Do not generate Markdown headings, raw HTML, CSS, colors, icons, or any other presentation",
  "instructions -- write plain sentences. Formatting is applied by the application, not you.",
  "",
  "Optionally suggest up to 3 short, contextual follow-up questions in `followUps` -- only when a",
  "natural next question genuinely exists, never as a default habit."
].join("\n");

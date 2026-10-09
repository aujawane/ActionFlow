/**
 * Deterministic, server-side gate on the CURRENT user message -- generalized from
 * lib/project-brain/direct-commitment-edit.ts's hasExplicitCommitmentMutationIntent (entity
 * scoping removed; this never knew about commitments specifically in the first place, it only
 * ever inspected raw message text). The model's own operation output and self-reported
 * confidence are never trusted as proof of explicit intent; this inspects the actual text the
 * user just sent, independent of what any chat surface's agent produced.
 *
 * Deliberately narrow: a mutation verb appearing anywhere is NOT sufficient ("Do you think I
 * should change the deadline?" contains "change" but must not execute) -- a verb only counts
 * when it appears in a request-shaped position (sentence-initial imperative, "please "/"can
 * you "/"could you "/"I'd like you to "/"I want you to " immediately before it), AND no
 * discussion/hypothetical/recommendation phrase is present anywhere in the message. Polite
 * question forms ("Can you...?", "Could you...?") are explicit requests despite the question
 * mark -- grammatical mood is not the signal here, the request framing is.
 */

const MUTATION_VERBS =
  "change|set|make|rename|update|move|assign|mark|complete|reopen|edit|create|add|delete|remove|dismiss|accept";

/** Sentence-initial imperative, optionally after "please": "Change the due date...",
 * "Please make Kevin the owner.", "Delete the old landing-page commitment." */
const IMPERATIVE_REQUEST = new RegExp(`^(please\\s+)?(${MUTATION_VERBS})\\b`);

/** Polite request framing immediately before the verb: "Can you change...", "Could you
 * update...". Grammatically a question, but an explicit request. */
const POLITE_REQUEST = new RegExp(
  `\\b(can|could)\\s+you\\s+(please\\s+)?(${MUTATION_VERBS})\\b`
);

/** "I'd like you to rename this." / "I want you to mark it complete." */
const FIRST_PERSON_REQUEST = new RegExp(
  `\\bi(?:'d| would)\\s+like you to\\s+(${MUTATION_VERBS})\\b|\\bi want you to\\s+(${MUTATION_VERBS})\\b`
);

const POSITIVE_REQUEST_PATTERNS = [IMPERATIVE_REQUEST, POLITE_REQUEST, FIRST_PERSON_REQUEST];

/** Discussion, speculation, recommendation-seeking, or hypothetical framing. Checked BEFORE the
 * positive patterns above and, if matched, overrides them -- "Do you think I should change the
 * deadline?" contains the mutation verb "change" but is asking for an opinion, not requesting an
 * edit, so a block match here must win even though a positive pattern would also match. */
const NON_EXECUTION_PATTERNS = [
  /\bdo you think\b/,
  /\bi think\b/,
  /\bi wonder\b/,
  /\bshould\b/, // covers "should I", "should we", "should <name>" -- no explicit-request phrasing uses it
  /\bwhat if\b/,
  /\bwould it\b/,
  /\bcould it be\b/,
  /\bwould you recommend\b/,
  /\brecommend\b/,
  /\bwhat would happen\b/,
  /\bis it better\b/,
  /\bmaybe\b/
];

function normalizeMessage(message: string) {
  return message.trim().toLowerCase();
}

/**
 * The second of the two conditions direct execution requires (the first being operation-shape
 * eligibility -- see lib/workspace-agent/executor.ts). Entity-agnostic by design: works
 * identically whether the message came from Project Brain, Meeting Assistant, Commitment Chat,
 * or Task Chat, since it only ever looks at the message string itself.
 */
export function hasExplicitWorkspaceMutationIntent(userMessage: string): boolean {
  const message = normalizeMessage(userMessage);
  if (NON_EXECUTION_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }
  return POSITIVE_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Scrollspy rule for the legal-page "On this page" navigation. Pure and deterministic so it can be
 * tested without a browser: the same positions always give the same answer, whichever direction the
 * user scrolled from, so the highlight cannot flicker or depend on scroll history.
 */

/** Distance from the top of the viewport at which a section counts as "being read". */
export const SCROLLSPY_ACTIVATION_OFFSET_PX = 140;

export type SectionPosition = {
  id: string;
  /** The section's top edge relative to the viewport (element.getBoundingClientRect().top). */
  top: number;
};

/**
 * Active section = the last section whose top edge has reached the activation line.
 *  - Above the first section (title/intro): the first section is active.
 *  - At the bottom of the page: the last section is active, even if it is too short to ever reach
 *    the activation line.
 * `sections` must be in document order.
 */
export function resolveActiveSectionId(input: {
  sections: readonly SectionPosition[];
  atBottom: boolean;
  activationOffset?: number;
}): string | null {
  const { sections, atBottom, activationOffset = SCROLLSPY_ACTIVATION_OFFSET_PX } = input;
  if (sections.length === 0) return null;
  if (atBottom) return sections[sections.length - 1].id;

  let active = sections[0].id;
  for (const section of sections) {
    if (section.top <= activationOffset) active = section.id;
    else break;
  }
  return active;
}

/** True when the viewport bottom has reached the end of the document (1px tolerance for rounding). */
export function isScrolledToBottom(input: {
  scrollY: number;
  viewportHeight: number;
  documentHeight: number;
}): boolean {
  return input.scrollY + input.viewportHeight >= input.documentHeight - 1;
}

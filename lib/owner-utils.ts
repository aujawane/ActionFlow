/** Server-safe owner/person comparison utilities. Deliberately has no "use client" directive, no
 * React import, and no browser API -- this module is imported by both server code (API routes,
 * lib/commitment-correction/*, lib/commitment-people.ts) and client components
 * (components/task-owner-select.tsx, components/task-correction-menu.tsx). Keeping it here (not
 * in a "use client" component file) is what makes that dual use legal -- Next.js's server/client
 * module boundary rejects importing a function from a "use client" module into server code, even
 * when the function itself is pure and framework-free. */

/** Case/whitespace-insensitive "is this actually a different owner" check -- used to reject a
 * meaningless correction (current owner reselected, or Unassigned reselected when already
 * Unassigned) before a mutation is ever attempted. Entity-agnostic: task owner, commitment owner,
 * and commitment supporting-person corrections all share this one definition of "changed". */
export function isSameOwnerValue(a: string | null, b: string | null): boolean {
  const normalize = (value: string | null) => value?.trim().toLowerCase() || null;
  return normalize(a) === normalize(b);
}

import { revalidatePath } from "next/cache";

import type { TouchedEntity } from "./executor";

/**
 * Shared Next.js cache-invalidation step for whatever the shared executor touched -- generalizes
 * the per-entity revalidatePath fan-out already duplicated across
 * app/api/projects/[id]/brain/route.ts and app/api/projects/[id]/brain/proposals/[proposalId]/
 * apply/route.ts. Infrastructure only in Patch 1B: no chat route calls this yet (none are wired
 * to the shared executor). A later migration patch calls this once after a successful
 * executeWorkspaceOperations() instead of hand-rolling its own revalidatePath calls.
 */
export function revalidateWorkspaceEntities(touched: TouchedEntity[]): void {
  const paths = new Set<string>();
  for (const entity of touched) {
    if (entity.kind === "commitment") {
      paths.add(`/commitments/${entity.id}`);
      paths.add(`/meetings/${entity.meetingId}`);
    } else if (entity.kind === "task") {
      paths.add(`/tasks/${entity.id}`);
      if (entity.commitmentId) paths.add(`/commitments/${entity.commitmentId}`);
      paths.add(`/meetings/${entity.meetingId}`);
    } else {
      paths.add(`/projects/${entity.id}`);
      paths.add("/projects");
      paths.add("/dashboard");
    }
  }
  for (const path of paths) revalidatePath(path);
}

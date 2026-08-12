import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";

import { DeliverableFocusedView } from "@/components/deliverable-focused-view";
import { requireUser } from "@/lib/auth";
import { formatReadableDate } from "@/lib/format-date";
import { getOwnedArtifact } from "@/lib/project-access";
import { groupDeliverablesByType } from "@/lib/task-deliverable-lifecycle";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingCommitment, Project, TaskArtifact } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DeliverablePage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const owned = await getOwnedArtifact(id, user.id);
  if (!owned) notFound();
  const { artifact, task } = owned;

  const [{ data: siblingVersions }, commitmentResult, projectResult] = await Promise.all([
    supabaseAdmin
      .from("task_artifacts")
      .select("*")
      .eq("task_id", task.id)
      .eq("deliverable_type", artifact.deliverable_type ?? artifact.artifact_type)
      .order("version", { ascending: false }),
    task.commitment_id
      ? supabaseAdmin
          .from("meeting_commitments")
          .select("id, title")
          .eq("id", task.commitment_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    task.project_id
      ? supabaseAdmin.from("projects").select("id, name").eq("id", task.project_id).maybeSingle()
      : Promise.resolve({ data: null })
  ]);

  const versions = (siblingVersions ?? []) as TaskArtifact[];
  const group = groupDeliverablesByType(versions)[0] ?? {
    deliverableType: artifact.deliverable_type ?? artifact.artifact_type,
    current: artifact,
    latestFailed: null,
    history: [artifact]
  };
  const commitment = commitmentResult.data as Pick<MeetingCommitment, "id" | "title"> | null;
  const project = projectResult.data as Pick<Project, "id" | "name"> | null;

  return (
    <section className="space-y-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href={"/projects" as Route} className="hover:text-brand-700">
          Projects
        </Link>
        {project ? (
          <>
            <span>/</span>
            <Link href={`/projects/${project.id}` as Route} className="hover:text-brand-700">
              {project.name}
            </Link>
          </>
        ) : null}
        <span>/</span>
        <Link href={`/tasks/${task.id}` as Route} className="hover:text-brand-700">
          {task.task}
        </Link>
        <span>/</span>
        <span className="text-slate-900">{artifact.title}</span>
      </nav>

      <DeliverableFocusedView
        initialArtifact={artifact}
        task={task}
        commitment={commitment}
        history={group.history}
        currentVersionId={group.current?.id ?? artifact.id}
        generatedLabel={formatReadableDate(artifact.created_at)}
      />
    </section>
  );
}

import { ProjectLibrary } from "@/components/project-library";
import { requireUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Project } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const user = await requireUser();
  const { data: projects } = await supabaseAdmin
    .from("projects")
    .select("*")
    .eq("owner_id", user.id)
    .order("updated_at", { ascending: false });

  return (
    <section className="space-y-6">
      <header className="premium-card p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          Primary Execution
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
          Projects
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Move initiatives forward through milestones, tasks, and deliverables.
          Meetings remain linked as evidence.
        </p>
      </header>
      <ProjectLibrary initialProjects={(projects ?? []) as Project[]} />
    </section>
  );
}

import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import {
  generateTaskPrompt,
  getTaskWorkspaceContext,
  supportsTaskPrompt
} from "@/lib/task-workspace";

/**
 * Vercel plan assumption: Pro. Prompt generation is a single OpenAI call.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OpenAI API key is not configured." }, { status: 500 });
  }

  const { id } = await context.params;
  const workspaceContext = await getTaskWorkspaceContext(id, auth.user.id);
  if (!workspaceContext.ok) {
    return NextResponse.json(
      { error: workspaceContext.error, details: workspaceContext.details },
      { status: workspaceContext.status }
    );
  }

  if (!supportsTaskPrompt(workspaceContext.context.task.workspace_type)) {
    return NextResponse.json(
      { error: "Prompt generation is not available for this task workspace type." },
      { status: 400 }
    );
  }

  const result = await generateTaskPrompt(workspaceContext.context);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, details: result.details },
      { status: 502 }
    );
  }

  return NextResponse.json({ taskPrompt: result.taskPrompt });
}

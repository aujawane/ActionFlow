import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import {
  RecallTranscriptFetchError,
  fetchRecallTranscriptWithDiagnostics
} from "@/lib/recall/transcript";
import { supabaseAdmin } from "@/lib/supabase/admin";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function getTranscriptEntries(payload: unknown) {
  if (Array.isArray(payload)) return payload;

  const object = asObject(payload);
  if (!object) return [];
  for (const key of ["segments", "transcript", "utterances", "results"] as const) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }

  const data = asObject(object.data);
  if (!data) return [];
  for (const key of ["segments", "transcript", "utterances", "results"] as const) {
    if (Array.isArray(data[key])) return data[key] as unknown[];
  }
  return [];
}

function getResponseShape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      itemShape:
        value.length > 0 && depth < 4
          ? getResponseShape(value[0], depth + 1)
          : null
    };
  }
  if (typeof value !== "object") return typeof value;

  const object = value as JsonObject;
  const keys = Object.keys(object).sort();
  return {
    type: "object",
    keys,
    fields:
      depth < 4
        ? Object.fromEntries(
            keys.map((key) => [key, getResponseShape(object[key], depth + 1)])
          )
        : undefined
  };
}

function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveValues);
  const object = asObject(value);
  if (!object) return value;

  return Object.fromEntries(
    Object.entries(object).map(([key, fieldValue]) => {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes("url") ||
        normalizedKey.includes("token") ||
        normalizedKey.includes("authorization") ||
        normalizedKey.includes("api_key")
      ) {
        return [key, "[redacted]"];
      }
      return [key, redactSensitiveValues(fieldValue)];
    })
  );
}

function safeResponseBodyText(value: unknown) {
  if (typeof value === "string") return value.slice(0, 20000);
  return JSON.stringify(redactSensitiveValues(value));
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const meetingId = new URL(request.url).searchParams.get("meetingId")?.trim();
  if (!meetingId) {
    return NextResponse.json(
      { error: "meetingId is required." },
      { status: 400 }
    );
  }

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id, recall_bot_id")
    .eq("id", meetingId)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }
  const apiKey = process.env.RECALL_API_KEY?.trim();
  const recallBotId = meeting.recall_bot_id?.trim() || null;
  if (!recallBotId) {
    return NextResponse.json(
      {
        error: "Meeting does not have a Recall bot ID.",
        meetingId: meeting.id,
        recallBotId,
        recallBotIdExists: false,
        recallApiKeyExists: Boolean(apiKey),
        recallRequestUrl: null,
        recallResponseStatus: null,
        recallResponseBodyText: null
      },
      { status: 409 }
    );
  }

  const region = process.env.RECALL_REGION?.trim() || "us-west-2";
  const botRequestUrl = `https://${region}.recall.ai/api/v1/bot/${encodeURIComponent(recallBotId!)}/`;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Recall API key is not configured.",
        meetingId: meeting.id,
        recallBotId,
        recallBotIdExists: true,
        recallApiKeyExists: false,
        botRequestUrl,
        recallRequestUrl: null,
        recallResponseStatus: null,
        recallResponseBodyText: null
      },
      { status: 500 }
    );
  }

  try {
    const result = await fetchRecallTranscriptWithDiagnostics(recallBotId);
    const entries = getTranscriptEntries(result.transcript);
    const firstEntry = entries[0] ?? null;
    const firstEntryObject = asObject(firstEntry);
    const words = Array.isArray(firstEntryObject?.words)
      ? firstEntryObject.words
      : [];
    const firstWord = asObject(words[0]);

    return NextResponse.json(
      {
        meetingId: meeting.id,
        recallBotId,
        recallBotIdExists: true,
        recallApiKeyExists: true,
        botRequestUrl: result.diagnostics.botRequestUrl,
        botResponseStatus: result.diagnostics.botResponseStatus,
        botResponseShape: getResponseShape(result.diagnostics.botResponse),
        recordingId: result.diagnostics.recordingId,
        transcriptArtifactId: result.diagnostics.transcriptArtifactId,
        transcriptProvider: result.diagnostics.transcriptProvider,
        transcriptDiarizationConfig:
          result.diagnostics.transcriptDiarizationConfig,
        transcriptStatus: result.diagnostics.transcriptStatus,
        recallRequestUrl: result.diagnostics.transcriptRetrieveUrl,
        recallResponseStatus: result.diagnostics.transcriptRetrieveStatus,
        recallResponseBodyText: safeResponseBodyText(
          result.diagnostics.transcriptArtifactResponse
        ),
        transcriptDownloadStatus: result.diagnostics.transcriptDownloadStatus,
        transcript_entry_count: entries.length,
        firstEntryKeys: firstEntryObject
          ? Object.keys(firstEntryObject).sort()
          : [],
        firstEntry,
        firstWordKeys: firstWord ? Object.keys(firstWord).sort() : []
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0"
        }
      }
    );
  } catch (error) {
    const diagnostics =
      error instanceof RecallTranscriptFetchError ? error.diagnostics : null;
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Recall transcript request failed.",
        meetingId: meeting.id,
        recallBotId,
        recallBotIdExists: true,
        recallApiKeyExists: true,
        botRequestUrl: diagnostics?.botRequestUrl ?? botRequestUrl,
        botResponseStatus: diagnostics?.botResponseStatus ?? null,
        botResponseShape: getResponseShape(diagnostics?.botResponse ?? null),
        recordingId: diagnostics?.recordingId ?? null,
        transcriptArtifactId: diagnostics?.transcriptArtifactId ?? null,
        transcriptProvider: diagnostics?.transcriptProvider ?? null,
        transcriptDiarizationConfig:
          diagnostics?.transcriptDiarizationConfig ?? null,
        transcriptStatus: diagnostics?.transcriptStatus ?? null,
        recallRequestUrl: diagnostics?.transcriptRetrieveUrl ?? null,
        recallResponseStatus: diagnostics?.transcriptRetrieveStatus ?? null,
        recallResponseBodyText: safeResponseBodyText(
          diagnostics?.transcriptArtifactResponse ?? null
        ),
        transcriptDownloadStatus: diagnostics?.transcriptDownloadStatus ?? null
      },
      {
        status: 502,
        headers: { "Cache-Control": "no-store, max-age=0" }
      }
    );
  }
}

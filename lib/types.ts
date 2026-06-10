export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type InsightCategory =
  | "product_requirements"
  | "features"
  | "user_stories"
  | "technical_constraints"
  | "design_preferences"
  | "implementation_details"
  | "open_questions";

export interface TranscriptSegment {
  id: string;
  meeting_id: string;
  speaker_name: string | null;
  content: string;
  started_at: string;
  ended_at: string | null;
  raw_payload: JsonValue;
  created_at: string;
}

export interface ExtractedInsight {
  id: string;
  meeting_id: string;
  category: InsightCategory;
  content: string;
  confidence: number | null;
  created_at: string;
}

export interface GeneratedPrompt {
  id: string;
  meeting_id: string;
  target_tool: "codex" | "claude_code" | "lovable";
  prompt: string;
  created_at: string;
}

export interface Meeting {
  id: string;
  user_id: string;
  title: string | null;
  meeting_url: string;
  recall_bot_id: string | null;
  status: "pending" | "joining" | "in_progress" | "completed" | "failed";
  created_at: string;
  updated_at: string;
}

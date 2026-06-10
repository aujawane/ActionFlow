export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type InsightCategory =
  | "product_summary"
  | "requirements"
  | "product_requirements"
  | "features"
  | "user_stories"
  | "technical_constraints"
  | "design_preferences"
  | "implementation_details"
  | "open_questions"
  | "risks"
  | "next_steps";

export interface TranscriptSegment {
  id: string;
  meeting_id: string;
  speaker: string | null;
  text: string;
  timestamp: string;
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
  tool_type: "codex" | "claude_code" | "lovable";
  prompt: string;
  created_at: string;
}

export interface Meeting {
  id: string;
  user_id: string;
  title: string | null;
  meeting_url: string;
  recall_bot_id: string | null;
  status: "pending" | "joining" | "recording" | "completed" | "failed";
  created_at: string;
  updated_at: string;
}

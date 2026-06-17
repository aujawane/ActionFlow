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
  topic_id: string | null;
  category: InsightCategory;
  content: string;
  confidence: number | null;
  created_at: string;
}

export interface GeneratedPrompt {
  id: string;
  meeting_id: string;
  topic_id: string | null;
  tool_type: "general" | "lovable" | "codex" | "claude_code";
  prompt: string;
  created_at: string;
}

export interface MeetingTopic {
  id: string;
  meeting_id: string;
  title: string;
  summary: string | null;
  start_timestamp: string | null;
  end_timestamp: string | null;
  segment_ids: string[] | JsonValue;
  confidence: number | null;
  separation_reason: string | null;
  created_at: string;
}

export interface TopicSegmentResult {
  topic_id: string;
  segment_ids: string[];
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

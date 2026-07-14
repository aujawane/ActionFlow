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
  participant_name: string | null;
  diarized_speaker: string | null;
  speaker_confidence: number | null;
  text: string;
  timestamp: string;
  raw_payload: JsonValue;
  created_at: string;
}

export interface MeetingSpeakerAlias {
  id: string;
  meeting_id: string;
  raw_speaker_label: string;
  display_name: string;
  created_at: string;
  updated_at: string;
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

export type MeetingTaskType = "commitment" | "implicit_commitment" | "unassigned_work";
export type MeetingTaskPriority = "low" | "medium" | "high";
export type MeetingTaskStatus = "pending" | "in_progress" | "completed" | "dismissed";
export type MeetingTaskWorkspaceType =
  | "research"
  | "email"
  | "proposal"
  | "coding"
  | "documentation"
  | "design"
  | "meeting_follow_up"
  | "planning"
  | "testing"
  | "decision"
  | "learning"
  | "other";

export interface MeetingTask {
  id: string;
  meeting_id: string;
  topic_id: string;
  task: string;
  owner: string | null;
  task_type: MeetingTaskType;
  priority: MeetingTaskPriority;
  suggested_steps: string[] | JsonValue;
  source_quote: string | null;
  confidence: number | null;
  status: MeetingTaskStatus;
  workspace_type: MeetingTaskWorkspaceType;
  workspace_summary: string | null;
  created_at: string;
}

export interface TaskArtifact {
  id: string;
  task_id: string;
  artifact_type: string;
  title: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TaskGuide {
  summary: string;
  objective: string;
  steps: string[];
  recommendedApproach: string;
  resources: string[];
  estimatedEffort: string;
  successCriteria: string[];
}

export interface TaskPrompt {
  title: string;
  prompt: string;
  promptType: string;
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
  platform: "google_meet" | "zoom" | "unknown";
  recall_bot_id: string | null;
  status: "pending" | "joining" | "recording" | "processing" | "completed" | "failed";
  is_pinned: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserIntegration {
  id: string;
  user_id: string;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string | null;
  provider_account_email: string | null;
  created_at: string;
  updated_at: string;
}

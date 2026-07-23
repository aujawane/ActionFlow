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
  resolved_speaker: string | null;
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

export interface MeetingSpeakerRosterItem {
  rawSpeakerLabel: string;
  displayName: string;
  participantName: string | null;
  diarizedSpeaker: string | null;
  isResolved: boolean;
  isAmbiguous: boolean;
  segmentCount: number;
  taskCount: number;
  exampleQuotes: string[];
  possibleNameHints: string[];
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
export type CommitmentType =
  | "personal"
  | "assignment"
  | "implicit"
  | "unassigned"
  | "reminder"
  | "conditional"
  | "recurring"
  | "group"
  | "team"
  | "company";
export type CommitmentCompletionState =
  | "open"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled";
export type CommitmentStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "dismissed"
  | "blocked";
export type TaskCategory =
  | "email"
  | "research"
  | "website_change"
  | "design"
  | "scheduling"
  | "follow_up"
  | "coding"
  | "planning"
  | "analysis"
  | "document"
  | "other";

export type TaskDeliverableType =
  | "email_draft"
  | "research_report"
  | "website_change_prompt"
  | "design_brief"
  | "calendar_invite_draft"
  | "follow_up_message"
  | "code_implementation_prompt"
  | "action_plan"
  | "analysis_summary"
  | "document_draft"
  | "generic_next_steps";

export type TaskArtifactStatus = "generated" | "edited" | "failed";

export interface TaskCategorizationMetadata {
  category: TaskCategory;
  deliverable_type: TaskDeliverableType;
  confidence: number;
  reason: string;
  missing_info: string[];
  suggested_button_label: string;
}

export type MeetingTaskWorkspaceType =
  | TaskCategory
  | "proposal"
  | "coding"
  | "documentation"
  | "meeting_follow_up"
  | "testing"
  | "decision"
  | "learning"
  | "other";

export interface MeetingTask {
  id: string;
  meeting_id: string;
  topic_id: string | null;
  commitment_id?: string | null;
  task: string;
  owner: string | null;
  owners?: string[] | JsonValue;
  task_type: MeetingTaskType;
  priority: MeetingTaskPriority;
  suggested_steps: string[] | JsonValue;
  source_quote: string | null;
  confidence: number | null;
  status: MeetingTaskStatus;
  due_date?: string | null;
  due_date_text?: string | null;
  source_segment_ids?: string[] | JsonValue;
  inferred?: boolean;
  extraction_metadata?: JsonValue;
  workspace_type: MeetingTaskWorkspaceType;
  workspace_summary: string | null;
  categorization_metadata?: TaskCategorizationMetadata | JsonValue;
  rationale?: string | null;
  supporting_context?: string | null;
  created_at: string;
}

export interface MeetingCommitment {
  id: string;
  meeting_id: string;
  topic_id: string | null;
  title: string;
  description: string | null;
  owner: string | null;
  owners: string[] | JsonValue;
  due_date: string | null;
  due_date_text: string | null;
  priority: MeetingTaskPriority;
  status: CommitmentStatus;
  confidence: number | null;
  source_quote: string | null;
  source_segment_ids: string[] | JsonValue;
  type: CommitmentType;
  completion_state: CommitmentCompletionState;
  metadata: JsonValue;
  created_at: string;
  updated_at: string;
}

export type TaskCommentRole = "user" | "assistant" | "system";
export type TaskProposalStatus = "pending" | "applied" | "superseded";

export interface TaskCommentProposal {
  id: string;
  patch: Record<string, JsonValue>;
  confidence: number;
  status: TaskProposalStatus;
  source: "agent" | "fallback";
}

export interface TaskCommentMetadata {
  proposal?: TaskCommentProposal;
}

export interface TaskComment {
  id: string;
  task_id: string;
  user_id: string | null;
  role: TaskCommentRole;
  message: string;
  metadata?: TaskCommentMetadata;
  created_at: string;
}

export interface TaskArtifact {
  id: string;
  task_id: string;
  artifact_type: string;
  deliverable_type?: TaskDeliverableType | string | null;
  title: string;
  content: string;
  version: number;
  status?: TaskArtifactStatus;
  metadata?: Record<string, JsonValue> | JsonValue;
  created_at: string;
  updated_at: string;
}

export type MeetingArtifactType =
  | "follow_up_email_individual"
  | "follow_up_email_team_summary";

export type FollowUpEmailMode = "individual" | "team_summary";

export interface MeetingArtifact {
  id: string;
  meeting_id: string;
  artifact_type: MeetingArtifactType;
  title: string;
  content: string | null;
  status: TaskArtifactStatus;
  metadata: Record<string, JsonValue>;
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

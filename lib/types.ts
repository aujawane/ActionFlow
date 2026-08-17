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
  | "decisions"
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
export type MeetingTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "dismissed"
  | "blocked";
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

export type ExecutionClassification =
  | "committed"
  | "proposed"
  | "requirement"
  | "future_consideration";

export type ProjectStatus =
  | "planning"
  | "active"
  | "on_hold"
  | "completed"
  | "archived";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  goal: string | null;
  status: ProjectStatus;
  owner_id: string;
  execution_graph_version?: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectMemory {
  project_id: string;
  summary: string | null;
  goal: string | null;
  product_description: string | null;
  target_audience: string | null;
  current_scope: JsonValue;
  future_scope: JsonValue;
  technical_context: JsonValue;
  design_context: JsonValue;
  constraints: JsonValue;
  assumptions: JsonValue;
  success_criteria: JsonValue;
  provenance: JsonValue;
  confirmed_fields: JsonValue;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectChatMessage {
  id: string;
  thread_id: string;
  project_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: JsonValue;
  created_by: string | null;
  created_at: string;
}

export interface ProjectChangeProposal {
  id: string;
  project_id: string;
  thread_id: string | null;
  source_message_id: string | null;
  status:
    | "draft"
    | "pending_review"
    | "approved"
    | "applied"
    | "rejected"
    | "failed"
    | "superseded";
  summary: string;
  proposal: JsonValue;
  warnings: JsonValue;
  base_graph_version: number;
  resulting_graph_version: number | null;
  created_by: string;
  approved_by: string | null;
  created_at: string;
  applied_at: string | null;
  rejected_at: string | null;
}

export interface MeetingTask {
  id: string;
  meeting_id: string;
  project_id?: string | null;
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
  preserve_on_reanalysis?: boolean;
  manual_override_fields?: string[] | JsonValue;
  workspace_type: MeetingTaskWorkspaceType;
  workspace_summary: string | null;
  categorization_metadata?: TaskCategorizationMetadata | JsonValue;
  rationale?: string | null;
  supporting_context?: string | null;
  execution_classification?: ExecutionClassification;
  position?: number;
  created_at: string;
}

export interface MeetingCommitment {
  id: string;
  meeting_id: string;
  project_id?: string | null;
  converted_to_task_id?: string | null;
  topic_id: string | null;
  title: string;
  description: string | null;
  owner: string | null;
  owners: string[] | JsonValue;
  lead_owner_id?: string | null;
  lead_owner_name?: string | null;
  due_date: string | null;
  due_date_text: string | null;
  priority: MeetingTaskPriority;
  status: CommitmentStatus;
  confidence: number | null;
  source_quote: string | null;
  source_segment_ids: string[] | JsonValue;
  type: CommitmentType;
  completion_state: CommitmentCompletionState;
  execution_classification?: ExecutionClassification;
  metadata: JsonValue;
  preserve_on_reanalysis?: boolean;
  manual_override_fields?: string[] | JsonValue;
  created_at: string;
  updated_at: string;
}

export type ConversationEventType =
  | "promise"
  | "request"
  | "acceptance"
  | "assignment"
  | "decision"
  | "progress_update"
  | "proposal"
  | "future_idea"
  | "question"
  | "reminder"
  | "scheduling_agreement"
  | "blocker"
  | "completed_work"
  | "requirement";

export interface MeetingConversationEvent {
  id: string;
  meeting_id: string;
  client_ref: string;
  type: ConversationEventType;
  actors: string[];
  action: string | null;
  object: string | null;
  temporal_state: "past" | "present" | "future" | "conditional" | "recurring" | "unspecified";
  commitment_signal: "none" | "proposed" | "requested" | "accepted" | "explicit";
  source_quote: string;
  source_segment_ids: string[];
  linked_event_refs: string[];
  confidence: number | null;
  analysis_generation: number;
  created_at: string;
}

export interface CommitmentParticipant {
  id: string;
  commitment_id: string;
  participant_user_id: string | null;
  participant_name: string;
  involvement_role: "participant" | "reviewer" | "approver" | "input_provider";
  manually_added: boolean;
  created_at: string;
  updated_at: string;
}

export interface TaskDependency {
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

/** Shared structured-response envelope for Parfait chat surfaces -- see
 * lib/parfait-response/schema.ts for the Zod validation this type mirrors, and
 * components/parfait-response-renderer.tsx for the universal renderer that consumes it. Defined
 * here (not in lib/parfait-response/*) so it's available to every *Comment interface below
 * without lib/types.ts taking on its first import -- this file is a dependency-free leaf module
 * by convention. */
export type ParfaitResponseSection =
  | { type: "evidence"; title?: string; content: string; source?: ParfaitResponseEvidenceSource }
  | { type: "blocker"; title?: string; content: string }
  | { type: "next_action"; title?: string; content: string }
  | { type: "decision"; title?: string; content: string }
  | { type: "list"; title?: string; items: string[] }
  | { type: "warning"; title?: string; content: string };

export interface ParfaitResponseEvidenceSource {
  meetingId?: string;
  segmentId?: string;
  speaker?: string;
  timestamp?: string;
}

export interface ParfaitResponse {
  answer: string;
  sections?: ParfaitResponseSection[];
  followUps?: string[];
}

export interface CommitmentCommentMetadata {
  /** Populated by the commitment chat's structured-response agent (see
   * lib/commitment-chat/agent.ts). Absent on legacy rows -- those render through the shared
   * renderer's plain/Markdown fallback path instead. */
  structuredResponse?: ParfaitResponse;
  /** A different producer writes to this same column: the AI correction assistant's apply
   * endpoint (app/api/commitments/[id]/correction/apply/route.ts) inserts an audit row shaped
   * like this instead -- kept optional here, alongside structuredResponse, so both producers'
   * rows type-check without a migration or a second metadata column. */
  kind?: "ai_correction";
  user_message?: string | null;
  changes?: Array<{ field: string; from: string; to: string }>;
}

export interface CommitmentComment {
  id: string;
  commitment_id: string;
  user_id: string | null;
  role: TaskCommentRole;
  message: string;
  metadata?: CommitmentCommentMetadata;
  created_at: string;
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

export type MeetingAssistantResponseType =
  | "answer"
  | "generated_content"
  | "clarification"
  | "declined_mutation";

/** One drafted output (an email, a Slack update, an agenda, ...). `subject` is null for output
 * types that don't have one (Slack updates, agendas, summaries); generatedContent is an array so
 * one response can hold several drafts at once (e.g. "draft individual emails for everyone"). */
export interface MeetingAssistantGeneratedContentItem {
  title: string;
  subject: string | null;
  body: string;
}

/** A transcript segment the answer leaned on -- resolved server-side from segment ids the model
 * referenced against the exact segments it was given, never invented. See
 * lib/meeting-assistant/agent.ts. */
export interface MeetingAssistantSource {
  segment_id: string;
  speaker: string;
  timestamp: string;
}

export interface MeetingAssistantCommentMetadata {
  responseType?: MeetingAssistantResponseType;
  generatedContent?: MeetingAssistantGeneratedContentItem[];
  sources?: MeetingAssistantSource[];
}

export interface MeetingComment {
  id: string;
  meeting_id: string;
  user_id: string | null;
  role: TaskCommentRole;
  message: string;
  metadata?: MeetingAssistantCommentMetadata;
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
  accepted_at?: string | null;
  accepted_by?: string | null;
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
  project_id?: string | null;
  title: string | null;
  meeting_url: string;
  platform: "google_meet" | "zoom" | "unknown";
  recall_bot_id: string | null;
  status:
    | "pending"
    | "joining"
    | "recording"
    | "processing"
    | "transcript_ready"
    | "completed"
    | "failed";
  is_pinned: boolean;
  deleted_at: string | null;
  execution_graph_generation?: number;
  last_persisted_execution_generation?: number;
  created_at: string;
  updated_at: string;
}

export type MeetingAnalysisJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stale";

export interface MeetingAnalysisJob {
  id: string;
  meeting_id: string;
  generation: number;
  status: MeetingAnalysisJobStatus;
  current_stage: string;
  progress: number;
  error: string | null;
  retry_count: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  checkpoint?: Record<string, unknown>;
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

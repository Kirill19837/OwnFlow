export interface Company {
  id: string
  name: string
  slug: string
  owner_id: string
  created_at: string
  my_role?: 'owner' | 'admin' | 'member'
  default_team_id?: string
  phone?: string | null
  openai_key_set?: boolean
  anthropic_key_set?: boolean
  ai_prompts_used?: number
  ai_prompts_limit?: number
}

export interface CompanyAgent {
  id: string
  company_id: string
  name: string
  role?: string
  agent_type: 'webhook' | 'builtin'
  webhook_url?: string | null
  agent_api_key?: string | null  // masked as '***' from API
  docker_image?: string | null
  extra_env?: Record<string, string> | null  // keys visible, values masked as '***'
  description?: string
  created_at: string
}

export interface Team {
  id: string
  name: string
  slug: string
  owner_id: string
  company_id?: string
  default_ai_model: string
  log_level?: number  // 0=debug 1=info 2=warning 3=error; defaults to 1
  created_at: string
  my_role?: 'owner' | 'admin' | 'member'
  my_role_id?: string
  members?: TeamMember[]
  pending_invites?: TeamPendingInvite[]
}

export interface TeamMember {
  team_id: string
  user_id: string
  email?: string
  full_name?: string
  role: 'owner' | 'admin' | 'member'   // display name
  role_id: string                       // stable UUID for permission checks
  joined_at: string
}

export interface TeamPendingInvite {
  id: string
  email: string
  role: 'owner' | 'admin' | 'member'
  invited_by_email?: string
  invited_at: string
  status: 'pending' | 'accepted' | 'revoked'
}

export type NotificationTypeKey =
  | 'team_invite'
  | 'team_accepted'
  | 'team_declined'
  | 'team_removed'
  | 'role_changed'
  | 'general'

export interface NotificationType {
  key: NotificationTypeKey
  label: string
  description: string
}

export interface Notification {
  id: string
  user_id: string
  type_id: string               // UUID FK → notification_types.id
  title: string
  body: string
  payload: Record<string, unknown>
  read: boolean
  created_at: string
}

export type ActorType = 'human' | 'ai'

export interface Skill {
  id: string
  name: string
  category: string
  description?: string
  actor_type: 'human' | 'ai' | 'both'
}

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'rework'
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
export type TaskType = 'code' | 'design' | 'review' | 'research' | 'qa' | 'devops'

export interface Actor {
  id: string
  project_id: string
  name: string
  type: ActorType
  user_id?: string
  role?: string
  model?: string
  capabilities: string[]
  avatar_url?: string
  webhook_url?: string
  docker_image?: string | null
  extra_env?: Record<string, string> | null  // keys visible, values masked as '***'
}

export interface Task {
  id: string
  sprint_id: string
  project_id: string
  title: string
  description: string
  type: TaskType
  priority: TaskPriority
  status: TaskStatus
  estimated_hours: number
  depends_on: string[]
  assignments?: Assignment[]
  is_ready?: boolean
  ai_ready?: boolean
  task_details?: Record<string, string>
  github_pr_url?: string
  github_pr_state?: 'open' | 'merged' | 'closed'
  github_pr_number?: number
  agent_dispatched_at?: string
}

export interface TaskInteraction {
  id: string
  task_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface Assignment {
  id: string
  task_id: string
  actor_id: string
  assigned_by: string
  assigned_at: string
  actors?: Actor
}

export interface Sprint {
  id: string
  project_id: string
  sprint_number: number
  start_date: string
  end_date: string
  status: string
}

export interface SprintTheme {
  sprint_number: number
  theme: string
  goal: string
}

export interface Project {
  id: string
  name: string
  prompt: string
  owner_id: string
  team_id?: string
  status: 'planning' | 'active' | 'error'
  created_at: string
  sprint_days?: number
  roadmap?: SprintTheme[]
  sprints?: Sprint[]
  tasks?: Task[]
  actors?: Actor[]
}

export interface DeliverableFile {
  path: string
  content?: string
  url?: string
}

export interface Deliverable {
  id: string
  task_id: string
  actor_id: string
  content: string
  tool_calls_log?: unknown[]
  created_at: string
  files?: DeliverableFile[] | null
}

// ── Project Memory ────────────────────────────────────────────────────────────

export type MemorySourceType =
  | 'product'
  | 'architecture'
  | 'coding-standards'
  | 'business-rules'
  | 'code_file'
  | 'pull_request'
  | 'commit'
  | 'document'

export interface MemoryChunk {
  id: string
  project_id: string
  source_type: MemorySourceType
  source_id?: string | null
  title: string
  content: string
  summary?: string | null
  tags: string[]
  importance: number
  created_at: string
  updated_at: string
}

export type DecisionStatus = 'active' | 'superseded' | 'rejected' | 'draft'

export interface Decision {
  id: string
  project_id: string
  title: string
  status: DecisionStatus
  context?: string | null
  decision: string
  reason?: string | null
  consequences?: string | null
  related_task_ids: string[]
  superseded_by?: string | null
  created_at: string
}

export interface ContextPack {
  id: string
  project_id: string
  task_id?: string | null
  content: string
  included_chunk_ids: string[]
  token_count: number
  created_at: string
}

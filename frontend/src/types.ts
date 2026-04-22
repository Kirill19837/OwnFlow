export interface Organization {
  id: string
  name: string
  slug: string
  owner_id: string
  default_ai_model: string
  created_at: string
  my_role?: 'owner' | 'admin' | 'member'
  members?: OrgMember[]
  pending_invites?: OrgPendingInvite[]
}

export interface OrgMember {
  org_id: string
  user_id: string
  email?: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string
}

export interface OrgPendingInvite {
  id: string
  email: string
  role: 'owner' | 'admin' | 'member'
  invited_by_email?: string
  invited_at: string
  status: 'pending' | 'accepted' | 'revoked'
}

export type ActorType = 'human' | 'ai'

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'rework'
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
export type TaskType = 'code' | 'design' | 'review' | 'research' | 'qa' | 'devops'

export interface Actor {
  id: string
  project_id: string
  name: string
  type: ActorType
  role?: string
  model?: string
  capabilities: string[]
  avatar_url?: string
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
  org_id?: string
  status: 'planning' | 'active' | 'error'
  created_at: string
  sprint_days?: number
  roadmap?: SprintTheme[]
  sprints?: Sprint[]
  tasks?: Task[]
  actors?: Actor[]
}

export interface Deliverable {
  id: string
  task_id: string
  actor_id: string
  content: string
  tool_calls_log?: unknown[]
  created_at: string
}

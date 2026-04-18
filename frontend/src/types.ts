export interface Organization {
  id: string
  name: string
  slug: string
  owner_id: string
  default_ai_model: string
  created_at: string
  my_role?: 'owner' | 'admin' | 'member'
  members?: OrgMember[]
}

export interface OrgMember {
  org_id: string
  user_id: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string
}

export type ActorType = 'human' | 'ai'

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
export type TaskType = 'code' | 'design' | 'review' | 'research' | 'qa' | 'devops'

export interface Actor {
  id: string
  project_id: string
  name: string
  type: ActorType
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

export interface Project {
  id: string
  name: string
  prompt: string
  owner_id: string
  org_id?: string
  status: 'planning' | 'active' | 'error'
  created_at: string
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

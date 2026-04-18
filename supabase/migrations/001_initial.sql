-- Enable UUID extension
create extension if not exists "pgcrypto";

-- Projects
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  prompt text not null,
  owner_id uuid not null,
  status text not null default 'planning',
  created_at timestamptz not null default now()
);

-- Actors (human or AI)
create table if not exists actors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  type text not null check (type in ('human', 'ai')),
  model text,
  capabilities text[] default '{}',
  avatar_url text,
  created_at timestamptz not null default now()
);

-- Sprints
create table if not exists sprints (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  sprint_number integer not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'planned',
  created_at timestamptz not null default now()
);

-- Tasks
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  sprint_id uuid not null references sprints(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  description text not null default '',
  type text not null default 'code',
  priority text not null default 'medium',
  status text not null default 'todo',
  estimated_hours float not null default 4,
  depends_on uuid[] default '{}',
  created_at timestamptz not null default now()
);

-- Assignments
create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  assigned_by text not null default 'system',
  assigned_at timestamptz not null default now(),
  unique(task_id)
);

-- Deliverables
create table if not exists deliverables (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  content text not null,
  tool_calls_log jsonb default '[]',
  created_at timestamptz not null default now()
);

-- Project members (for collaboration)
create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- Enable Realtime
alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table assignments;
alter publication supabase_realtime add table deliverables;
alter publication supabase_realtime add table projects;

-- Row-level security (enable but keep permissive for now — tighten per auth setup)
alter table projects enable row level security;
alter table actors enable row level security;
alter table sprints enable row level security;
alter table tasks enable row level security;
alter table assignments enable row level security;
alter table deliverables enable row level security;
alter table project_members enable row level security;

-- Permissive policies (service role bypasses RLS; adjust for user-level auth later)
create policy "service_role_all_projects" on projects for all using (true);
create policy "service_role_all_actors" on actors for all using (true);
create policy "service_role_all_sprints" on sprints for all using (true);
create policy "service_role_all_tasks" on tasks for all using (true);
create policy "service_role_all_assignments" on assignments for all using (true);
create policy "service_role_all_deliverables" on deliverables for all using (true);
create policy "service_role_all_members" on project_members for all using (true);

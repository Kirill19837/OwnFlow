-- Add sprint_days and roadmap columns to projects table
alter table projects
  add column if not exists sprint_days int not null default 3,
  add column if not exists roadmap     jsonb;

-- Add role column to actors table
alter table actors
  add column if not exists role text;

-- Add task_details and is_ready columns to tasks table
alter table tasks
  add column if not exists task_details jsonb,
  add column if not exists is_ready     boolean not null default false;

-- Add task_interactions table for AI/human chat history per task
create table if not exists task_interactions (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);

create index if not exists task_interactions_task_idx on task_interactions (task_id, created_at);

alter table task_interactions enable row level security;
create policy "service_role_all_task_interactions" on task_interactions for all using (true);


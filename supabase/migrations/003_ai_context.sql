-- AI planning logs: one row per log line emitted during plan generation
create table if not exists ai_logs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  -- 'planning' | 'task_execution'
  phase       text not null default 'planning',
  message     text not null,
  level       text not null default 'info', -- info | error
  created_at  timestamptz not null default now()
);

-- AI message context: every prompt + response stored verbatim
create table if not exists ai_messages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  -- null for planning phase, set for task execution
  task_id     uuid references tasks(id) on delete cascade,
  actor_id    uuid references actors(id) on delete set null,
  -- 'planning' | 'task_execution'
  phase       text not null default 'planning',
  model       text not null,
  -- full messages array sent to the AI (system + user + prior turns)
  messages    jsonb not null default '[]',
  -- raw response string from the AI
  response    text not null,
  -- usage metadata if available
  usage       jsonb,
  created_at  timestamptz not null default now()
);

-- Realtime
alter publication supabase_realtime add table ai_logs;

-- RLS
alter table ai_logs     enable row level security;
alter table ai_messages enable row level security;

create policy "service_role_all_ai_logs"     on ai_logs     for all using (true);
create policy "service_role_all_ai_messages" on ai_messages for all using (true);

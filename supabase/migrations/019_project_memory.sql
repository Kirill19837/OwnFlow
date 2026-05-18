-- Migration 019: Project Memory Architecture
--
-- memory_chunks: AI-visible context units scoped to a project
-- decisions:     architectural/product decisions with lifecycle tracking
-- context_packs: assembled context snapshots built per task

-- ─── memory_chunks ────────────────────────────────────────────────────────────
create table if not exists memory_chunks (
  id          uuid        primary key default gen_random_uuid(),
  project_id  uuid        not null references projects(id) on delete cascade,
  source_type text        not null check (source_type in (
                'product', 'architecture', 'coding-standards', 'business-rules',
                'code_file', 'pull_request', 'commit'
              )),
  source_id   text,                       -- file path, PR number, commit SHA, etc.
  title       text        not null,
  content     text        not null,
  summary     text,
  tags        jsonb       not null default '[]',
  importance  int         not null default 5 check (importance between 1 and 10),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_memory_chunks_project
  on memory_chunks(project_id);

create index if not exists idx_memory_chunks_project_source_type
  on memory_chunks(project_id, source_type);

-- ─── decisions ────────────────────────────────────────────────────────────────
create table if not exists decisions (
  id               uuid        primary key default gen_random_uuid(),
  project_id       uuid        not null references projects(id) on delete cascade,
  title            text        not null,
  status           text        not null default 'active'
                     check (status in ('active', 'superseded', 'rejected', 'draft')),
  context          text,
  decision         text        not null,
  reason           text,
  consequences     text,
  related_task_ids jsonb       not null default '[]',
  superseded_by    uuid        references decisions(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_decisions_project
  on decisions(project_id);

-- ─── context_packs ────────────────────────────────────────────────────────────
create table if not exists context_packs (
  id                 uuid        primary key default gen_random_uuid(),
  project_id         uuid        not null references projects(id) on delete cascade,
  task_id            uuid        references tasks(id) on delete set null,
  content            text        not null,
  included_chunk_ids jsonb       not null default '[]',
  token_count        int         not null default 0,
  created_at         timestamptz not null default now()
);

create index if not exists idx_context_packs_project
  on context_packs(project_id);

create index if not exists idx_context_packs_task
  on context_packs(task_id);

-- ─── RLS ──────────────────────────────────────────────────────────────────────
alter table memory_chunks  enable row level security;
alter table decisions      enable row level security;
alter table context_packs  enable row level security;

create policy "service_role_all_memory_chunks"
  on memory_chunks for all
  to service_role
  using (true) with check (true);

create policy "service_role_all_decisions"
  on decisions for all
  to service_role
  using (true) with check (true);

create policy "service_role_all_context_packs"
  on context_packs for all
  to service_role
  using (true) with check (true);

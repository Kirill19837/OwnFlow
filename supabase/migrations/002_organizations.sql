-- Organizations
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner_id uuid not null,
  default_ai_model text not null default 'gpt-4o',
  created_at timestamptz not null default now()
);

-- Org members
create table if not exists org_members (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Add org_id to projects (nullable so existing rows aren't broken)
alter table projects add column if not exists org_id uuid references organizations(id) on delete cascade;

-- RLS
alter table organizations enable row level security;
alter table org_members enable row level security;
create policy "service_role_all_orgs" on organizations for all using (true);
create policy "service_role_all_org_members" on org_members for all using (true);

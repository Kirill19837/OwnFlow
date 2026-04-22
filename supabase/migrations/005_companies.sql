-- Companies: top-level tenant boundary
-- One company per user (they may belong to multiple teams within it).

create table if not exists companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  owner_id   uuid not null,
  phone      text,
  created_at timestamptz not null default now()
);

-- Company membership (one row per user per company)
create table if not exists company_members (
  company_id uuid not null references companies(id) on delete cascade,
  user_id    uuid not null,
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (company_id, user_id)
);

-- Link teams (organizations) to a company
alter table organizations add column if not exists company_id uuid references companies(id) on delete cascade;

-- Store which company an invite belongs to
alter table org_invites add column if not exists company_id uuid references companies(id);

-- RLS (service role bypasses all)
alter table companies        enable row level security;
alter table company_members  enable row level security;
create policy "service_role_all_companies"       on companies       for all using (true);
create policy "service_role_all_company_members" on company_members for all using (true);

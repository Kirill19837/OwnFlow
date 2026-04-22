create table if not exists org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  invited_by_user_id uuid not null,
  invited_by_email text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  accepted_user_id uuid,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz
);

create unique index if not exists org_invites_org_email_status_uniq on org_invites (org_id, email, status);
create index if not exists org_invites_email_status_idx on org_invites (email, status);

alter table org_invites enable row level security;
create policy "service_role_all_org_invites" on org_invites for all using (true);

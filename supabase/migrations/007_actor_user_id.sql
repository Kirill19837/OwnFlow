-- Migration 007: link human actors to team members via user_id
alter table actors
  add column if not exists user_id uuid references auth.users(id) on delete set null;

comment on column actors.user_id is
  'For human actors: the Supabase auth user this actor represents. '
  'Null for AI actors or unlinked human actors.';

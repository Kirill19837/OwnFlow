-- Migration 009: per-user real-time notifications
-- notification_types was created in 008; this migration adds the notifications
-- table and extends the seed with any missing rows (idempotent via on conflict).

-- ─── Notification types — ensure seed is complete ────────────────────────────
insert into notification_types (id, key, label, description) values
  ('00000000-0000-0000-0002-000000000001', 'team_invite',        'Team invite',        'You have been invited to join a team'),
  ('00000000-0000-0000-0002-000000000002', 'team_accepted',      'Invite accepted',    'A user accepted your team invite'),
  ('00000000-0000-0000-0002-000000000003', 'team_declined',      'Invite declined',    'A user declined your team invite'),
  ('00000000-0000-0000-0002-000000000004', 'team_removed',       'Removed from team',  'You were removed from a team'),
  ('00000000-0000-0000-0002-000000000005', 'role_changed',       'Role changed',       'Your role in a team was changed'),
  ('00000000-0000-0000-0002-000000000006', 'general',            'General',            'General system notification'),
  ('00000000-0000-0000-0002-000000000007', 'create_team',        'Create team',        'A new team was created'),
  ('00000000-0000-0000-0002-000000000008', 'update_team',        'Update team',        'Team settings were updated'),
  ('00000000-0000-0000-0002-000000000009', 'add_member',         'Add member',         'A member was added directly'),
  ('00000000-0000-0000-0002-000000000010', 'invite_member',      'Invite member',      'A member was invited by email'),
  ('00000000-0000-0000-0002-000000000011', 'accept_invites',     'Accept invites',     'Pending invites were accepted'),
  ('00000000-0000-0000-0002-000000000012', 'decline_invite',     'Decline invite',     'An invite was declined'),
  ('00000000-0000-0000-0002-000000000013', 'delete_team',        'Delete team',        'A team was deleted'),
  ('00000000-0000-0000-0002-000000000014', 'change_member_role', 'Change member role', 'A member''s role was changed'),
  ('00000000-0000-0000-0002-000000000015', 'leave_team',         'Leave team',         'A member left the team'),
  ('00000000-0000-0000-0002-000000000016', 'remove_member',      'Remove member',      'A member was removed from the team'),
  ('00000000-0000-0000-0002-000000000017', 'revoke_invite',      'Revoke invite',      'An invite was revoked')
on conflict (id) do nothing;

-- ─── Notifications ───────────────────────────────────────────────────────────
create table if not exists notifications (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null,            -- recipient (auth.users.id)
  type_id    uuid        not null references notification_types (id),
  title      text        not null,
  body       text        not null default '',
  payload    jsonb       not null default '{}',
  read       boolean     not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_id_idx  on notifications (user_id);
create index if not exists notifications_unread_idx   on notifications (user_id) where read = false;
create index if not exists notifications_created_idx  on notifications (created_at desc);

alter table notifications enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='notifications' and policyname='user_can_read_own_notifications') then
    create policy "user_can_read_own_notifications"
      on notifications for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='notifications' and policyname='user_can_update_own_notifications') then
    create policy "user_can_update_own_notifications"
      on notifications for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='notifications' and policyname='service_role_all_notifications') then
    create policy "service_role_all_notifications"
      on notifications for all using (true);
  end if;
end $$;

-- Enable real-time for the notifications table
do $$ begin
  alter publication supabase_realtime add table notifications;
exception when duplicate_object then null; end $$;

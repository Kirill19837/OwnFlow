-- Migration 009: per-user real-time notifications
-- Rows are inserted by the backend (service role) and read by the user via RLS.

-- ─── Notification types (lookup) ────────────────────────────────────────────
create table if not exists notification_types (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  label       text not null,
  description text
);

insert into notification_types (key, label, description) values
  ('team_invite',    'Team invite',    'You have been invited to join a team'),
  ('team_accepted',  'Invite accepted','A user accepted your team invite'),
  ('team_declined',  'Invite declined','A user declined your team invite'),
  ('team_removed',   'Removed from team', 'You were removed from a team'),
  ('role_changed',   'Role changed',   'Your role in a team was changed'),
  ('general',        'General',        'General system notification')
on conflict (key) do nothing;

-- ─── Notifications ───────────────────────────────────────────────────────────
create table if not exists notifications (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null,            -- recipient (auth.users.id)
  type       text        not null references notification_types (key),
  title      text        not null,
  body       text        not null default '',
  payload    jsonb       not null default '{}',
  read       boolean     not null default false,
  created_at timestamptz not null default now()
);

create index notifications_user_id_idx  on notifications (user_id);
create index notifications_unread_idx   on notifications (user_id) where read = false;
create index notifications_created_idx  on notifications (created_at desc);

alter table notification_types enable row level security;
alter table notifications      enable row level security;

-- All users can read available notification types.
create policy "anyone_can_read_notification_types"
  on notification_types for select
  using (true);

-- Service role manages notification types.
create policy "service_role_all_notification_types"
  on notification_types for all
  using (true);

-- Users can only see their own notifications.
create policy "user_can_read_own_notifications"
  on notifications for select
  using (auth.uid() = user_id);

-- Users can mark their own notifications as read.
create policy "user_can_update_own_notifications"
  on notifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Service role inserts on behalf of backend.
create policy "service_role_all_notifications"
  on notifications for all
  using (true);

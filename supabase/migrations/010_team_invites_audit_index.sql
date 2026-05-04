-- Replace the broad unique index on (team_id, email, status) with a partial
-- index that only prevents duplicate *pending* invites. This allows accepted,
-- declined, and revoked rows to accumulate as an audit log while still
-- blocking double-pending-invites for the same team+email.

drop index if exists team_invites_team_email_status_uniq;

create unique index team_invites_pending_uniq
  on team_invites (team_id, email)
  where status = 'pending';

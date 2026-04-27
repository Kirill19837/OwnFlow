# OwnFlow — Database Reference

Supabase (PostgreSQL). All tables use **UUID primary keys**. The backend accesses the DB exclusively via the **service role key**, which bypasses RLS. All tables have RLS enabled with a permissive service-role policy.

---

## Hierarchy

```
Company
└── Team (workspace inside a company)
    ├── Team Members   (role: owner / admin / member)
    ├── Team Invites   (pending / accepted / revoked)
    └── Project
        ├── Project Members
        ├── Actors     (human or AI participants)
        └── Sprint
            └── Task
                ├── Assignment  (task → actor)
                └── Deliverable (actor output)
```

---

## Tables

### `roles` — lookup table

Fixed-UUID role definitions. Never changes at runtime.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Fixed UUIDs (see below) |
| `name` | text UNIQUE | `owner` / `admin` / `member` |
| `description` | text | Human-readable description |

**Seeded UUIDs:**
| Role | UUID |
|---|---|
| owner | `00000000-0000-0000-0000-000000000001` |
| admin | `00000000-0000-0000-0000-000000000002` |
| member | `00000000-0000-0000-0000-000000000003` |

---

### `companies` — top-level tenant

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | |
| `slug` | text UNIQUE | URL-safe identifier |
| `owner_id` | uuid | Supabase auth UID of the creator |
| `phone` | text | Optional contact phone |
| `created_at` | timestamptz | |

### `company_members`

| Column | Type | Notes |
|---|---|---|
| `company_id` | uuid FK → companies | Cascade delete |
| `user_id` | uuid | Supabase auth UID |
| `role` | uuid FK → roles | Default: member |
| `joined_at` | timestamptz | |

PK: `(company_id, user_id)`

---

### `teams` — workspace inside a company

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | |
| `slug` | text UNIQUE | |
| `owner_id` | uuid | Supabase auth UID of creator |
| `company_id` | uuid FK → companies | Nullable; cascade delete |
| `default_ai_model` | text | Default: `gpt-4o` |
| `created_at` | timestamptz | |

### `team_members`

| Column | Type | Notes |
|---|---|---|
| `team_id` | uuid FK → teams | Cascade delete |
| `user_id` | uuid | Supabase auth UID |
| `role` | uuid FK → roles | Default: member |
| `joined_at` | timestamptz | |

PK: `(team_id, user_id)`

### `team_invites`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `team_id` | uuid FK → teams | Cascade delete |
| `company_id` | uuid FK → companies | Nullable |
| `email` | text | Invitee email |
| `role` | uuid FK → roles | Role to grant on accept |
| `invited_by_user_id` | uuid | Inviter's Supabase UID |
| `invited_by_email` | text | Inviter's email (denormalised) |
| `status` | text | `pending` / `accepted` / `revoked` |
| `accepted_user_id` | uuid | Set when accepted |
| `invited_at` | timestamptz | |
| `accepted_at` | timestamptz | Nullable |

**Indexes:**
- UNIQUE `(team_id, email, status)` — prevents duplicate pending invites
- `(email, status)` — fast lookup at login time

---

### `projects`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | |
| `prompt` | text | Full project brief |
| `owner_id` | uuid | Supabase auth UID |
| `team_id` | uuid FK → teams | Nullable; cascade delete |
| `status` | text | `planning` / `active` / `error` |
| `sprint_days` | int | Sprint length in days; default 3 |
| `roadmap` | jsonb | AI-generated roadmap phases; nullable |
| `created_at` | timestamptz | |

**Realtime:** enabled.

### `project_members`

| Column | Type | Notes |
|---|---|---|
| `project_id` | uuid FK → projects | Cascade delete |
| `user_id` | uuid | Supabase auth UID |
| `role` | uuid FK → roles | Default: member |
| `joined_at` | timestamptz | |

PK: `(project_id, user_id)`

---

### `actors` — participants in a project

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | Cascade delete |
| `name` | text | Display name |
| `type` | text | `human` or `ai` |
| `role` | text | Free-text job role (e.g. "Backend Engineer") |
| `model` | text | AI model ID (only relevant when `type = ai`) |
| `capabilities` | text[] | List of skill tags; default `{}` |
| `avatar_url` | text | Nullable |
| `created_at` | timestamptz | |

---

### `sprints`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | Cascade delete |
| `sprint_number` | integer | 1-based sequence |
| `start_date` | date | |
| `end_date` | date | `start_date + sprint_days - 1` |
| `status` | text | `planned` / `active` / `done` |
| `created_at` | timestamptz | |

---

### `tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `sprint_id` | uuid FK → sprints | Cascade delete |
| `project_id` | uuid FK → projects | Cascade delete (denormalised for fast queries) |
| `title` | text | |
| `description` | text | Default `''` |
| `type` | text | `code` / `design` / `qa` / etc. |
| `priority` | text | `low` / `medium` / `high` |
| `status` | text | `todo` / `in_progress` / `done` |
| `estimated_hours` | float | Default 4 |
| `depends_on` | uuid[] | Array of task UUIDs this task blocks on |
| `github_pr_url` | text | Nullable |
| `ai_ready` | boolean | AI decided task is implementation-ready; default `false` |
| `is_ready` | boolean | User approved task as ready to execute; default `false` |
| `task_details` | jsonb | Key/value decisions captured via AI refinement; nullable |
| `created_at` | timestamptz | |

**Realtime:** enabled.

---

### `task_interactions` — per-task AI/human chat history

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `task_id` | uuid FK → tasks | Cascade delete |
| `role` | text | `user` or `assistant` |
| `content` | text | Message text (may contain structured JSON actions) |
| `created_at` | timestamptz | |

**Index:** `(task_id, created_at)` for fast per-task history queries.

---

### `assignments` — task → actor mapping

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `task_id` | uuid FK → tasks | Cascade delete; UNIQUE (one actor per task) |
| `actor_id` | uuid FK → actors | Cascade delete |
| `assigned_by` | text | `system` or user identifier |
| `assigned_at` | timestamptz | |

**Realtime:** enabled.

---

### `deliverables` — actor output for a task

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `task_id` | uuid FK → tasks | Cascade delete |
| `actor_id` | uuid FK → actors | Cascade delete |
| `content` | text | Output text / code |
| `tool_calls_log` | jsonb | Raw tool-call log; default `[]` |
| `created_at` | timestamptz | |

**Realtime:** enabled.

---

### `ai_logs` — planning/execution log

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | Cascade delete |
| `phase` | text | `planning` / `execution` |
| `message` | text | Log line |
| `level` | text | `info` / `warn` / `error` |
| `created_at` | timestamptz | |

**Realtime:** enabled.

### `ai_messages` — raw LLM call records

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | Cascade delete |
| `task_id` | uuid FK → tasks | Nullable; cascade delete |
| `actor_id` | uuid FK → actors | Nullable; set null on delete |
| `phase` | text | `planning` / `execution` |
| `model` | text | Model ID used |
| `messages` | jsonb | Full messages array sent to the LLM |
| `response` | text | Raw LLM response text |
| `usage` | jsonb | Token usage stats; nullable |
| `created_at` | timestamptz | |

---

### `github_connections`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | Cascade delete; UNIQUE |
| `github_token` | text | GitHub OAuth/PAT token |
| `repo_owner` | text | GitHub org or user |
| `repo_name` | text | Repository name |
| `created_at` | timestamptz | |

---

## Migrations

| File | Description |
|---|---|
| `001_schema.sql` | Full canonical schema — drop & recreate from scratch |
| `001_initial.sql` | Legacy initial schema (superseded) |
| `007_projects_sprint_days_roadmap.sql` | `ALTER` to add missing columns/tables to existing DBs: `projects.sprint_days`, `projects.roadmap`, `actors.role`, `tasks.task_details`, `tasks.is_ready`, and `task_interactions` table |

> **Note:** `001_schema.sql` is the single source of truth for new deployments. For existing deployments, apply incremental migration files from `007_` onward.

---

## Row-Level Security

All tables have RLS **enabled**. Every table has a single policy:

```sql
create policy "service_role_all_<table>" on <table> for all using (true);
```

The backend connects with the **Supabase service role key** which bypasses RLS entirely. Anon/authenticated keys have no access — all data access goes through the FastAPI backend.

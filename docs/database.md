# OwnFlow — Database Reference

Supabase (PostgreSQL). All tables use **UUID primary keys**. The backend accesses the DB exclusively via the **service role key**, which bypasses RLS. All tables have RLS enabled.

---

## Hierarchy

```
Company
├── Company Members
├── Company Agents   (reusable external-agent templates)
└── Team
    ├── Team Members      (role: owner / admin / member)
    ├── Team Invites      (pending / accepted / declined / revoked)
    ├── Team GitHub Token (OAuth token shared across team projects)
    ├── Team API Logs     (audit log of team management actions)
    └── Project
        ├── Project Members
        ├── GitHub Connection   (repo + token scoped to this project)
        ├── Actors              (human or AI participants)
        └── Sprint
            └── Task
                ├── Assignment        (task → actor, one per task)
                ├── Deliverable       (actor output)
                ├── Task Interactions (AI/human chat history)
                └── AI Logs / Messages
```

---

## Tables

### `roles` — lookup table

Fixed-UUID role definitions. Never modified at runtime.

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
| `owner_id` | uuid | Supabase auth UID of creator |
| `phone` | text | Optional |
| `openai_api_key` | text | Company-level OpenAI key (optional; falls back to server key) |
| `anthropic_api_key` | text | Company-level Anthropic key (optional; falls back to server key) |
| `created_at` | timestamptz | |

### `company_members`

| Column | Type | Notes |
|---|---|---|
| `company_id` | uuid FK → companies | Cascade delete |
| `user_id` | uuid | Supabase auth UID |
| `role` | uuid FK → roles | Default: member |
| `joined_at` | timestamptz | |

PK: `(company_id, user_id)`

### `company_agents` — reusable external-agent templates

Templates that team admins define once and reuse across projects. When an actor is created from a template, its `webhook_url`, `docker_image`, `agent_api_key`, and `extra_env` are copied to the actor and the template is not re-read at dispatch time.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid FK → companies | Cascade delete |
| `name` | text | Display name |
| `role` | text | Optional job role |
| `webhook_url` | text | Required; target URL for dispatch |
| `agent_api_key` | text | Optional; sent as `X-Api-Key` |
| `description` | text | Optional |
| `created_at` | timestamptz | |

**Index:** `(company_id, created_at)`

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
| `log_level` | smallint | Min level to persist: 0=debug 1=info 2=warning 3=error; default 1 |
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
| `status` | text | `pending` / `accepted` / `revoked` / `declined` |
| `accepted_user_id` | uuid | Set when accepted |
| `invited_at` | timestamptz | |
| `accepted_at` | timestamptz | Nullable |

**Indexes:**
- UNIQUE partial `(team_id, email)` where `status = 'pending'` — prevents duplicate pending invites
- `(email, status)` — fast lookup at login time

### `team_github_tokens` — OAuth token shared across team projects

Stored once per team so multiple projects can use the same GitHub connection without requiring separate OAuth flows per project.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `team_id` | uuid FK → teams UNIQUE | Cascade delete |
| `github_token` | text | OAuth or PAT token |
| `github_user_login` | text | GitHub username |
| `created_at` | timestamptz | |

### `team_api_logs` — audit log

Records every significant team management action (invites, role changes, member ops, etc.).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `team_id` | uuid | Nullable (team may be deleted) |
| `user_id` | text | Actor performing the action |
| `action_id` | uuid FK → notification_types | Action type |
| `level` | text | `info` / `warn` / `error` |
| `detail` | jsonb | Action-specific metadata |
| `created_at` | timestamptz | |

---

### `notifications`

Per-user in-app notifications. Realtime-enabled.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | Supabase auth UID |
| `type_id` | uuid FK → notification_types | |
| `title` | text | |
| `body` | text | |
| `payload` | jsonb | Arbitrary context data |
| `read` | boolean | Default false |
| `created_at` | timestamptz | |

**RLS:** users can only `SELECT` and `UPDATE` their own rows. Service role has full access.

### `notification_types`

Seeded lookup for every notification/action type in the system (team invites, role changes, member ops, etc.). See `database_full.sql` for the full seed list.

---

### `user_signups` — onboarding funnel

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid UNIQUE | Supabase auth UID |
| `origin` | text | `organic` / `team_invite` |
| `signup_status` | text | `invited` / `company_created` / `team_join` |
| `invited_by_email` | text | Nullable |
| `team_id` | uuid | Nullable |
| `completed_at` | timestamptz | Set when onboarding completes |
| `created_at` | timestamptz | |

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
| `model` | text | AI model ID; only relevant when `type = ai` |
| `capabilities` | text[] | Skill tags; default `{}` |
| `avatar_url` | text | Nullable |
| `user_id` | uuid FK → auth.users | Nullable; links actor to a real user; set null on delete |
| `webhook_url` | text | If set, tasks are dispatched here instead of Docker |
| `agent_api_key` | text | Sent as `X-Api-Key` on dispatch; **never returned in API responses** |
| `docker_image` | text | Docker image override; falls back to server `BUILTIN_AGENT_IMAGE` |
| `extra_env` | jsonb | Extra env vars injected into the container at dispatch; values masked in API responses |
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
| `depends_on` | uuid[] | Task UUIDs this task blocks on |
| `actor_role` | text | Role hint used by the assignment engine |
| `github_pr_url` | text | Nullable |
| `github_pr_state` | text | Nullable; `open` / `merged` / `closed` |
| `github_pr_number` | int | Nullable |
| `agent_callback_token` | text | One-time token for callback auth; cleared after use. **Never returned in API responses.** |
| `agent_dispatched_at` | timestamptz | When the agent was dispatched |
| `ai_ready` | boolean | AI assessed task as implementation-ready; default false |
| `is_ready` | boolean | User approved task as ready to execute; default false |
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

**Index:** `(task_id, created_at)`

---

### `assignments` — task → actor mapping

One actor per task (UNIQUE on `task_id`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `task_id` | uuid FK → tasks UNIQUE | Cascade delete |
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
| `task_id` | uuid FK → tasks | Nullable; cascade delete. Set for execution-phase logs. |
| `phase` | smallint | Phase code (0 = planning, higher = execution phases) |
| `message` | text | Log line |
| `level` | smallint | 0=debug 1=info 2=warning 3=error |
| `created_at` | timestamptz | |

**Realtime:** enabled. Entries below the team's `log_level` threshold are not persisted.

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

### `github_connections` — per-project GitHub repo

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects UNIQUE | Cascade delete |
| `github_token` | text | GitHub OAuth or PAT token |
| `repo_owner` | text | GitHub org or user |
| `repo_name` | text | Repository name |
| `github_user_login` | text | GitHub username |
| `webhook_secret` | text | Nullable; used to verify incoming webhook payloads |
| `created_at` | timestamptz | |

### `github_oauth_states` — CSRF state for GitHub OAuth

| Column | Type | Notes |
|---|---|---|
| `state` | text PK | Random state string |
| `project_id` | uuid FK → projects | Nullable; cascade delete |
| `team_id` | uuid FK → teams | Nullable; cascade delete |
| `created_at` | timestamptz | |

---

### `skills` — skill catalogue

Seeded list of roles/skills that users and actors can declare. See `database_full.sql` for the full seed list.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text UNIQUE | |
| `category` | text | Engineering / Quality / Product / Management / Feedback |
| `description` | text | |
| `actor_type` | text | `human` / `ai` / `both` |
| `created_at` | timestamptz | |

### `user_skills`

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | Supabase auth UID |
| `skill_id` | uuid FK → skills | Cascade delete |
| `created_at` | timestamptz | |

PK: `(user_id, skill_id)`

---

### `memory_chunks` — project memory units

Normalized memory entries used for context packs and vector retrieval.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | Cascade delete |
| `source_type` | text | `product` / `architecture` / `coding-standards` / `business-rules` / `code_file` / `pull_request` / `commit` / `document` |
| `source_id` | text | Optional source reference (task id, PR number, document part id, etc.) |
| `title` | text | |
| `content` | text | Full chunk content |
| `summary` | text | Optional summary |
| `tags` | jsonb | Default `[]` |
| `importance` | int | 1..10 |
| `embedding` | vector(1536) | Optional pgvector embedding |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `decisions` — project decision records

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | Cascade delete |
| `title` | text | |
| `status` | text | `active` / `superseded` / `rejected` / `draft` |
| `context` | text | Optional |
| `decision` | text | |
| `reason` | text | Optional |
| `consequences` | text | Optional |
| `related_task_ids` | jsonb | Default `[]` |
| `superseded_by` | uuid FK → decisions | Nullable |
| `created_at` | timestamptz | |

### `context_packs` — assembled context snapshots

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | Cascade delete |
| `task_id` | uuid FK → tasks | Nullable |
| `content` | text | Materialized context payload |
| `included_chunk_ids` | jsonb | Default `[]` |
| `token_count` | int | Approximate token count |
| `created_at` | timestamptz | |

Vector similarity RPC:
- `match_memory_chunks(p_project_id, p_query_embedding, p_match_threshold, p_match_count)`

See [docs/project-memory.md](docs/project-memory.md) for ingestion flow and endpoints.

---

## Migrations

| File | Description |
|---|---|
| `database_full.sql` | **Single source of truth** — drop & recreate from scratch for new deployments |
| `007_actor_user_id.sql` | Add `actors.user_id` |
| `007_skills.sql` | Add `skills` and `user_skills` tables |
| `008_team_api_logs.sql` | Add `team_api_logs` table |
| `009_notifications.sql` | Add `notifications` and `notification_types` tables |
| `010_team_invites_audit_index.sql` | Partial unique index on `team_invites` |
| `011_tasks_actor_role.sql` | Add `tasks.actor_role` |
| `012_github_oauth_webhooks.sql` | Add `github_oauth_states`, `github_connections.webhook_secret` |
| `013_team_github_tokens.sql` | Add `team_github_tokens` table |
| `014_external_agents.sql` | Add `company_agents`, `actors.webhook_url`, `actors.agent_api_key`, `actors.extra_env` |
| `015_ai_logs_task_id.sql` | Add `ai_logs.task_id` |
| `016_team_log_level.sql` | Add `teams.log_level` |
| `017_actor_docker_image.sql` | Add `actors.docker_image` |
| `018_update_claude_model_names.sql` | Normalize Claude model names |
| `019_project_memory.sql` | Add `memory_chunks`, `decisions`, `context_packs` |
| `020_memory_embeddings.sql` | Add `memory_chunks.embedding` and vector match RPC |
| `021_deliverables_files.sql` | Add deliverable files support |
| `022_memory_document_source_type.sql` | Add `document` to `memory_chunks.source_type` constraint |

For a fresh deployment run `database_full.sql` only. For existing deployments apply incremental migrations from `007_*` onward.

---

## Row-Level Security

All tables have RLS **enabled**. The backend connects with the **service role key** which bypasses RLS entirely. Anon/authenticated keys have no direct DB access — all data flows through the FastAPI backend.

Exceptions where non-service-role policies exist:

| Table | Policy |
|---|---|
| `notifications` | Users can `SELECT` and `UPDATE` their own rows (`auth.uid() = user_id`) |
| `notification_types` | Anyone can `SELECT` |

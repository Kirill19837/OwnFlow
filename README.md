# OwnFlow

Human-AI project orchestrator for company/team-based delivery.

> **[View project presentation →](https://kirill19837.github.io/OwnFlow/)**

OwnFlow turns a product prompt into a planned board of sprints and tasks, assigns work to human/AI actors, and supports streamed AI execution with a persistent activity trail.

## Current Snapshot

- Frontend: React + Vite + TypeScript + Tailwind + Zustand + TanStack Query
- Backend: FastAPI + Supabase (Postgres/Auth/Realtime) + OpenAI/Anthropic providers
- Multi-tenant hierarchy: Company → Team → Project → Sprint → Task
- Invite/onboarding flow: email invites, pending invite acceptance on sign-in, role-gated admin actions
- Security posture: identity from Supabase JWT on sensitive endpoints (no client-supplied requester IDs)

## Core Capabilities

### Auth and Onboarding

- Email/password auth with Supabase
- Magic-link and invite-link support
- Combined profile completion modal for brand-new invited users (name + password)
- Profile page for updating name/password and managing skills; delete account (with owner protections)
- Cross-host invite handling: pending team invites are accepted on login/session restore
- Organic signup: account deletion option from company setup page

### Skills

- Global skills catalogue stored in DB (17 seeded skills across categories)
- User skill profiles: multi-select pill UI grouped by category
- Skills shown per-member in team settings
- `SelectSkillsModal` presented after invite acceptance, new company creation, and magic-link onboarding
- AI project planning reads team member skills to assign work appropriately

### Companies, Teams, Roles

- Company creation flow with first team auto-created; delete-account option if user changes mind
- **Company settings**: rename company, update phone number, delete company (with full cascade); owner-only
- Team settings: rename, model selection, member invite/resend/revoke
- Role model: owner/admin/member using fixed UUID role IDs (stable across renames)
- Permissions:
  - owner/admin can invite
  - owner only can delete team or company
  - company name in header links to company settings for owners

### Projects and Planning

- Create project with prompt + actor roster
- AI planning stream (`/projects/{id}/plan/stream`) with live log events
- Sprint planning (including next-sprint generation)
- Kanban board with task status/assignment changes

### Task Execution and Context

- AI execution stream per task
- Deliverables persisted and viewable
- AI logs/messages persisted for traceability
- Task refinement support with structured decisions (`task_details`) and readiness flags (`ai_ready`, `is_ready`)
- Task interaction history persisted in `task_interactions`

## Architecture

- Frontend app: [frontend/src](frontend/src)
- Backend API: [backend/app/api](backend/app/api)
- Services/providers: [backend/app/services](backend/app/services), [backend/app/providers](backend/app/providers)
- Canonical schema: [supabase/migrations/001_schema.sql](supabase/migrations/001_schema.sql)
- Full DB reference: [docs/database.md](docs/database.md)
- Auth & onboarding flow: [docs/auth-flow.md](docs/auth-flow.md)
- Detailed release log: [DEVLOG.md](DEVLOG.md)

## Key API Areas

| Prefix | Description |
|---|---|
| `/auth/*` | Signup, magic link, has-password, delete account |
| `/companies/*` | CRUD companies; PATCH (rename/phone), DELETE (cascade) |
| `/teams/*` | Team management, invites, role changes |
| `/projects/*` | Projects, AI planning stream |
| `/tasks/*` | Task CRUD and AI execution |
| `/actors/*` | Human/AI actor management |
| `/skills/*` | Skills catalogue and user skill profiles |
| `/github/*` | GitHub PAT integration |

## Database Setup

### Option A: Fresh/full rebuild (recommended for new local DB)

Run [supabase/database_full.sql](supabase/database_full.sql) in Supabase SQL editor.

This script drops existing tables and recreates the current full schema, including:

- `projects.sprint_days`, `projects.roadmap`
- `actors.role`
- `tasks.task_details`, `tasks.is_ready`, `tasks.ai_ready`
- `task_interactions`
- `skills`, `user_skills`

### Option B: Incremental migration path

Use migration files in [supabase/migrations](supabase/migrations).

## Run Locally

### Prerequisites

- Python 3.13+
- Node.js 20+ (Node.js 24 recommended)
- Supabase project
- API keys for OpenAI and/or Anthropic

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Default local URLs:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8000`

CORS local dev ports are configured to allow Vite fallback ports (`5173–5180`).

## Quality Checks

From repo root:

```bash
make check-backend   # ruff lint + pytest (31 tests)
make check-frontend  # eslint + tsc + vite build
```

## Recent Changes (from DEVLOG)

### 2026-04-28

- Company settings page (rename, phone, delete with cascade); owner UUID-based permission check
- Skills catalogue from DB; user skill profiles; skills shown in team settings; `SelectSkillsModal` after invite/company creation
- `get_role_name` helper in backend; pending invite roles resolved to display names; role UUID fixes across FE
- Delete-account option added to company setup page
- 31 backend tests (invite flow, role resolution, company PATCH/DELETE)

### 2026-04-27

- Added standalone full database bootstrap script: [supabase/database_full.sql](supabase/database_full.sql)
- Fixed invite onboarding for cross-host login links
- Synced schema/docs for `sprint_days`, `roadmap`, `actors.role`, `task_details`, `is_ready`, `task_interactions`
- Updated local CORS handling for Vite fallback ports
- Upgraded dependencies: `python-dotenv` → `1.2.2`, `pytest` → `9.0.3`

### 2026-04-26

- Security hardening: sensitive identity from JWT dependency (`current_user_id`) instead of client query params
- Role-based team permissions enforced in backend and reflected in UI
- Profile page added (name/password/skills/delete account)
- Invite flow stabilized (combined modal behavior, accept-invites robustness, pending invite healing)

For full chronological details and commit-by-commit notes, see [DEVLOG.md](DEVLOG.md).


## Core Capabilities

### Auth and Onboarding

- Email/password auth with Supabase
- Magic-link and invite-link support
- Combined profile completion modal for brand-new invited users (name + password)
- Profile page for updating name/password and deleting account (with owner protections)
- Cross-host invite handling: pending team invites are accepted on login/session restore

### Companies, Teams, Roles

- Company creation flow with first team auto-created
- Team settings: rename, model selection, member invite/resend/revoke
- Role model: owner/admin/member using fixed UUID role IDs
- Permissions:
  - owner/admin can invite
  - owner only can delete team

### Projects and Planning

- Create project with prompt + actor roster
- AI planning stream (`/projects/{id}/plan/stream`) with live log events
- Sprint planning (including next-sprint generation)
- Kanban board with task status/assignment changes

### Task Execution and Context

- AI execution stream per task
- Deliverables persisted and viewable
- AI logs/messages persisted for traceability
- Task refinement support with structured decisions (`task_details`) and readiness flags (`ai_ready`, `is_ready`)
- Task interaction history persisted in `task_interactions`

## Architecture

- Frontend app: [frontend/src](frontend/src)
- Backend API: [backend/app/api](backend/app/api)
- Services/providers: [backend/app/services](backend/app/services), [backend/app/providers](backend/app/providers)
- Canonical schema: [supabase/migrations/001_schema.sql](supabase/migrations/001_schema.sql)
- Standalone full bootstrap SQL: [supabase/database_full.sql](supabase/database_full.sql)
- Full DB reference: [docs/database.md](docs/database.md)
- Detailed release log: [DEVLOG.md](DEVLOG.md)

## Key API Areas

- Auth: `/auth/*`
- Companies: `/companies/*`
- Teams: `/teams/*`
- Projects: `/projects/*`
- Tasks: `/tasks/*`
- Actors: `/actors/*`
- GitHub integration: `/github/*`

## Database Setup

### Option A: Fresh/full rebuild (recommended for new local DB)

Run [supabase/database_full.sql](supabase/database_full.sql) in Supabase SQL editor.

This script drops existing tables and recreates the current full schema, including:

- `projects.sprint_days`, `projects.roadmap`
- `actors.role`
- `tasks.task_details`, `tasks.is_ready`, `tasks.ai_ready`
- `task_interactions`

### Option B: Incremental migration path

Use migration files in [supabase/migrations](supabase/migrations).

## Run Locally

### Prerequisites

- Python 3.13+
- Node.js 20+ (Node.js 24 recommended)
- Supabase project
- API keys for OpenAI and/or Anthropic

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Default local URLs:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8000`

CORS local dev ports are configured to allow Vite fallback ports (`5173-5180`).

## Quality Checks

From repo root:

```bash
make check-backend
make check-frontend
```

## Recent Changes (from DEVLOG)

### 2026-04-27

- Added standalone full database bootstrap script: [supabase/database_full.sql](supabase/database_full.sql)
- Fixed invite onboarding for cross-host login links
- Synced schema/docs for `sprint_days`, `roadmap`, `actors.role`, `task_details`, `is_ready`, `task_interactions`
- Updated local CORS handling for Vite fallback ports
- Upgraded dependencies:
  - `python-dotenv` -> `1.2.2`
  - `pytest` -> `9.0.3`

### 2026-04-26

- Security hardening: sensitive identity from JWT dependency (`current_user_id`) instead of client query params
- Role-based team permissions enforced in backend and reflected in UI
- Profile page added (name/password/delete account)
- Invite flow stabilized (combined modal behavior, accept-invites robustness, pending invite healing)

### 2026-04-22 and earlier

- Company/team architecture refactor and org->team rename
- Email invite/magic-link improvements
- CI/lint stabilization and deploy pipeline hardening
- GitHub PAT integration and task/board AI workflow enhancements

For full chronological details and commit-by-commit notes, see [DEVLOG.md](DEVLOG.md).

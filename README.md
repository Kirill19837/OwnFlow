# OwnFlow

Human-AI project orchestrator for company/team-based delivery.

OwnFlow turns a product prompt into a planned board of sprints and tasks, assigns work to human/AI actors, and supports streamed AI execution with a persistent activity trail.

## Current Snapshot

- Frontend: React + Vite + TypeScript + Tailwind + Zustand + TanStack Query
- Backend: FastAPI + Supabase (Postgres/Auth/Realtime) + OpenAI/Anthropic providers
- Multi-tenant hierarchy: Company -> Team -> Project -> Sprint -> Task
- Invite/onboarding flow: email invites, pending invite acceptance on sign-in, role-gated admin actions
- Security posture: identity from Supabase JWT on sensitive endpoints (no client-supplied requester IDs)

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

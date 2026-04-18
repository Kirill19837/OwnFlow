# OwnFlow

Human-AI project orchestrator. Define a product prompt → AI breaks it into tasks → 3-day sprints → auto-assigns to AI/Human actors → AI actors execute tasks with streaming output.

## Stack
- **Frontend**: React + Vite + TypeScript + Tailwind CSS v3, Zustand, TanStack Query, react-router-dom v6, lucide-react, date-fns
- **Backend**: FastAPI + Python 3.9+, uvicorn, pydantic v2
- **Database / Auth / Realtime**: Supabase (PostgreSQL + Auth + Realtime)
- **AI Providers**: OpenAI (GPT-4o, GPT-4o Mini, o3-mini) + Anthropic (Claude 3.5 Sonnet, Claude 3.5 Haiku) — configurable per actor

---

## Implemented Features

### Authentication
- Email + password sign-up / sign-in via Supabase Auth
- Auth state persisted in Zustand (`authStore`)
- Protected routes — unauthenticated users redirected to `/login`

### Organisations (multitenancy)
- Create organisations with a name and default AI model
- Organisation switcher in the app header
- Projects are scoped to an organisation
- Org default AI model is inherited by new projects and actors
- Organisation settings page (rename, change default model)
- `orgStore` persists active org in localStorage

### Project Creation (`NewProjectPage`)
- **Name** + **Prompt** fields
- **Actor system** with 17 predefined role templates across 5 categories:
  - **Engineering**: Lead Developer, Senior Developer, Backend Developer, Frontend Developer, Architect, DevOps Engineer
  - **Quality**: QA Automation Lead, QA Manual, Security Reviewer
  - **Product**: Product Owner, Business Analyst, UI/UX Designer, Copywriter
  - **Management**: AI Project Manager, Scrum Master
  - **Feedback**: Beta User, Stakeholder
- "Both" type roles can be added as AI or Human (split chip button)
- **⚡ Auto-fill** — instantly populates 8-role default team with random AI names (Aria, Nova, Orion, etc.)
- Each actor has: **role** label, editable **personal name**, editable **characteristics**, **AI/Human toggle**, **AI model selector** (AI only)
- Human actors get an empty name field; AI actors get a random unique name from a 24-name pool
- **AI model override** per project (overrides org default)
- Button: **"✨ Create Project & Generate Plan"**

### AI Planning — Live Streaming Log
- On submit: project + actors created → SSE connection opened to `GET /projects/{id}/plan/stream`
- A dark modal overlay slides up from the bottom showing numbered monospace log lines streamed in real-time:
  ```
  01  🔍 Analyzing project: 'My App'
  02  ⚙️  Calling gpt-4o to generate task breakdown…
  03  📋 Generated 18 tasks
  04  📅 Organizing tasks into sprints…
  05  🗂️  Created 4 sprints
  06  🤖 Auto-assigning tasks to actors…
  07  ✅ Project plan is ready!
  08  🏁 Done! Redirecting…
  ```
- Pulsing `●` indicator while in progress; error shown in red with Close button
- Auto-navigates to project board ~1s after "Done"

### Dashboard (`DashboardPage`)
- Grid of project cards showing name, status icon, prompt excerpt, relative time
- Status badges: `planning` (yellow clock), `active` (green check), `error` (red alert)
- **Hover actions** per card (icon buttons, top-right):
  - **↺ Re-generate** (yellow) — wipes existing sprints/tasks, resets to `planning`, re-runs full AI plan stream in a modal log overlay
  - **🗑 Delete** (red) — confirms with native dialog, permanently deletes project + all cascade data
- After delete/re-generate, project list auto-refreshes via TanStack Query invalidation

### Project Board (`ProjectBoardPage`)
- Kanban columns: **To Do / In Progress / Review / Done**
- Task cards showing title, type badge, priority badge, estimated hours, assignee avatar
- **Task Drawer** — click any task to open a side panel with:
  - Full description and metadata
  - Assignee change (select any actor)
  - Status change
  - **Execute with AI** button — streams deliverable in real-time via SSE
  - Deliverable output rendered as Markdown
- Realtime sync across tabs via Supabase Realtime subscriptions (`useRealtimeProject` hook)

### AI Context & Audit Trail
Every AI interaction is persisted to the database:
- **`ai_logs`** — one row per log line emitted during planning or task execution (with `phase`, `level`, `created_at`)
- **`ai_messages`** — full verbatim record of every AI call: `messages` array (system + user prompt), raw `response`, `model`, `phase`, linked to `project_id` / `task_id` / `actor_id`

---

## Backend API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/projects` | Create project (`auto_plan: false` to skip background planning) |
| GET | `/projects` | List projects (`?org_id=` or `?owner_id=`) |
| GET | `/projects/{id}` | Get project with sprints, tasks, actors |
| DELETE | `/projects/{id}` | Hard delete project (cascade) |
| POST | `/projects/{id}/regenerate` | Wipe sprints/tasks, reset to planning |
| GET | `/projects/{id}/plan/stream` | SSE: run AI planning and stream log events |
| POST | `/projects/{id}/actors` | Add actor to project |
| GET | `/tasks/{id}` | Get task with assignments |
| PATCH | `/tasks/{id}/assign` | Manually assign actor to task |
| PATCH | `/tasks/{id}/status` | Update task status |
| POST | `/tasks/{id}/execute` | Execute task with AI (blocking) |
| GET | `/tasks/{id}/execute/stream` | SSE: execute task with AI (streaming) |
| GET | `/tasks/{id}/deliverables` | List deliverables for a task |
| GET | `/orgs/my` | Get orgs for a user |
| POST | `/orgs` | Create organisation |
| GET | `/orgs/{id}` | Get organisation |
| PATCH | `/orgs/{id}` | Update org (name, default model) |

### SSE Event Format
All SSE streams use:
```json
{"type": "log",   "message": "..."}   // log line
{"type": "done"}                       // completed successfully
{"type": "error", "message": "..."}   // error, stream ends
```

---

## Database Schema

### Tables
| Table | Purpose |
|-------|---------|
| `projects` | id, name, prompt, owner_id, org_id, status, created_at |
| `actors` | id, project_id, name, type (human\|ai), model, capabilities[], avatar_url |
| `sprints` | id, project_id, sprint_number, start_date, end_date, status |
| `tasks` | id, sprint_id, project_id, title, description, type, priority, status, estimated_hours, depends_on[] |
| `assignments` | task_id (unique), actor_id, assigned_by, assigned_at |
| `deliverables` | id, task_id, actor_id, content (Markdown), tool_calls_log |
| `project_members` | project_id, user_id, role |
| `organizations` | id, name, slug, owner_id, default_ai_model |
| `org_members` | org_id, user_id, role |
| `ai_logs` | id, project_id, phase, message, level, created_at |
| `ai_messages` | id, project_id, task_id, actor_id, phase, model, messages (jsonb), response, usage, created_at |

### Migrations
| File | Contents |
|------|----------|
| `001_initial.sql` | Core tables, RLS policies, Realtime publication |
| `002_organizations.sql` | `organizations` + `org_members` tables, org_id FK on projects |
| `003_ai_context.sql` | `ai_logs` + `ai_messages` tables, RLS, Realtime for ai_logs |

---

## AI Services

### `ai_orchestrator.py`
Calls the AI provider with a structured JSON prompt to break down the project description into 10–25 tasks. Persists the full message + response to `ai_messages`.

### `sprint_planner.py`
Topologically sorts tasks (respects `depends_on`), packs them into 3-day sprints (24h capacity each), writes `sprints` + `tasks` rows to Supabase.

### `assignment_engine.py`
Auto-assigns tasks to actors based on task type:
- `code`, `research`, `devops` → AI actors preferred
- `design`, `review`, `qa` → human actors if available, else AI
- Falls back to round-robin across all actors

### `actor_executor.py`
Builds full context (project brief + task description + prior deliverables) and calls the actor's AI model. Persists message context to `ai_messages` and a log entry to `ai_logs`. Supports both blocking (`execute_task`) and streaming (`stream_task_execution`).

### AI Providers (`providers/`)
- `base.py` — abstract `BaseProvider` with `complete()` and `stream()` async methods
- `openai_provider.py` — OpenAI implementation with `response_format` support
- `anthropic_provider.py` — Anthropic implementation
- `registry.py` — `get_provider(model)` selects provider by model name prefix

---

## Running Locally

### Prerequisites
- Python 3.9+
- Node.js 18+
- A Supabase project (free tier works)
- OpenAI API key and/or Anthropic API key

### 1. Apply Migrations
In [Supabase SQL Editor](https://supabase.com/dashboard/project/qscbbxbbwkbfgouhqheg/sql/new), run in order:
1. `supabase/migrations/001_initial.sql`
2. `supabase/migrations/002_organizations.sql`
3. `supabase/migrations/003_ai_context.sql`

Or with the CLI (after `supabase link --project-ref qscbbxbbwkbfgouhqheg`):
```bash
supabase db push
```

### 2. Backend
```bash
cd backend
cp .env.example .env
# Edit .env — set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
API: `http://localhost:8000` · Docs: `http://localhost:8000/docs`

### 3. Frontend
```bash
cd frontend
cp .env.example .env
# Edit .env — set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
# VITE_API_URL defaults to http://localhost:8000

npm install
npm run dev
```
App: `http://localhost:5173`

### Quick restart (both services at once)
```bash
lsof -ti :8000 | xargs kill -9 2>/dev/null
lsof -ti :5173 | xargs kill -9 2>/dev/null
cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000 &
cd frontend && npm run dev &
```

---

## Project Structure
```
OwnFlow/
├── frontend/src/
│   ├── components/
│   │   ├── AppLayout.tsx          header, org switcher, nav
│   │   ├── Auth.tsx               login/signup form
│   │   ├── TaskCard.tsx           kanban card
│   │   └── TaskDrawer.tsx         task detail side panel + AI execute
│   ├── hooks/
│   │   └── useRealtimeProject.ts  Supabase Realtime subscriptions
│   ├── lib/
│   │   ├── api.ts                 axios instance (baseURL → :8000)
│   │   ├── supabase.ts            Supabase client
│   │   └── utils.ts
│   ├── pages/
│   │   ├── LoginPage.tsx
│   │   ├── DashboardPage.tsx      project grid + delete + re-generate
│   │   ├── NewProjectPage.tsx     project form + actor builder + SSE log
│   │   ├── NewOrgPage.tsx
│   │   ├── OrgSettingsPage.tsx
│   │   └── ProjectBoardPage.tsx   kanban board + task drawer
│   ├── store/
│   │   ├── authStore.ts           Zustand — session
│   │   ├── orgStore.ts            Zustand — active org (persisted)
│   │   └── projectStore.ts        Zustand — project + tasks
│   └── types.ts                   Project, Actor, Sprint, Task, Deliverable
│
├── backend/app/
│   ├── api/
│   │   ├── projects.py            CRUD + DELETE + regenerate + SSE plan/stream
│   │   ├── tasks.py               CRUD + assign + execute + SSE execute/stream
│   │   ├── actors.py              CRUD
│   │   └── orgs.py                CRUD
│   ├── providers/
│   │   ├── base.py
│   │   ├── openai_provider.py
│   │   ├── anthropic_provider.py
│   │   └── registry.py
│   ├── services/
│   │   ├── ai_orchestrator.py     task breakdown + ai_messages persistence
│   │   ├── sprint_planner.py      topo-sort + sprint packing
│   │   ├── assignment_engine.py   auto-assign by task type
│   │   └── actor_executor.py      execute/stream + ai_messages + ai_logs
│   ├── main.py                    FastAPI app + CORS
│   ├── models.py                  Pydantic models
│   ├── config.py                  Settings (env vars)
│   └── db.py                      Supabase client singleton
│
└── supabase/
    ├── migrations/
    │   ├── 001_initial.sql
    │   ├── 002_organizations.sql
    │   └── 003_ai_context.sql
    └── seed.sql                   optional demo org + project
```

---

## Known State
- **Supabase project ref**: `qscbbxbbwkbfgouhqheg`
- **Org "OSKI"** already created (`owner_id: 0faa211a-18a4-4c4a-9a4b-9f111986c6bd`)
- All 3 migrations applied to the remote Supabase project
- Backend runs on port **8000**, frontend on port **5173**
- Git: single `main` branch, initial commit `5f335a3`


---

## Setup

### 1. Supabase — Apply Migrations & Seed

#### Option A — Supabase CLI (recommended, requires the CLI)
```bash
# Install CLI once
brew install supabase/tap/supabase

# Link to your remote project (find the project ref in Settings → General)
supabase link --project-ref qscbbxbbwkbfgouhqheg

# Push all migrations in order
supabase db push

# (Optional) seed demo data
supabase db execute --file supabase/seed.sql
```

#### Option B — SQL Editor (no CLI needed)
1. Open **[Supabase SQL Editor](https://supabase.com/dashboard/project/qscbbxbbwkbfgouhqheg/sql/new)**
2. Paste and run `supabase/migrations/001_initial.sql`
3. Paste and run `supabase/migrations/002_organizations.sql`
4. (Optional) paste and run `supabase/seed.sql` to load demo data

#### Option C — psql (direct connection)
```bash
# Connection string is in Supabase → Settings → Database → Connection string (URI mode)
export DATABASE_URL="postgresql://postgres:<password>@db.qscbbxbbwkbfgouhqheg.supabase.co:5432/postgres"

psql "$DATABASE_URL" -f supabase/migrations/001_initial.sql
psql "$DATABASE_URL" -f supabase/migrations/002_organizations.sql
psql "$DATABASE_URL" -f supabase/seed.sql   # optional demo data
```

After applying migrations, copy your **Project URL**, **anon key**, and **service role key** from **Settings → API**.

### 2. Backend
```bash
cd backend
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```
API runs at `http://localhost:8000`. Docs at `http://localhost:8000/docs`.

### 3. Frontend
```bash
cd frontend
cp .env.example .env
# Fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL=http://localhost:8000

npm install
npm run dev
```
App runs at `http://localhost:5173`.

### 4. Docker (alternative)
```bash
cp backend/.env.example backend/.env   # fill values
cp frontend/.env.example frontend/.env # fill values
docker compose up --build
```

---

## How it works

1. **Sign up / sign in** with email + password (Supabase Auth)
2. **New Project** → type a product description, add AI/Human actors, pick AI models
3. **Generate Plan** → backend calls AI to break the prompt into 10-25 tasks, packs them into 3-day sprints, auto-assigns tasks (code/research/qa → AI actors, design/review → human actors)
4. **Sprint Board** → Kanban columns (To Do / In Progress / Review / Done), drag-and-drop status
5. **Task Drawer** → click any task to see details, change assignee, change status, or hit **Execute with AI** to stream a deliverable in real-time
6. **Realtime** → all changes (task status, assignments, deliverables) sync live across browser tabs via Supabase Realtime

---

## Project structure
```
OwnFlow/
├── frontend/
│   └── src/
│       ├── components/   AppLayout, Auth, TaskCard, TaskDrawer
│       ├── hooks/        useRealtimeProject
│       ├── lib/          supabase, api, utils
│       ├── pages/        LoginPage, DashboardPage, NewProjectPage, ProjectBoardPage
│       ├── store/        authStore, projectStore
│       └── types.ts
├── backend/
│   └── app/
│       ├── api/          projects, tasks, actors
│       ├── providers/    base, openai, anthropic, registry
│       ├── services/     ai_orchestrator, sprint_planner, assignment_engine, actor_executor
│       ├── main.py
│       ├── models.py
│       └── db.py
└── supabase/
    ├── migrations/
    │   ├── 001_initial.sql       core tables + RLS + Realtime
    │   └── 002_organizations.sql multitenancy: orgs + org_members
    └── seed.sql                  optional demo data
```

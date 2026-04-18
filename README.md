# OwnFlow

Human-AI project orchestrator. Define a product prompt → AI breaks it into tasks → 3-day sprints → auto-assigns to AI/Human actors → AI actors execute tasks with streaming output.

## Stack
- **Frontend**: React + Vite + TypeScript + Tailwind CSS
- **Backend**: FastAPI + Python
- **Database / Auth / Realtime**: Supabase
- **AI**: OpenAI (GPT-4o) + Anthropic (Claude) — configurable per actor

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

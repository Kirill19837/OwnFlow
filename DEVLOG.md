# OwnFlow — Development Log

---

## 2026-04-18 | `05f7d3b` — Assignment display fix, actor roles, realtime store crash
- Fixed "Assigned to" dropdown staying on Unassigned after saving: now tracks task by ID and resolves live from query cache
- Fixed realtime store crash (`findIndex is not a function`): guarded `assignments` with `Array.isArray()`, fixed predicate to match `assignment.id`
- Added `role` field to actors (full stack: Supabase `ALTER TABLE`, backend models + insert, frontend types + UI)
- Task drawer actor dropdown shows role label (e.g. "Lead QA") with model as fallback
- Add Actor form in settings now has a Role input field
- Handle unassign (empty `actor_id`) in `PATCH /tasks/{id}/assign` — deletes assignment without FK error
- Added "Start Work" button (no-op) to task drawer

---

## 2026-04-18 | `2f5729b` — Settings panel: name, description, actor management
- Expanded project settings panel to include editable project name and description/prompt
- Added actor management in settings: list existing actors with delete button, add new actor form (name + AI/Human toggle + model selector)
- Backend: `DELETE /actors/{id}` endpoint added to `actors.py`
- Backend: `prompt` field allowed in `PATCH /projects/{id}/settings`

---

## 2026-04-18 | `d720a49` — Progressive sprint planning + settings sprint days
- AI now generates roadmap + Sprint 1 only on project creation (instead of all sprints at once)
- New endpoint `POST /projects/{id}/sprints/next` — generates next sprint on-demand using stored roadmap
- New endpoint `PATCH /projects/{id}/settings` — editable sprint days per project
- Added `roadmap JSONB` and `sprint_days INT` columns to Supabase `projects` table
- Frontend: "Plan Next Sprint" button on board, sprint days picker in settings panel, sprint days picker on new project creation
- Frontend: `SprintTheme` type, `sprint_days` and `roadmap` fields on `Project`

---

## 2026-04-18 | `e74d221` — AI context persistence, delete/regen, role templates, streaming log
- Persist AI planning context to Supabase for consistent actor roles across sprints
- Delete and regenerate plan endpoints
- Role/capability templates for actors
- Streaming log UI for live planning progress

---

## 2026-04-18 | `8e0dc18` — Initial OwnFlow platform
- Full project scaffold: React + Vite + TypeScript frontend, FastAPI backend, Supabase DB
- Auth via Supabase, org/project/actor/sprint/task data model
- AI orchestration via OpenAI and Anthropic APIs
- Project board UI with sprint/task views, new project wizard

# OwnFlow — Development Log

---

## 2026-04-18 | `145a911` — Board chat minimize + agent-aware task drawer chat
- Board: minimize/restore toggle collapses prompt bar to a compact pill; history preserved while minimized
- Task drawer: agent-aware Q&A chat panel
  - Agent name and role shown in chat header
  - Placeholder reads "Ask Alice…" when an actor is assigned
  - Silent buffering while thinking — shows "Alice is thinking…" spinner, no raw JSON exposed
  - Three structured action cards from agent responses:
    - **assign_actor** (blue) — shows target actor, confirm assigns them
    - **update_status** (yellow) — shows `old → new` status, apply button
    - **execute_task** (purple) — one-click AI execution trigger
  - Each confirm button turns green "Done" after acting; disables to prevent double-fire
  - Clear button in agent header resets the conversation
- Backend: task prompt endpoint now speaks as the assigned actor by name,
  lists all project actors with IDs so AI can produce real `assign_actor` intents

---

## 2026-04-18 | `0b9cfe3` — AI prompt chat on kanban + structured task actions
- Task drawer: pinned chat panel at bottom with streaming AI responses, task/project context in system prompt
- Board: floating prompt bar (fixed bottom-center) with project-level AI chat
- Structured intent system: AI returns a fenced JSON block for task operations instead of prose
  - `create_tasks` → purple card with "Add to board" button
  - `modify_tasks` → blue card with "Apply changes" button (real task IDs from context)
  - `delete_tasks` → red card with strikethrough titles and "Delete tasks" button
- Silent buffering: raw JSON never shown to user; "Thinking…" spinner shown while processing
- Each action card confirms before executing; turns green "Done" after success
- Backend: `POST /projects/{id}/tasks` — bulk create tasks in active sprint
- Backend: `PATCH /projects/{id}/tasks/batch` — bulk update task fields
- Backend: `DELETE /projects/{id}/tasks/batch` — bulk delete by task IDs
- Backend system prompt now includes all task IDs + full task list for AI reference
- Fixed 500 on `/projects/{id}/prompt/stream`: removed non-existent `sprints.theme` column

---

## 2026-04-18 | `548bee9` — Workflow progression button and Rework column
- Added Rework column to board (5 columns total: To Do, In Progress, Review, Done, Rework)
- Wired Start Work button to advance task through workflow: `todo→in_progress→review→done`, `rework→in_progress`
- Button label adapts to current status: Start Work / Submit for Review / Mark Done / Done ✓ / Resume Work
- Backend: `rework` added to allowed task statuses in `PATCH /tasks/{id}/status`

---

## 2026-04-18 | `02c9f01` — Assignment display fixes (board + drawer)
- Root cause: Supabase returns `assignments` as `{}` (object) instead of `[]` (array) when the table has a unique constraint on `task_id`
- Normalized assignments to array in the project query (ProjectBoardPage)
- TaskDrawer `assignedActor` lookup now handles both object and array shapes
- TaskCard on the board now shows assigned actor name correctly
- Used `setQueryData` in assign mutation to update cache instantly, avoiding race with background refetch

---

## 2026-04-18 | `eaf2132` — Settings panel bug fixes
- Fixed Save changes button permanently disabled (wrong guard condition removed)
- Re-added missing `planNextSprint` mutation that was dropped in a previous edit
- Added try/except to settings PATCH endpoint for cleaner error reporting
- Added `sprint_days` and `roadmap` columns to Supabase `projects` table (SQL migration)

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

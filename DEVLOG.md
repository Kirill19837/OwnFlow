# OwnFlow — Development Log

---

## 2026-04-22 | `d676497` — Python 3.13 upgrade, fix .env path resolution, fix accept-invites spam

- `Dockerfile` — updated base image from `python:3.12-slim` → `python:3.13-slim`
- `.github/workflows/ci.yml` — updated CI Python from `3.11` → `3.13`
- `requirements.txt` — updated `python-multipart` `0.0.20` → `0.0.26` (requires Python ≥ 3.10)
- `app/config.py` — fixed `env_file` to use absolute path resolved from `__file__` so `.env` is found regardless of uvicorn working directory (`--app-dir` flag)
- `frontend/src/components/Auth.tsx` — `accept-invites` now only fires on `SIGNED_IN` event, not on every page refresh/session restore (was called 2–3× per page load)

---

## 2026-04-22 | `e3addee` — Fix remaining ruff F841: remove unused invite_resp

- `app/api/orgs.py` — removed `invite_resp = None` initialisation and `invite_resp = link_resp` assignment (variable was never read after the postmark path was cleaned up)

---

## 2026-04-22 | `e36acc6` — Fix all ruff lint errors; add Makefile pre-commit checks

- `app/api/orgs.py` — removed unused `invite_tracking_enabled` and `invite_resp` variables
- `app/api/projects.py` — removed unused `result` assignment and renamed `exc` → bare `except`
- `app/main.py` — removed unused `division_by_zero` assignment in sentry-debug endpoint (`1 / 0` inline)
- `app/providers/openai_provider.py` — removed unused `import json`
- `app/services/sprint_planner.py` — removed unused `sprint_num = 0` variable
- `Makefile` — added `make check` (runs both), `make check-backend` (ruff + pytest), `make check-frontend` (eslint + tsc + build)

---



- `requirements.txt` — removed `pytest` and `pytest-httpx` (were causing `httpx` version conflict in Docker build: `pytest-httpx==0.35` needs `httpx==0.28.*` but `supabase 2.7.4` needs `httpx<0.28`)
- `requirements-dev.txt` — new file: `-r requirements.txt` + `pytest==8.3.5` for local dev and CI
- `.github/workflows/ci.yml` — backend job now installs `requirements-dev.txt`, renamed to "Backend — lint & test", added `python -m pytest tests/ -v` step with placeholder Supabase env vars

---



**Security fix**
- `app/api/orgs.py` — `invite_member_by_email` now checks `email_confirmed_at` before treating an auth user as "existing"; unconfirmed/ghost users (created by prior `generate_link` calls) are routed through the invite flow instead of being added directly to `org_members`. This closed a gap where a pending user could gain org access without ever verifying email ownership.
- Cleaned up dirty `org_members` row that was created by the old logic for `asset19837@gmail.com`

**Notification email for directly-added users**
- `app/email.py` — added `send_added_to_org_email()` — branded HTML email sent when a confirmed existing user is added directly to an org (no invite link needed)
- `app/api/orgs.py` — `existing_user_id` branch now calls `send_added_to_org_email` (non-blocking try/except so member addition never fails if email is down)

**Invite flow tests**
- `backend/tests/test_invite_flow.py` — 7 unit tests covering: new-email invite, confirmed-user direct-add, unconfirmed-user invite routing, invalid email 400, non-member 403, accept-invites happy path, accept-invites with no pending
- `requirements.txt` — added `pytest==8.3.5` and `pytest-httpx==0.35.0`

**Backend async → def conversion (event loop fix)**
- `app/api/orgs.py`, `projects.py`, `tasks.py`, `actors.py`, `github.py` — all sync-only route handlers converted from `async def` to `def` so FastAPI runs them in a threadpool instead of blocking the event loop (was causing 500s and hanging requests)

**Frontend**
- `OrgSettingsPage.tsx` — resend invite button (`RotateCcw`) next to "invite sent" badge; `resendingEmail` state drives spinner animation
- Fixed all 23 ESLint errors across `TaskDrawer.tsx`, `TaskCard.tsx`, `Auth.tsx`, `useRealtimeProject.ts`, `taskActions.ts`, `ProjectBoardPage.tsx`, `ProjectActivityPage.tsx`, `LoginPage.tsx`, `NewOrgPage.tsx`, `NewProjectPage.tsx`

---

## 2026-04-22 | `TBD` — Fix deploy: consolidate env into single .env.prod for docker compose

- `.github/workflows/deploy.yml` — merged backend + frontend vars into one `.env.prod` file so `docker compose --env-file` interpolates all `${VAR}` references in `docker-compose.prod.yml` (was writing separate `backend/.env` that never reached compose interpolation, causing backend 500 on startup)

---

## 2026-04-22 | `09e6e22` — Add Sentry error monitoring + fix deploy env injection

**Backend**
- `requirements.txt` — added `sentry-sdk[fastapi]`
- `app/config.py` — added `sentry_dsn: str = ""` setting
- `app/main.py` — init Sentry before app creation (only when `SENTRY_DSN` is set); added `GET /sentry-debug` endpoint to verify Sentry capture
- `backend/.env` — added `SENTRY_DSN` for local dev

**Deploy**
- `deploy.yml` — consolidated backend + frontend vars into single `.env.prod` so `docker compose --env-file` interpolates all `${VAR}` references in `docker-compose.prod.yml` (fixes backend 500 on startup — previously backend vars were written to `backend/.env` which was never read by compose); added `SECRET_SENTRY_DSN` injection
- `docker-compose.prod.yml` — added `SENTRY_DSN: ${SENTRY_DSN}` to backend environment block

---

## 2026-04-22 | `2539f58` — Fix CI: sync package-lock.json

- `frontend/package-lock.json` — regenerated to include missing `@emnapi/core` and `@emnapi/runtime` packages that were out of sync

---

## 2026-04-22 | `57d2c55` — CI status checks + deploy injects Postmark vars

**CI / Deploy**
- `.github/workflows/ci.yml` (new) — CI pipeline: frontend lint + type-check + build, backend ruff lint; runs on every push and PRs to `main`
- `.github/workflows/deploy.yml` — pass `POSTMARK_TOKEN` (secret) and `POSTMARK_FROM` (var) into backend `.env` on deploy
- `docker-compose.prod.yml` — switched from `env_file` to explicit `environment:` entries for platform-injected secrets/vars

---

## 2026-04-22 | `28516a7` — Email-based org invites via Postmark, fix org isolation, fix infinite render loop

**Backend**
- `app/email.py` (new) — Postmark HTML invite email sender via `httpx`
- `app/config.py` — added `postmark_token`, `postmark_from`, `postmark_enabled` property
- `app/api/orgs.py` — full email invite flow: existing users added directly, new users get Postmark invite email + pending record; `GET /{org_id}` enriches members with emails from auth; `POST /accept-invites` auto-joins pending orgs on login
- `supabase/migrations/004_org_invites.sql` (new) — `org_invites` table tracking pending/accepted/revoked invites
- `app/api/projects.py` — guard: return `[]` if no `org_id`/`owner_id` provided (prevents cross-user data leak)
- `docker-compose.prod.yml` — switched from `env_file` to explicit `environment:` entries so platform secrets/variables (`POSTMARK_TOKEN`, `POSTMARK_FROM`, etc.) are injected at deploy time

**Frontend**
- `OrgSettingsPage.tsx` — invite by email (not UUID), shows member emails, optimistic "invite sent" badge for pending invites
- `Auth.tsx` — calls `POST /orgs/accept-invites` on every session load to auto-accept pending invites after login
- `types.ts` — `OrgMember.email?`, `OrgPendingInvite` interface, `Organization.pending_invites?`
- `store/orgStore.ts` — `setOrgs` falls back to `orgs[0]` if persisted `activeOrg` not found (prevents stale org after logout)
- `components/AppLayout.tsx` — fixed infinite render loop (stable mutation refs); auto-creates default org for new users; clears org state on sign-out and user switch

---

## 2026-04-18 | `fc7d941` — GitHub per-project PAT integration with auto PR creation

Each project owner enters their own GitHub Personal Access Token + target repo in project settings. No shared GitHub App credentials required.

**Backend**
- `migrations/003_github_integration.sql` — new `github_connections` table + `tasks.github_pr_url` column
- `app/services/github_service.py` — PAT-based: `verify_token`, `create_branch`, `commit_file`, `open_pull_request`, `create_pr_for_task`
- `app/api/github.py` — `POST /github/connect` (validates token against repo), `GET /status`, `PATCH /repo`, `DELETE /disconnect`
- `actor_executor.py` — calls `create_pr_for_task` after deliverable saved (both sync and stream), silently skips if not connected
- Removed shared GitHub App config fields and PyJWT/cryptography dependencies

**Frontend**
- Project settings panel: GitHub section with PAT + repo form, connected state with repo display, change repo input, disconnect button
- `TaskCard`: PR badge icon linking to GitHub when `github_pr_url` is set
- `TaskDrawer`: Pull Request section with clickable PR link

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

## 2026-04-18 — Unified Copilot panels + execution log

### Features shipped
- **Execution plan card** — backend `execute_stream` now emits `{"type":"plan","content":"..."}` before streamed output; task drawer shows a purple ✦ plan card announcing what the agent is about to do
- **Deliverable chat card** — execution output lands as a green-bordered card (FileText icon) in the task chat log; persisted deliverables also injected into chat on drawer open
- **`update_description` intent** — agent can propose saving content to the task's description field; teal action card with "Save to task" confirm button; backed by `PATCH /tasks/{id}/description` endpoint
- **Unified chat log** — `chat: ChatMsg[]` replaces the old separate `chatHistory` / `streamContent` / streaming states; renders five message kinds: user, assistant, thinking, plan, deliverable
- **Collapse/expand both Copilot panels** — both the floating board chat and the task drawer chat now have a matching top-right ChevronDown collapse button; consistent header row with title, optional Clear, and the toggle
- **Parse error fixed** — JSX nesting issue in `ProjectBoardPage.tsx` board panel block resolved

### Files changed
- `backend/app/api/tasks.py` — typed SSE events, `PATCH /{task_id}/description`, `update_description` in system prompt
- `frontend/src/components/TaskDrawer.tsx` — unified chat log, collapse toggle, all new card renderers
- `frontend/src/pages/ProjectBoardPage.tsx` — matching Copilot panel header with top-right collapse


## 2026-04-18 — Multi-action refinement renderer

### What was built
- **Backend refinement protocol** (`tasks.py`): When user asks to "refine/clarify/improve description", AI follows a 4-step protocol:
  1. Emit `update_description` with clear markdown desc + acceptance criteria
  2. Emit `update_details` for all inferable facts (skipping already-captured keys)
  3. Ask remaining open questions as numbered plain-text list
  4. On each answer: emit `update_details`, emit `mark_ready` when all answered
- **Context injection**: `task_details` JSONB rendered as `key: value` lines in system prompt so AI never re-asks captured facts
- **Persistence**: Every user + assistant message saved to `task_interactions` table

### Frontend changes (`TaskDrawer.tsx`)
- `parseAllTaskActions(content)` — extracts all fenced JSON blocks from one message
- `stripActionBlocks(content)` — removes JSON blocks, returns trailing prose/questions
- Assistant renderer replaced: each message now renders N action cards (one per JSON block) with compound confirmed-state key `i*1000+j`, followed by prose section
- Old single-action renderer fully removed

## 2026-04-18 — Project Activity page

### What was built
- **Backend** `GET /projects/{id}/activity`: fetches all `task_interactions` + `task_details` for every task in the project; returns `{ interactions, decisions }`
- **`ProjectActivityPage.tsx`** at `/projects/:id/activity`:
  - **Chat Log tab**: all AI/human messages across all tasks, chronologically ordered, grouped under task-name dividers, with task-filter pills when multiple tasks involved
  - **Decisions tab**: every task that has `task_details` shown as a key/value card; task names link back to the board
- Route added to `App.tsx`; Activity icon (📊) button added to project board header next to settings gear

## 2026-04-18 — Title + description refinement & workflow button labels

### update_description now saves title
- Backend `PATCH /{task_id}/description` accepts optional `title`; updates both in one DB write
- System prompt STEP 1 instructs AI to emit `"title"` (≤10 words) alongside `"content"`
- `taskActions.ts`: `update_description` union gains `title?: string`
- TaskDrawer card shows new title in preview row; button label → "Save title & description"
- AssistantMessage readonly card shows title in activity log

### Workflow button renamed
- "Start Work" → "Move to In Progress"
- "Submit for Review" → "Move to Review"
- "Mark Done" → "Move to Done"
- "Resume Work" → "Move to In Progress"

## 2026-04-18 — Copilot collapsed by default + task activity shortcut

- **TaskDrawer**: copilot panel now starts collapsed (`useState(false)`) — opens only when needed
- **TaskDrawer**: Activity icon button (📊) added next to close button — navigates to `/projects/:id/activity?task=<taskId>`
- **ProjectActivityPage**: reads `?task=` query param on mount and pre-filters the Chat Log tab to that specific task

## 2026-04-22 — Company/Team architecture refactor (c431ad8)
- Introduced Company as top-level tenant boundary (migration 005_companies.sql)
- Added /companies backend API (create, my, teams listing)
- Renamed Org→Team throughout UI; /company/new onboarding page for new users
- Team rename (inline) and delete (danger zone) in settings page
- invite_org scoping + company-aware accept-invites flow

## 2026-04-22 — Company registration page + team rename/delete (c25efb0)
- NewCompanyPage: two-panel layout, required company name + phone, AI model radio selector
- Add phone column to companies table (migration 006_company_phone.sql)
- OrgSettingsPage: inline team rename (pencil icon) + danger-zone delete
- Fix TS narrowing bug in rename/delete store updates
- CI: skip runs on *.md / pitch / seed-only commits

## 2026-04-22 — Custom Postmark signup confirmation emails (pending commit)
- New POST /auth/signup backend endpoint: uses generate_link(type="signup") + Postmark
- Bypasses Supabase rate-limited mailer for all signup confirmations
- LoginPage: shows branded "Check your email" screen after signup
- authStore.signUp() now calls backend instead of Supabase directly

## 2026-04-22 — Invite flow overhaul + magic link sign-in (ee1df47)

- **Pending-only invites**: all email invites now create a pending `org_invites` row; confirmed existing users get a login-notification email and are added to the org on next sign-in
- **Auth.tsx session restore**: accept invites for already-logged-in users clicking invite links
- **NewCompanyPage guard**: redirect to / if user already has a company
- **LoginPage guard**: redirect to / if session already active
- **SetPasswordModal**: shown after magic-link/invite sign-in so user can set a permanent password
- **POST /auth/magic-link**: Supabase generate_link + Postmark delivery
- **Wrong-password magic link**: LoginPage surfaces "Send magic link" after failed password attempt, rate-limited 1h via localStorage

## 2026-04-22 — User display name (fdebcad)

- Signup form now collects full name (required field)
- Backend writes full_name to user_metadata on signup
- SetNameModal prompts existing users missing a name after sign-in
- GET /auth/has-password replaces URL hash detection for SetPasswordModal

## 2026-04-22 — CompleteProfileModal + AMR-based password detection (89d364e)

- Single combined modal for name + password (replaces two separate modals)
- JWT AMR claim detection: method=otp triggers password prompt; existing password users unaffected
- Fixed apostrophe parse error in JSX string literals

## 2026-04-26 — Dark/light theme toggle + bug fixes (d07add1)

- Dark/light theme toggle: Zustand store with localStorage persistence (`themeStore.ts`)
- CSS override approach — `html:not(.dark)` selectors in `index.css` flip all gray Tailwind utilities to light palette; zero JSX component changes needed
- `tailwind.config.js`: added `darkMode: 'class'`
- `main.tsx`: applies saved theme before first React render (no flash on reload)
- `AppLayout.tsx`: Sun/Moon toggle button in header; user display name shown from `user_metadata.full_name`
- Fix: removed `from __future__ import annotations` in `auth.py` — was causing Pydantic `PydanticUndefinedAnnotation: SignupBody` crash on startup
- Fix: apostrophe parse error in `CompleteProfileModal.tsx` — `'What's your name?'` → `"What's your name?"`
- Added `docs/auth-flow.md` — comprehensive auth flow documentation

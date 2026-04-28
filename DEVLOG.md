# OwnFlow — Development Log

---

## 2026-04-28 | `96a81e2` — feat: skills selection modal after invite onboarding; fix role UUID display on invite card

- `frontend/src/store/authStore.ts` — added `needsSkills: boolean` + `setNeedsSkills` action; clears on sign-out
- `frontend/src/components/CompleteProfileModal.tsx` — after saving name/password for the `set_password` (invite) flow, sets `needsSkills(true)` before closing
- `frontend/src/components/SelectSkillsModal.tsx` — new modal: pill multi-select grouped by category, "Save skills" → `PUT /skills/user`, "Skip for now" dismisses without saving
- `frontend/src/components/AppLayout.tsx` — mounts `SelectSkillsModal` when `needsSkills` is true
- `frontend/src/pages/InvitePage.tsx` — added `ROLE_NAMES` map + `resolveRole()` helper; invite card now shows `member`/`admin`/`owner` instead of raw UUID

## 2026-04-28 | `2902e2b` — feat: show member skills in team settings page

- `frontend/src/pages/OrgSettingsPage.tsx` — member rows now display skill pills; uses `useQueries` to batch-fetch each member's skills in parallel (cached 5 min); added `Skill` type import

## 2026-04-28 | `b1565bc` — feat: skills catalogue from DB; user skill profile selection; NewProjectPage uses API skills

- `supabase/migrations/007_skills.sql` — new `skills` table (id, name, category, description, actor_type) seeded with 17 roles; `user_skills` join table with RLS policies
- `supabase/database_full.sql` — added skills + user_skills table definitions and seed data
- `backend/app/api/skills.py` — new router: `GET /skills`, `GET /skills/categories`, `GET /skills/user/{user_id}`, `PUT /skills/user` (auth-gated, max 10 skills)
- `backend/app/main.py` — registered skills router at `/skills`
- `frontend/src/types.ts` — added `Skill` interface
- `frontend/src/pages/NewProjectPage.tsx` — removed all hardcoded `ROLE_TEMPLATES`; role picker and auto-fill now fetch from `GET /skills` API; used `useRef` guard to fix `react-hooks/set-state-in-effect` lint error
- `frontend/src/pages/ProfilePage.tsx` — added "My skills" section: pill-style multi-select grouped by category, fetches user's current skills, saves via `PUT /skills/user`

## 2026-04-28 | `13b7f1c` — Security: use role UUIDs for all permission checks (FE+BE); add my_role_id and role_id to API responses

- `backend/app/api/teams.py` — `get_team` now returns `my_role_id` (raw role UUID for the caller) and `role_id` on each member object alongside the human-readable `role`/`my_role` names
- `frontend/src/types.ts` — added `my_role_id?: string` to `Team`, `role_id: string` to `TeamMember`
- `frontend/src/pages/OrgSettingsPage.tsx` — added `ROLE_IDS` const (matching backend fixed UUIDs); all permission checks (`canInvite`, `canDelete`, role dropdown condition) now compare against UUID constants instead of name strings — immune to role renames

## 2026-04-28 | `83c69be` — Fix: role UUID display in team members; add role change endpoint; compare roles by UUID not name

- `backend/app/api/teams.py` — `get_team` now converts each member's raw role UUID to a human-readable name before returning; `_require_member` updated to return raw UUID and compare against `ROLE_IDS` constants (not string names); added `PATCH /{team_id}/members/{user_id}` endpoint for owner to change member roles (admin ↔ member); docstring updated
- `frontend/src/pages/OrgSettingsPage.tsx` — added `changeRole` mutation; member role displays as a dropdown (`<select>`) for owners on non-owner members, static text for everyone else

## 2026-04-28 | `24c7ab3` — UX: show full_name and email for team members, remove user_id display

- `backend/app/api/teams.py` — `get_team` now fetches `user_metadata.full_name` from admin user list and attaches it to each member object alongside `email`
- `frontend/src/types.ts` — added `full_name?: string` to `TeamMember` interface
- `frontend/src/pages/OrgSettingsPage.tsx` — member rows show full name (primary) + email (secondary) + role; raw UUID is never displayed; falls back gracefully to email-only or "Unknown user"

## 2026-04-28 | `b96b236` — Security: member role restrictions on team settings + team list filtering

- `frontend/src/pages/OrgSettingsPage.tsx` — hide remove-member trash icon and revoke-invite trash icon for non-admin/owner users (gate on `canInvite`); disable Default AI Model buttons for members (`disabled` + `cursor-not-allowed` + reduced opacity)
- `backend/app/api/companies.py` — `GET /{company_id}/teams?user_id=…` now filters to only teams the user is a member of; previously returned all teams in the company regardless of membership

---

## 2026-04-28 | `bb3789c` — Fix: auth guards on remove_member/revoke_invite; refactor with _require_member helper

- `backend/app/api/teams.py` — `DELETE /{team_id}/members/{user_id}` had zero authorization: any authenticated user could remove any member from any team. Fixed with full role-based checks (owner can remove anyone, admin can remove members only, members can only leave themselves, owner cannot leave). `DELETE /{team_id}/invites/{invite_id}` (revoke) was similarly unguarded — now requires owner or admin. Introduced `_require_member(db, team_id, user_id) -> str` helper to eliminate the repeated 9-line membership-lookup pattern used in 4 endpoints (`invite_member_by_email`, `delete_team`, `remove_member`, `revoke_invite`).

---

## 2026-04-28 | `af5429c` — Fix InvitePage: show invite card first, collect profile only after Accept

- `frontend/src/pages/InvitePage.tsx` — reordered the step machine: `loading → invite-card → (profile) → accepting`. Previously the profile form (name + password) was shown before the user could see the invite details, meaning declining still asked for a password. Now Decline immediately marks the invite declined and signs the user out; Accept checks if name/password are needed and routes through the profile step only if so. After saving credentials via `supabase.auth.updateUser`, `doAccept()` fires and navigates to dashboard.
- `docs/auth-flow.md` — updated §4 (team invite new user) and §6 (InvitePage step machine) to reflect new order.

---

## 2026-04-28 | `f9ef148` — Fix CompleteProfileModal: save password immediately for magic-link (set_password) users

- `frontend/src/components/CompleteProfileModal.tsx` — when `linkType === 'set_password'`, the modal now calls `supabase.auth.updateUser({ password, data: { password_set: true, full_name? } })` directly and clears `needsPassword`/`needsName` flags; user stays on dashboard. Previously the modal stored to `pendingProfile` and navigated to `/company/new`, where the existing-company guard redirected back to `/` without ever saving the password. Organic new-user flow (navigate to `/company/new`) unchanged.

---

## 2026-04-28 | `aad8e6c` — Fix magic link: actually send email + BE rate limit + FE cooldown 20 min

- `backend/app/api/auth.py` — `POST /auth/magic-link` was calling `generate_link` but discarding the result and never sending any email; now extracts `action_link` and calls `send_magic_link_email` (same pattern as invite flow); added server-side in-memory rate limit (20 min / email); TODO comment to move to DB table for multi-worker safety
- `frontend/src/pages/LoginPage.tsx` — `MAGIC_LINK_COOLDOWN_MS` changed from 60 min → 20 min to match BE

---

## 2026-04-27 | `afb0385` — Fix repeated password modal + add FRONTEND_URL to CI/CD

- `frontend/src/pages/NewCompanyPage.tsx` — `supabase.auth.updateUser` now includes `data: { password_set: true }` so Auth.tsx short-circuits the AMR check on any subsequent SIGNED_IN events
- `frontend/src/pages/InvitePage.tsx` — same fix in `handleAccept`
- Root cause: `supabase.auth.updateUser({ password })` fires a new SIGNED_IN event; the refreshed JWT still has `amr = "otp"` and `user_metadata.password_set` was never written client-side, causing the modal to reappear every time the user returned
- `.github/workflows/deploy.yml` — `FRONTEND_URL=https://ownflow.21century.tech` added to the `.env.prod` printf block
- `docker-compose.prod.yml` — `FRONTEND_URL` env var wired through to backend container
- `backend/.env.example` — `FRONTEND_URL` and `CORS_ORIGINS` production values documented

---

## 2026-04-27 | `13cded7` — Fix logout on company creation: set password client-side via supabase.auth.updateUser

- `frontend/src/pages/NewCompanyPage.tsx` — password is now set via `supabase.auth.updateUser({ password })` before `POST /companies`; only `full_name` goes to the backend; removed `refreshSession()` call (no longer needed)
- `frontend/src/pages/InvitePage.tsx` — same fix in `handleAccept`; password set client-side before `POST /teams/accept-invites`
- Root cause: `supabase.auth.admin.update_user_by_id` revokes all tokens including the refresh token, making `refreshSession()` fail and triggering `SIGNED_OUT`; `supabase.auth.updateUser` keeps the session alive

---

## 2026-04-27 | `324a02b` — Fix 401 after onboarding: refresh session after password change

- `frontend/src/pages/NewCompanyPage.tsx` — after `POST /companies` succeeds with a password, `supabase.auth.refreshSession()` is awaited before navigating; `onAuthStateChange` in authStore picks up the new JWT so dashboard requests don't 401
- `frontend/src/pages/InvitePage.tsx` — same fix in `handleAccept`; converted to `async/await` for clarity
- Root cause: Supabase invalidates the current JWT when a user's password is changed via the admin API; the old token was still in the Zustand store, causing every subsequent authenticated request to fail with 401

---

## 2026-04-27 | `eec23a8` — Validate name ≥4 chars and password ≥8 chars on profile setup (FE + BE)

- `frontend/src/components/CompleteProfileModal.tsx` — `nameValid` threshold raised from `> 0` to `>= 4`; inline red hint "Name must be at least 4 characters" appears while typing (mirrors existing password-mismatch hint)
- `frontend/src/pages/InvitePage.tsx` — same name validation change in the inline profile step; removed stale duplicate `interface PendingInvite` at bottom of file
- `backend/app/api/companies.py` — returns `400 "Full name must be at least 4 characters"` / `"Password must be at least 8 characters"` before any DB writes if either field is provided but too short
- `backend/app/api/teams.py` — same early validation in `_do_accept_invites` before profile update and invite acceptance
- Validation — `make check-backend` (18 tests) and `make check-frontend` both passed

---

## 2026-04-27 | `75ab5b8` — Invite confirmation page: show accept/decline card before joining team

- `frontend/src/pages/InvitePage.tsx` — rewritten: fetches pending invite details from `GET /teams/pending-invite`, shows a card with team name / role / inviter; Accept → calls accept-invites then goes to `/` (CompleteProfileModal handles name+password); Decline → signs out, goes to `/login`; handles no-pending-invite gracefully
- `backend/app/api/teams.py` — new `GET /teams/pending-invite?email=...` endpoint returning first pending invite with resolved team name and role label; positioned before `/{team_id}` to avoid route conflict
- `backend/tests/test_invite_flow.py` — tests 16 & 17: `pending-invite` returns correct details / returns `null` when no invite
- Validation — `make check-backend` (17 tests) and `make check-frontend` both passed

---

## 2026-04-27 | `19e7b68` — Fix user_signups upsert: add on_conflict='user_id' so status updates correctly

- `backend/app/api/teams.py` — added `on_conflict="user_id"` to both `user_signups` upsert calls (invite creation → `'invited'`, accept-invites → `'team_join'`); without it PostgREST tried to insert a new row, hit the UNIQUE constraint, and the `except: pass` silently left status stuck at `'invited'`
- `backend/app/api/companies.py` — same fix for the `'company_created'` upsert after company creation
- Validation — `make check-backend` (13 tests) and `make check-frontend` both passed

---

## 2026-04-27 | `c49db2f` — Refactor invite flow: dedicated /invite page, clean URLs, simplified Auth

- `frontend/src/pages/InvitePage.tsx` (new) — dedicated landing page for `/invite`; waits for Zustand session, calls `POST /teams/accept-invites`, then navigates to `/`; uses `useRef` to prevent double execution
- `frontend/src/App.tsx` — `/invite` route now renders `InvitePage` instead of `LoginPage`
- `frontend/src/components/Auth.tsx` — removed `acceptInvitesIfNeeded` entirely; `resolveLinkType` now checks `window.location.pathname === '/invite'` instead of `?invite_org` query param
- `backend/app/api/teams.py` — all `redirect_to` values changed from `/invite?invite_org=…&link_type=join_company` to plain `/invite`
- `docs/auth-flow.md` — fully rewritten with all 8 flows, JWT AMR claim explanation, `user_signups` funnel table, key files and email templates tables; old stale sections removed
- Validation — `make check-backend` (13 tests) and `make check-frontend` both passed

---

## 2026-04-27 | `b687042` — Fix Supabase lock contention in axios interceptor

- `frontend/src/lib/api.ts` — replaced `async` interceptor that called `supabase.auth.getSession()` with a synchronous read from `useAuthStore.getState().session`; eliminates the `Lock "lock:sb-…-auth-token" was released because another request stole it` error that fired when multiple parallel API calls (e.g. on AppLayout mount) all raced for the same storage lock simultaneously
- Validation — `make check-backend` and `make check-frontend` both passed

---

## 2026-04-27 | `d8a76e9` — Add user_signups table, signup funnel tracking, and clean DB bootstrap script

- `supabase/database_full.sql` — fully rewritten as a clean idempotent bootstrap script; single file to run on a fresh Supabase project; replaces the entire migrations chain
- `supabase/migrations/` — deleted all migration files; `database_full.sql` is now the sole schema reference
- `user_signups` table (new) — tracks how each user entered the product: `origin` (`organic` / `team_invite`), `signup_status` (`invited` / `company_created` / `team_join`), `completed_at` (set when onboarding completes), plus `invited_by_email`, `team_id`
- `backend/app/api/auth.py` — `POST /auth/signup` inserts `origin='organic'`; new `GET /auth/my-origin` endpoint returns the user's origin so the frontend can decide whether to show company-setup
- `backend/app/api/companies.py` — `POST /companies` upserts `signup_status='company_created'` + `completed_at` when a company is created
- `backend/app/api/teams.py` — invite endpoint sets `signup_status='invited'` for existing users; `_do_accept_invites` upserts `signup_status='team_join'` + `completed_at` when a team invite is accepted
- `frontend/src/components/CompleteProfileModal.tsx` — after profile completion calls `GET /auth/my-origin`; navigates to `/company/new` for `organic` users, skips redirect for `team_invite` users; URL-based `linkType` kept as fallback
- Validation — `make check-backend` (13 tests) and `make check-frontend` both passed

---

## 2026-04-27 | `0ec081a` — Fix frontend warnings and refresh FastAPI stack

- `backend/app/config.py` — migrated settings configuration to Pydantic v2 `model_config` to remove the class-based config deprecation warning
- `backend/requirements.txt` — upgraded `fastapi` from `0.115.0` to `0.136.1` and `python-multipart` from `0.0.26` to `0.0.27`, removing the multipart deprecation warning at the dependency level
- `frontend/src/hooks/useRealtimeProject.ts` — removed the stale project closure in realtime subscriptions and fixed the React Hooks exhaustive-deps warning
- `frontend/src/pages/DashboardPage.tsx` — added the missing `setProjects` dependency to the project sync effect
- `frontend/vite.config.ts` — added manual vendor chunk splitting so the production build no longer warns about oversized chunks
- Validation — `make check-backend` and `make check-frontend` both passed with no remaining warnings

## 2026-04-27 | `3c8caf8` — Rebuild README and move frontend Docker build to Node 24

- `README.md` — recreated as a concise, current project document (snapshot, capabilities, architecture, DB setup options, local run, quality checks, and summarized recent changes from DEVLOG)
- `frontend/Dockerfile` — build image upgraded from `node:20-alpine` to `node:24-alpine`
- README prerequisites updated to `Node.js 20+ (Node.js 24 recommended)`
- Validation — `make check-backend` and `make check-frontend` passed

---

## 2026-04-27 | `c269a98` — Dependency upgrades: python-dotenv and pytest

- `backend/requirements.txt` — bumped `python-dotenv` from `1.0.1` to `1.2.2`
- `backend/requirements-dev.txt` — bumped `pytest` from `8.3.5` to `9.0.3`
- Validation — `make check-backend` and `make check-frontend` both passed after the version upgrades

---

## 2026-04-27 | `5327b92` — Add standalone full database bootstrap SQL script

- `supabase/database_full.sql` (NEW) — single combined SQL script that drops all existing tables and recreates the full current schema without relying on migrations
- Includes all latest schema updates in one file: `projects.sprint_days`, `projects.roadmap`, `actors.role`, `tasks.task_details`, `tasks.is_ready`, and `task_interactions`
- Includes indexes, realtime publication setup, RLS enables, and service-role policies so a fresh Supabase project can be bootstrapped from one script

---

## 2026-04-27 | `0e423d4` — Fix invite onboarding for cross-host login links

- `frontend/src/components/Auth.tsx` — invite acceptance now runs on both `getSession` and `SIGNED_IN`, even without `invite_org` in URL; still uses `invite_org` filter when present
- `frontend/src/components/Auth.tsx` — added robust `resolveLinkType` helper that infers `join_company` from `invite_org` when `link_type` is absent
- `frontend/src/store/authStore.ts` — `signOut` now clears `linkType`, `needsPassword`, and `needsName` to prevent stale flow state
- Outcome — invited users logging in from a different host/domain no longer fall into `/company/new` because pending invites are accepted immediately after auth

---

## 2026-04-27 | `7d18746` — Fix my_role in team response; schema migrations; CORS for local dev

- `backend/app/api/teams.py` — `get_team` now resolves `my_role` from the already-fetched members list and includes it in the response; uses `Depends(current_user_id)` so no extra DB round-trip
- `supabase/migrations/007_projects_sprint_days_roadmap.sql` — expanded to cover all missing columns: `projects.sprint_days`, `projects.roadmap`, `actors.role`, `tasks.task_details`, `tasks.is_ready`, and the new `task_interactions` table with RLS
- `supabase/migrations/001_schema.sql` — canonical schema updated to match: added `sprint_days`/`roadmap` to `projects`, `role` to `actors`, `task_details`/`is_ready` to `tasks`, `task_interactions` table
- `docs/database.md` — created full database reference doc covering all 16 tables, columns, FKs, indexes, and migration files
- `backend/app/api/actors.py` — added `role` to `update_actor` allowed_fields so actor role is patchable
- `backend/app/config.py` — `cors_origins_list` now always includes `localhost:5173–5180` so Vite's fallback ports (e.g. 5174) work locally without any `.env` changes

---

## 2026-04-26 | `4a82527` — Security: verify caller identity via JWT; add role-based permissions for invite/delete team

- `backend/app/auth_deps.py` (NEW) — `current_user_id` FastAPI dependency: verifies Supabase JWT via `auth.get_user(token)` and returns the authenticated user's UUID; no client-supplied identity trusted
- `backend/app/api/teams.py` — `delete_team` now uses `Depends(current_user_id)` instead of `?requester_id=` query param; only owners may delete a team (403 otherwise); only owners/admins may send invites
- `backend/app/api/auth.py` — `delete_account` uses `Depends(current_user_id)`; removed `DeleteAccountBody` model
- `frontend/src/lib/api.ts` — axios request interceptor attaches `Authorization: Bearer <supabase_jwt>` to every outbound request
- `frontend/src/pages/OrgSettingsPage.tsx` — `deleteTeam` no longer sends `?requester_id=`; invite/delete sections gated by `canInvite` / `canDelete` role checks
- `frontend/src/pages/ProfilePage.tsx` — `deleteAccount` call no longer sends user_id param
- `backend/tests/test_invite_flow.py` — tests 12 & 13 updated to override `current_user_id` dependency via `app.dependency_overrides` instead of query param; all 13 tests pass

---

## 2026-04-26 | `1384389` — Fix 500 on accept-invites; guard company/new redirect on join flow

- `frontend/src/components/Auth.tsx` — `accept-invites` is now only called when the URL contains `?invite_org=...`; regular sign-ins never touch the endpoint
- `backend/app/api/teams.py` — wrapped `accept_pending_invites` in try/except so any unexpected error logs and returns `{"accepted": 0}` instead of 500
- `frontend/src/components/AppLayout.tsx` — skip `/company/new` redirect when `linkType === 'join_company'` (user is mid-invite-acceptance, company membership is being created)

---

## 2026-04-26 | `6a336e0` — Never show name-only modal

- `frontend/src/components/Auth.tsx` — removed all standalone `setNeedsName` calls; name is now only collected together with the password modal for brand-new invited users (no password set). Existing users without a name can update it via the Profile page.

---

## 2026-04-26 | `e250c72` — Profile page, delete account, revoke invite, fix invite modal

- `backend/app/api/teams.py` — `DELETE /teams/{team_id}/invites/{invite_id}` sets invite status to `revoked`
- `backend/app/api/auth.py` — `DELETE /auth/account?user_id=...` removes user from `team_members`/`company_members` and deletes auth account; blocked with 403 if user is company owner
- `frontend/src/pages/ProfilePage.tsx` — new page: edit display name, change password, delete account (delete blocked with explanation if company owner)
- `frontend/src/pages/OrgSettingsPage.tsx` — `revokeInvite` mutation; trash icon on each pending invite row
- `frontend/src/App.tsx` — `/profile` route added
- `frontend/src/components/AppLayout.tsx` — user name in header is now a clickable link to `/profile` with `UserCircle` icon
- `frontend/src/components/Auth.tsx` — on invite landing pages (`invite_org` or `link_type` in URL), skip early `setNeedsName` in `getSession` handler; let `SIGNED_IN` set both `needsName` + `needsPassword` together so only one combined modal appears

---

## 2026-04-26 | `ab90989` — Frontend rename Organization→Team; fix team auto-select & password re-prompt

- `frontend/src/types.ts` — `Organization` → `Team`, `OrgMember` → `TeamMember`, `OrgPendingInvite` → `TeamPendingInvite`
- `frontend/src/store/teamStore.ts` — new store replacing `orgStore.ts`; `useTeamStore`, `teams`/`activeTeam`/`setTeams`/`setActiveTeam`/`updateTeamModel`
- `frontend/src/store/orgStore.ts` — deleted
- All pages/components updated: `AppLayout`, `DashboardPage`, `NewProjectPage`, `NewOrgPage`, `NewCompanyPage`, `OrgSettingsPage`
- Route `:orgId` → `:teamId` in `App.tsx` and `OrgSettingsPage`
- UI copy: "No organization selected" → "No team selected", "Create organization" → "Create team"
- `NewCompanyPage` — seeds React Query company cache after creation so `AppLayout` sees it immediately (fixes missing team selection)
- `AppLayout` — explicitly calls `setActiveTeam(teamsData[0])` when `activeTeam` is null after data loads
- `CompleteProfileModal` — stamps `password_set: true` in user metadata after setting password
- `Auth.tsx` — skips `has-password` API call if `user_metadata.password_set` is already true (fixes password modal on every refresh)

---

## 2026-04-26 | `67ac7d9` — UUID role FK, schema migration cleanup, org→team rename complete

- `supabase/migrations/001_schema.sql` — single source-of-truth schema; adds `DROP TABLE IF EXISTS … CASCADE` for all tables (including old `organizations`/`org_members`); realtime publication additions wrapped in idempotent `DO $$ … EXCEPTION WHEN duplicate_object` blocks
- `roles` table — UUID PK lookup with fixed seeds: `…0001`=owner, `…0002`=admin, `…0003`=member
- `team_members`, `team_invites`, `company_members`, `project_members` — `role` column is now `uuid references roles(id)` instead of inline text
- `backend/app/api/teams.py`, `companies.py` — added `ROLE_IDS`/`ROLE_NAMES` maps; all DB inserts/upserts write UUID role values; API responses still return readable text names
- `backend/app/api/projects.py`, `models.py` — `org_id` → `team_id` throughout
- `frontend/src` — `org_id` → `team_id` in `NewProjectPage`, `DashboardPage`, `Auth.tsx`, `types.ts`
- `backend/tests/test_invite_flow.py` — 2 new tests verifying UUID roles are stored (`test_create_team_inserts_owner_role_as_uuid`, `test_invite_stores_role_as_uuid`); 9 tests total passing
- Deleted old migration files (`002`–`006`, backend `003`–`004`) and `orgs.py`

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

## 2026-04-26 — link_type routing for OTP links (c69b5ab)

- All OTP/magic-link redirect URLs now carry `?link_type=` so the frontend knows what to do after sign-in
- `create_company` — signup confirmation + `POST /auth/create-company-invite` → after profile modal navigates to `/company/new`
- `join_company` — org invite links (both Postmark + Supabase fallback paths in `orgs.py`)
- `set_password` — "Use magic link" button on login page (wrong password flow)
- `authStore`: added `LinkType` type + `linkType` state + `setLinkType` action
- `Auth.tsx`: reads `link_type` from URL on `SIGNED_IN` and stores it
- `CompleteProfileModal`: navigates to `/company/new` after submit when `linkType === 'create_company'`
- `AppLayout`: skips `/company/new` redirect while `needsPassword || needsName` modal is open
- Backend: new `POST /auth/create-company-invite` endpoint for inviting users to start their own company
- Fix: `has-password` API check now prevents false-positive password modal for regular signup confirmations

## 2026-04-26 — supabase upgrade + lint fix (0d21adc)

- Upgraded `supabase` from 2.7.4 → 2.29.0 — eliminates `gotrue` deprecation warning (package now uses `supabase_auth` internally)
- Removed unused `action_link` variable in `send_magic_link` endpoint (ruff lint error 841)

## 2026-04-26 — lint + CI fixes (7d963d8)

- Fix ruff F841: removed unused `link_resp` variable in `send_magic_link` endpoint (`auth.py`)
- Fix CI: bumped pydantic 2.9.2 → 2.13.3 to satisfy `realtime==2.29.0` constraint (requires `pydantic>=2.11.7`)
- Memory: commit discipline recorded — never auto-commit; always run checks first, only commit on "tested"

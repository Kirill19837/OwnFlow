# Authentication & Onboarding Flows

OwnFlow uses Supabase Auth for identity, but routes all email delivery through **Postmark** for reliability and branding. The frontend talks to both the FastAPI backend (for custom flows) and Supabase directly (for session management).

---

## Overview of entry paths

| Path | How user arrived | `user_signups.origin` | Onboarding outcome |
|---|---|---|---|
| Self-signup | Filled the sign-up form | `organic` | Must create a company after confirming email |
| Team invite (new user) | Clicked invite email | `team_invite` | Lands on `/invite` → accept invite → dashboard |
| Team invite (existing user) | Clicked "added to team" email | `team_invite` | Lands on `/invite` → accept invite → dashboard |

---

## 1. Self-signup (organic)

```
Sign-up form (/login)
  → POST /auth/signup  (backend, not Supabase directly)
  → Supabase generates "signup" confirmation link
  → Postmark sends branded confirmation email
  → user_signups row inserted: origin='organic'
  → user clicks email link → redirected to /
  → SIGNED_IN fires in Auth.tsx
  → JWT AMR = "otp" → needsPassword=true, needsName=true (if name missing)
  → CompleteProfileModal shown (name + password)
  → on submit: POST /auth/my-origin → origin='organic' → navigate /company/new
  → user creates company → POST /companies
    → user_signups updated: signup_status='company_created', completed_at=now
  → AppLayout auto-creates first team → dashboard
```

**Backend endpoint:** `POST /auth/signup`  
**Body:** `{ email, name? }`  
**Response:** `{ status: "confirmation_sent", email }`

---

## 2. Sign-in (password)

```
Sign-in form (/login)
  → supabase.auth.signInWithPassword() (direct)
  → SIGNED_IN fires in Auth.tsx
  → JWT AMR = "password" → no modals
  → redirect to /  (AppLayout loads company + teams)
```

---

## 3. Sign-in (magic link — fallback for forgotten password)

Shown automatically when the user enters a wrong password on the sign-in form.

```
Wrong password → "Send magic link" link appears
  → POST /auth/magic-link  (backend)
  → Supabase generates magiclink → Postmark sends email
  → rate-limited: once per hour per email (localStorage)
  → user clicks link → redirected to /
  → SIGNED_IN fires in Auth.tsx
  → JWT AMR = "otp" + no existing password → needsPassword=true
  → CompleteProfileModal shown (password only)
  → on submit: supabase.auth.updateUser({ password, password_set: true })
  → no redirect (user already has company)
```

**Backend endpoint:** `POST /auth/magic-link`  
**Body:** `{ email }`  
**Response:** `{ status: "sent", email }` (always succeeds — no user enumeration)

---

## 4. Team invite — new user

```
Admin sends invite from Team Settings
  → POST /teams/{team_id}/invites
  → team_invites row created: status='pending'
  → Supabase admin.generate_link(type="invite", redirect_to="/invite")
  → Postmark sends branded invite email
  → user clicks email link → browser opens /invite (Supabase token in URL hash)
  → Supabase processes token → SIGNED_IN fires in Auth.tsx
  → linkType='join_company' → CompleteProfileModal suppressed in AppLayout
  → JWT AMR = "otp" + no password → needsPassword=true + needsName=true
  → InvitePage shows built-in "profile" step (name + password form)
  → user fills form → clicks Continue
    → supabase.auth.updateUser({ password, data: { password_set: true, full_name } })
    → needsPassword=false, needsName=false (saved to Supabase — survives tab close)
  → InvitePage advances to invite-card step
  → user clicks Accept → POST /teams/accept-invites { user_id, email }
    → team_invites row updated: status='accepted'
    → team_members + company_members rows created
    → user_signups upserted: origin='team_invite', signup_status='team_join', completed_at=now
  → navigate / (dashboard)
```

**Idempotency:** if the user closes the tab after Continue but before Accept, on return
`needsPassword` is already `false` (metadata committed), so the profile step is skipped
and they land directly on the invite card.

---

## 5. Team invite — existing user

```
Admin sends invite for an email that already has an account
  → generate_link(type="invite") fails ("already registered")
  → Postmark sends "added to team" notification email with /invite link
  → user_signups upserted: signup_status='invited'
  → user clicks email link → browser opens /invite
  → user is already signed in (Supabase restores session from localStorage)
  → getSession() fires in Auth.tsx (SIGNED_IN does NOT fire — no new sign-in)
  → session restored → InvitePage renders
  → POST /teams/accept-invites (no pending invite filter)
    → team_invites row updated: status='accepted'
    → user_signups updated: signup_status='team_join', completed_at=now
  → navigate / (dashboard)
```

---

## 6. InvitePage (`/invite`)

Central landing point for all invite links. Owns the full profile-collection step for new users so that profile data is saved to Supabase before the invite is accepted.

```
/invite
  ├─ loading  — session not yet available
  │    shows spinner; waits for Auth.tsx to restore or establish session
  │
  ├─ profile  — shown when needsPassword || needsName
  │    built-in form (name, password, confirm)
  │    Continue click:
  │      supabase.auth.updateUser({ password?, data: { password_set: true, full_name? } })
  │      needsPassword=false, needsName=false
  │      → advance to invite-card
  │
  ├─ invite-card  — shows team name, role, invited-by; Accept / Decline buttons
  │    Accept:
  │      POST /teams/accept-invites { user_id, email }
  │      → navigate('/', { replace: true })
  │    Decline:
  │      POST /teams/invites/{id}/decline
  │      → supabase.auth.signOut() → navigate('/login')
  │
  └─ no-invite fallback  — invite already used or link expired
       shows message + "Go to dashboard" button
```

**`CompleteProfileModal` is suppressed on `/invite`** — `AppLayout` gates it with
`linkType !== 'join_company'`, so the modal never appears over the invite page.

If there are no pending invites, `accept-invites` returns `{ accepted: 0 }` — the user is silently redirected to the dashboard.

---

## 7. Profile completion modal (`CompleteProfileModal`)

Shown inside `AppLayout` when `needsPassword || needsName` is true **and** `linkType !== 'join_company'`.
Non-dismissable overlay — user cannot access the app until the form is submitted.

| Condition | Fields shown |
|---|---|
| `needsName` + `needsPassword` | Full name + Password + Confirm password |
| `needsPassword` only | Password + Confirm password |

Behavior on submit depends on `linkType`:

### `linkType === 'set_password'` (magic-link user, already has a company)

```
supabase.auth.updateUser({ password?, data: { password_set: true, full_name? } })
  → setNeedsPassword(false), setNeedsName(false)
  → modal unmounts — user stays on current page (dashboard)
```

No navigation — the user already has a company and is on the dashboard.

### `linkType === null` or `'create_company'` (organic new user)

```
stores { name, password } to pendingProfile (Zustand)
  → navigate('/company/new')
  → NewCompanyPage picks up pendingProfile:
      supabase.auth.updateUser({ password, data: { password_set: true } })
      POST /companies { name, phone, model, full_name }
      → company + first team created
      → navigate / (dashboard)
```

Password is intentionally held in memory (not saved) until the company form is submitted,
so a single `POST /companies` atomically completes the entire onboarding.

---

## 8. Company setup (`/company/new`)

Only shown to organic users after profile completion.

```
/company/new
  ├─ guard: GET /companies/my → if company already exists → navigate / (prevents re-entry)
  └─ user fills name, phone, AI model → POST /companies
       → company row + first team auto-created
       → user_signups: signup_status='company_created', completed_at=now
       → navigate / (AppLayout loads new team → dashboard)
```

---

## Password detection (JWT AMR claims)

After every `SIGNED_IN` event, `Auth.tsx` base64-decodes the JWT access token and reads the `amr` (Authentication Methods References) array:

```ts
const payload = JSON.parse(atob(token.split('.')[1]))
const amr: Array<{ method: string }> = payload.amr ?? []
const isOtp = amr.some((a) => a.method === 'otp')
```

| `amr` method | Meaning | Modal shown |
|---|---|---|
| `password` | Signed in with password | None |
| `otp` | Magic link or invite link | Password modal (+ name if missing) |

Before showing the modal, the backend is queried to confirm the user genuinely has no password (`GET /auth/has-password`) — this prevents false-positives for users who confirmed via email but already set a password.

---

## `user_signups` funnel tracking

Every user has exactly one row in `user_signups` that records their entry path and onboarding progress.

| `origin` | `signup_status` | Meaning |
|---|---|---|
| `organic` | `null` | Signed up, not yet confirmed or completed |
| `organic` | `company_created` | Created their company — onboarding complete |
| `team_invite` | `invited` | Invite sent (existing user), not yet accepted |
| `team_invite` | `team_join` | Accepted invite — onboarding complete |

`completed_at` is set when `signup_status` becomes `company_created` or `team_join`.

---

## Key files

| File | Purpose |
|---|---|
| `frontend/src/components/Auth.tsx` | Session restore, AMR OTP detection, linkType resolution |
| `frontend/src/pages/InvitePage.tsx` | Invite landing page — accepts invites, redirects to dashboard |
| `frontend/src/pages/LoginPage.tsx` | Sign-in / sign-up form, magic link fallback |
| `frontend/src/pages/NewCompanyPage.tsx` | Company creation — organic users only |
| `frontend/src/components/CompleteProfileModal.tsx` | Combined name + password prompt |
| `frontend/src/store/authStore.ts` | Session, `needsPassword`, `needsName`, `linkType` flags |
| `frontend/src/lib/api.ts` | Axios instance — reads token from Zustand store (no lock contention) |
| `backend/app/api/auth.py` | `POST /signup`, `POST /magic-link`, `GET /has-password`, `GET /my-origin` |
| `backend/app/api/teams.py` | `POST /{id}/invites`, `POST /accept-invites` |
| `backend/app/api/companies.py` | `POST /companies` — records `company_created` status |
| `backend/app/email.py` | Postmark email templates |

---

## Email templates (Postmark)

All emails use a dark-theme branded template matching the app UI.

| Template function | Trigger | Subject |
|---|---|---|
| `send_signup_confirmation_email` | New self-signup | "Confirm your OwnFlow account" |
| `send_invite_email` | New user invited to team | "You've been invited to join {team}" |
| `send_added_to_org_email` | Existing user invited to team | "You've been added to {team}" |
| `send_magic_link_email` | Magic link / password reset request | "Your OwnFlow sign-in link" |

2. `authStore.signUp()` calls `POST /auth/signup` on the FastAPI backend (not Supabase directly).
3. Backend calls `supabase.auth.admin.generate_link(type="signup")` to create a confirmation token, then writes `full_name` to `user_metadata` via `admin.update_user_by_id`.
4. Backend sends a branded dark-theme confirmation email via **Postmark** (`send_signup_confirmation_email`).
5. Frontend shows "Check your email" screen — user must click the link before they can sign in.
6. After clicking the confirmation link, the user is redirected to `/` and can sign in normally.

**Endpoint:** `POST /auth/signup`  
**Body:** `{ email, password, name? }`  
**Response:** `{ status: "confirmation_sent", email }`

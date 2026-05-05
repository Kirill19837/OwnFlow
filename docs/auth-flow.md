# Authentication & Onboarding Flows

OwnFlow uses Supabase Auth for identity, but routes all email delivery through **Postmark** for reliability and branding. The frontend talks to both the FastAPI backend (for custom flows) and Supabase directly (for session management).

> **[Project presentation](https://kirill19837.github.io/OwnFlow/)**

---

## Overview of entry paths

| Path | How user arrived | `user_signups.origin` | Onboarding outcome |
|---|---|---|---|
| Self-signup | Filled the sign-up form | `organic` | Must create a company after confirming email |
| Team invite (new user) | Clicked invite email | `team_invite` | Lands on `/invite` → accept → dashboard |
| Team invite (existing user) | Clicked "added to team" email | `team_invite` | Lands on `/invite` → accept → dashboard |

---

## 1. Self-signup (organic)

```
Sign-up form (/login)
  → POST /auth/signup  (backend)
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
  → supabase.auth.signInWithPassword() (direct to Supabase)
  → SIGNED_IN fires in Auth.tsx
  → JWT AMR = "password" → no modals
  → redirect to /  (AppLayout loads company + teams)
```

---

## 3. Sign-in (magic link — fallback for forgotten password)

Shown automatically when the user enters a wrong password.

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
    → needsPassword=false, needsName=false (committed to Supabase — survives tab close)
  → InvitePage advances to invite-card step
  → user clicks Accept → POST /teams/accept-invites { user_id, email }
    → team_invites row updated: status='accepted'
    → team_members + company_members rows created
    → user_signups upserted: origin='team_invite', signup_status='team_join', completed_at=now
  → setNeedsSkills(true)
  → navigate / (dashboard)
  → SelectSkillsModal shown on dashboard
```

**Idempotency:** if the user closes the tab after Continue but before Accept, on return `needsPassword` is already `false` (committed to metadata), so the profile step is skipped and they land directly on the invite card.

---

## 5. Team invite — existing user

```
Admin sends invite for an email that already has an account
  → generate_link(type="invite") fails ("already registered")
  → Postmark sends "added to team" notification email with /invite link
  → user_signups upserted: signup_status='invited'
  → user clicks email link → browser opens /invite
  → user is already signed in (Supabase restores session from localStorage)
  → getSession() fires in Auth.tsx (SIGNED_IN does NOT fire)
  → session restored → InvitePage renders
  → POST /teams/accept-invites (no pending invite filter)
    → team_invites row updated: status='accepted'
    → user_signups updated: signup_status='team_join', completed_at=now
  → navigate / (dashboard)
```

---

## 6. InvitePage (`/invite`)

Central landing point for all invite links. Owns the profile-collection step for new users so profile data is committed to Supabase before the invite is accepted.

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

**`CompleteProfileModal` is suppressed on `/invite`** — `AppLayout` gates it with `linkType !== 'join_company'`, so it never appears over the invite page.

If there are no pending invites, `accept-invites` returns `{ accepted: 0 }` and the user is silently redirected to the dashboard.

---

## 7. Profile completion modal (`CompleteProfileModal`)

Shown inside `AppLayout` when `needsPassword || needsName` is true **and** `linkType !== 'join_company'`. Non-dismissable — user cannot access the app until submitted.

| Condition | Fields shown |
|---|---|
| `needsName` + `needsPassword` | Full name + Password + Confirm password |
| `needsPassword` only | Password + Confirm password |

Behaviour on submit depends on `linkType`:

### `linkType === 'set_password'` (magic-link user, already has a company)

```
supabase.auth.updateUser({ password?, data: { password_set: true, full_name? } })
  → setNeedsPassword(false), setNeedsName(false)
  → modal unmounts — user stays on dashboard
```

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

Password is held in memory until the company form is submitted, so a single `POST /companies` atomically completes the entire onboarding.

---

## 8. Skills selection (`SelectSkillsModal`)

Shown on the dashboard after a team invite is accepted (`needsSkills = true`). Users select their skills from the seeded `skills` catalogue. On confirm, `POST /skills/me` saves the selections to `user_skills`.

The modal is optional — users can dismiss it and update skills later from their profile.

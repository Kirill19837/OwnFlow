# Authentication Flow

OwnFlow uses Supabase Auth for identity, but routes all email delivery through **Postmark** for reliability and branding. The frontend talks to both the FastAPI backend (for custom flows) and Supabase directly (for session management).

---

## Sign-up

1. User fills in **Full name**, **Email**, and **Password** on the Sign up tab of `/login`.
2. `authStore.signUp()` calls `POST /auth/signup` on the FastAPI backend (not Supabase directly).
3. Backend calls `supabase.auth.admin.generate_link(type="signup")` to create a confirmation token, then writes `full_name` to `user_metadata` via `admin.update_user_by_id`.
4. Backend sends a branded dark-theme confirmation email via **Postmark** (`send_signup_confirmation_email`).
5. Frontend shows "Check your email" screen — user must click the link before they can sign in.
6. After clicking the confirmation link, the user is redirected to `/` and can sign in normally.

**Endpoint:** `POST /auth/signup`  
**Body:** `{ email, password, name? }`  
**Response:** `{ status: "confirmation_sent", email }`

---

## Sign-in (password)

1. User enters email + password on the Sign in tab of `/login`.
2. `authStore.signIn()` calls `supabase.auth.signInWithPassword()` directly.
3. On success, `onAuthStateChange` fires `SIGNED_IN` → session is stored in Zustand.
4. `Auth.tsx` checks JWT AMR claims (`amr[].method`). If all methods are `"password"`, no modals are shown.
5. User is redirected to `/` (or wherever React Router sends them).

---

## Sign-in (magic link)

Shown automatically when the user enters a wrong password on the sign-in form.

1. After a failed password attempt, "Trouble signing in? **Send magic link**" appears below the error.
2. Clicking it calls `POST /auth/magic-link` on the backend.
3. Backend calls `generate_link(type="magiclink")` and sends a branded email via Postmark.
4. Rate-limited to **once per hour per email** (tracked in `localStorage`).
5. User clicks the link → redirected to `/` → `SIGNED_IN` fires.
6. `Auth.tsx` reads JWT AMR claims: `method: "otp"` → sets `needsPassword = true`.
7. `CompleteProfileModal` appears to let the user set a permanent password (and name if missing).

**Endpoint:** `POST /auth/magic-link`  
**Body:** `{ email }`  
**Response:** `{ status: "sent", email }` (always succeeds — no user enumeration)

---

## Invite flow

1. Company admin invites a user by email from Team Settings.
2. Backend (`POST /orgs/{org_id}/invites`) always creates a **pending** `org_invites` row regardless of whether the email already exists in Supabase.
3. **New user** (never had an account): `generate_link(type="invite")` is called and a branded invite email is sent via Postmark. User clicks the link, `SIGNED_IN` fires, `accept_pending_invites` adds them to the team.
4. **Existing confirmed user**: `generate_link(type="invite")` fails with "already registered" → backend sends a login-notification email (`send_added_to_org_email`) with a link to sign in. On next sign-in, `accept_pending_invites` picks up the pending invite.

### After clicking an invite link (new user)

1. Redirected to `/?invite_org=<org_id>` (embedded in the magic link redirect URL).
2. `onAuthStateChange` fires `SIGNED_IN`.
3. `acceptInvitesIfNeeded` calls `POST /orgs/accept-invites` → user added to `org_members` and `company_members`.
4. JWT AMR `method: "otp"` → `needsPassword = true`, and if `full_name` is missing → `needsName = true`.
5. `CompleteProfileModal` appears with both name and password fields in a single form.

### Already logged-in user clicking an invite link

1. `getSession()` fires (not `SIGNED_IN`) → `Auth.tsx` reads `?invite_org` from URL and calls `acceptInvitesIfNeeded` during session restore.
2. `LoginPage` detects active session → redirects to `/` immediately.
3. `NewCompanyPage` is guarded — redirects to `/` if user already has a company.

---

## Profile completion modal (`CompleteProfileModal`)

Shown when either `needsPassword` or `needsName` is true (or both). Non-dismissable.

| Condition | Fields shown |
|---|---|
| `needsName` only | Full name |
| `needsPassword` only | Password + Confirm password |
| Both | Full name + Password + Confirm password |

On submit, calls `supabase.auth.updateUser({ password?, data: { full_name? } })` in a single request, then refreshes the session so the header displays the new name immediately.

---

## Password detection (AMR claims)

After every `SIGNED_IN` event, `Auth.tsx` base64-decodes the JWT access token payload and reads the `amr` (Authentication Methods References) array:

```ts
const payload = JSON.parse(atob(token.split('.')[1]))
const amr: Array<{ method: string }> = payload.amr ?? []
const isOtp = amr.some((a) => a.method === 'otp')
if (isOtp) setNeedsPassword(true)
```

- `method: "password"` → user signed in with a password → no modal
- `method: "otp"` → magic link or invite → show password prompt

This avoids a round-trip to check `encrypted_password` on the backend and never false-positives for users with passwords.

---

## Key files

| File | Purpose |
|---|---|
| `frontend/src/pages/LoginPage.tsx` | Sign-in / sign-up form, magic link fallback |
| `frontend/src/store/authStore.ts` | Session, `needsPassword`, `needsName` flags |
| `frontend/src/components/Auth.tsx` | `AuthProvider` (session restore, invite acceptance, AMR check) |
| `frontend/src/components/CompleteProfileModal.tsx` | Combined name + password prompt |
| `backend/app/api/auth.py` | `POST /auth/signup`, `POST /auth/magic-link`, `GET /auth/has-password` |
| `backend/app/email.py` | Postmark email templates (invite, signup confirmation, magic link, added-to-org) |
| `backend/app/api/orgs.py` | `POST /orgs/{id}/invites`, `POST /orgs/accept-invites` |

---

## Email templates (Postmark)

All emails use a dark-theme branded template matching the app UI.

| Template function | Trigger | Subject |
|---|---|---|
| `send_signup_confirmation_email` | New signup | "Confirm your OwnFlow account" |
| `send_invite_email` | New user invited | "You've been invited to join {team}" |
| `send_added_to_org_email` | Existing user invited | "You've been added to {team}" |
| `send_magic_link_email` | Magic link request | "Your OwnFlow sign-in link" |

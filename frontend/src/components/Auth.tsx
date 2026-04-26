import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'

export function AuthProvider() {
  const { setSession } = useAuthStore()
  const [ready, setReady] = useState(false)

  const acceptInvitesIfNeeded = async (
    session: { user?: { email?: string; id?: string } | null } | null,
    orgId?: string
  ) => {
    const email = session?.user?.email
    const userId = session?.user?.id
    if (!email || !userId) return
    try {
      await api.post('/teams/accept-invites', { user_id: userId, email, team_id: orgId })
    } catch {
      // Non-blocking: auth flow should continue even if invite sync fails.
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      // For already-logged-in users visiting /login?invite_org=xxx,
      // SIGNED_IN never fires — accept the invite here instead.
      if (data.session) {
        const params = new URLSearchParams(window.location.search)
        const inviteOrg = params.get('invite_org') ?? undefined
        const isInviteLanding = !!params.get('invite_org') || !!params.get('link_type')
        if (inviteOrg) {
          await acceptInvitesIfNeeded(data.session, inviteOrg)
        }
        // Check name on session restore (existing sessions).
        // Skip on invite landings — SIGNED_IN will handle name + password together
        // once the password check completes, so both fields appear in one modal.
        const name = data.session.user?.user_metadata?.full_name
        if (!isInviteLanding && (!name || !String(name).trim())) {
          useAuthStore.getState().setNeedsName(true)
        }
      }
      setSession(data.session)
      setReady(true)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      // Only accept invites on a real sign-in, not on every session restore/refresh.
      if (event === 'SIGNED_IN') {
        // Read invite_org and link_type from the URL (embedded in the magic link redirect).
        const params = new URLSearchParams(window.location.search)
        const inviteOrg = params.get('invite_org') ?? undefined
        const linkType = params.get('link_type') as 'create_company' | 'join_company' | 'set_password' | null
        if (linkType) useAuthStore.getState().setLinkType(linkType)
        await acceptInvitesIfNeeded(session, inviteOrg)

        // Decode JWT AMR to detect OTP sign-ins (magic link / invite / email confirm).
        // Email confirmation also comes in as method "otp", but the user already has a
        // password — so we verify against the backend before showing the password modal.
        try {
          const token = session?.access_token
          if (token) {
            const payload = JSON.parse(atob(token.split('.')[1]))
            const amr: Array<{ method: string }> = payload.amr ?? []
            const isOtp = amr.some((a) => a.method === 'otp')
            const alreadyMarked = session?.user?.user_metadata?.password_set === true
            if (isOtp && !alreadyMarked && session?.user?.id) {
              const { data } = await api.get<{ has_password: boolean }>(
                `/auth/has-password?user_id=${session.user.id}`
              )
              if (!data.has_password) {
                useAuthStore.getState().setNeedsPassword(true)
              }
            }
          }
        } catch {
          // Non-blocking
        }

        // Check if name is set
        const name = session?.user?.user_metadata?.full_name
        if (!name || !String(name).trim()) {
          useAuthStore.getState().setNeedsName(true)
        }
      }
      setSession(session)
    })
    return () => subscription.unsubscribe()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!ready) return null
  return <Outlet />
}

export function ProtectedRoute() {
  const { session, loading } = useAuthStore()
  if (loading) return null
  if (!session) return <Navigate to="/login" replace />
  return <Outlet />
}

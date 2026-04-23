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
      await api.post('/orgs/accept-invites', { user_id: userId, email, org_id: orgId })
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
        if (inviteOrg) {
          await acceptInvitesIfNeeded(data.session, inviteOrg)
        }
        // Check name on session restore (existing sessions)
        const name = data.session.user?.user_metadata?.full_name
        if (!name || !String(name).trim()) {
          useAuthStore.getState().setNeedsName(true)
        }
      }
      setSession(data.session)
      setReady(true)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      // Only accept invites on a real sign-in, not on every session restore/refresh.
      if (event === 'SIGNED_IN') {
        // Read invite_org from the URL (embedded in the magic link redirect).
        const params = new URLSearchParams(window.location.search)
        const inviteOrg = params.get('invite_org') ?? undefined
        await acceptInvitesIfNeeded(session, inviteOrg)

        // Check if the user has a password set — magic-link / invite users won't.
        // Ask them to create one immediately after sign-in.
        try {
          const { data } = await api.get<{ has_password: boolean }>('/auth/has-password', {
            params: { user_id: session?.user?.id },
          })
          if (data && !data.has_password) {
            useAuthStore.getState().setNeedsPassword(true)
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

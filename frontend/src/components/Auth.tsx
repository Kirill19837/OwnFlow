import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'

export function AuthProvider() {
  const { setSession } = useAuthStore()
  const [ready, setReady] = useState(false)

  const acceptInvitesIfNeeded = async (session: { user?: { email?: string; id?: string } | null } | null) => {
    const email = session?.user?.email
    const userId = session?.user?.id
    if (!email || !userId) return
    try {
      await api.post('/orgs/accept-invites', { user_id: userId, email })
    } catch {
      // Non-blocking: auth flow should continue even if invite sync fails.
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      // Only accept invites on a real sign-in, not on every session restore/refresh.
      if (event === 'SIGNED_IN') {
        await acceptInvitesIfNeeded(session)
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

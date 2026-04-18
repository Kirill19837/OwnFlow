import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../store/authStore'

export function AuthProvider() {
  const { setSession } = useAuthStore()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
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

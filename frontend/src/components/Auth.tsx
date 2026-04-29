import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'

export function AuthProvider() {
  const { setSession } = useAuthStore()
  const [ready, setReady] = useState(false)

  const resolveLinkType = (params: URLSearchParams): 'create_company' | 'join_company' | 'set_password' | null => {
    const raw = params.get('link_type') as 'create_company' | 'join_company' | 'set_password' | null
    if (raw) return raw
    // If the user is on /invite, they arrived via a team invite link.
    if (window.location.pathname === '/invite') return 'join_company'
    return null
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const params = new URLSearchParams(window.location.search)
      useAuthStore.getState().setLinkType(resolveLinkType(params))
      setSession(data.session)
      setReady(true)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN') {
        const params = new URLSearchParams(window.location.search)
        useAuthStore.getState().setLinkType(resolveLinkType(params))

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
                // Ask for name alongside password only when the user is brand-new
                const name = session?.user?.user_metadata?.full_name
                if (!name || !String(name).trim()) {
                  useAuthStore.getState().setNeedsName(true)
                }
              }
            }
          }
        } catch {
          // Non-blocking
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

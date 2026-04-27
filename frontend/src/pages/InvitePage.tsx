import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layers } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'

export default function InvitePage() {
  const { session } = useAuthStore()
  const navigate = useNavigate()
  const attempted = useRef(false)

  useEffect(() => {
    // Wait until we have a session (the Supabase magic-link token in the URL hash
    // is processed by the AuthProvider listener which then sets the session in the store).
    if (!session || attempted.current) return
    attempted.current = true

    // Accept any pending invites for this user — no team filter needed,
    // the backend picks up all pending invites for their email.
    api
      .post('/teams/accept-invites', {
        user_id: session.user.id,
        email: session.user.email,
      })
      .finally(() => {
        // Whether there were pending invites or not (already accepted / never invited),
        // always go to the dashboard. AppLayout will redirect further if needed.
        navigate('/', { replace: true })
      })
  }, [session, navigate])

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-5">
        <Layers size={36} className="text-purple-400 animate-pulse" />
        <p className="text-white font-semibold">Accepting your invite…</p>
        <p className="text-gray-500 text-sm">You'll be redirected in a moment.</p>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layers, Users, X, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'

interface PendingInvite {
  team_id: string
  team_name: string
  invited_by_email: string
  role: string
}

type Stage = 'waiting' | 'loaded' | 'accepting' | 'declining'

export default function InvitePage() {
  const { session } = useAuthStore()
  const navigate = useNavigate()
  const fetchedRef = useRef(false)

  const [stage, setStage] = useState<Stage>('waiting')
  const [invite, setInvite] = useState<PendingInvite | null>(null)

  // Once we have a session, fetch the pending invite details.
  useEffect(() => {
    if (!session || fetchedRef.current) return
    fetchedRef.current = true

    api
      .get<{ invite: PendingInvite | null }>('/teams/pending-invite', {
        params: { email: session.user.email },
      })
      .then((r) => setInvite(r.data.invite ?? null))
      .catch(() => setInvite(null))
      .finally(() => setStage('loaded'))
  }, [session])

  const handleAccept = () => {
    if (!session) return
    setStage('accepting')
    api
      .post('/teams/accept-invites', {
        user_id: session.user.id,
        email: session.user.email,
      })
      .finally(() => navigate('/', { replace: true }))
  }

  const handleDecline = async () => {
    setStage('declining')
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  // ── Waiting for Supabase to process the magic-link hash ──────────────────
  if (stage === 'waiting' || !session) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-5">
          <Layers size={36} className="text-purple-400 animate-pulse" />
          <p className="text-white font-semibold">Loading your invite…</p>
        </div>
      </div>
    )
  }

  // ── Accepting / declining in progress ────────────────────────────────────
  if (stage === 'accepting' || stage === 'declining') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-5">
          <Layers size={36} className="text-purple-400 animate-pulse" />
          <p className="text-white font-semibold">
            {stage === 'accepting' ? 'Joining the team…' : 'Signing you out…'}
          </p>
        </div>
      </div>
    )
  }

  // ── No pending invite found ───────────────────────────────────────────────
  if (!invite) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-xl p-6 shadow-2xl text-center">
          <Layers size={32} className="text-purple-400 mx-auto mb-4" />
          <h2 className="text-white font-semibold mb-2">No pending invite</h2>
          <p className="text-gray-400 text-sm mb-5">
            This invite may have already been accepted, or the link has expired.
          </p>
          <button
            onClick={() => navigate('/', { replace: true })}
            className="w-full bg-purple-600 hover:bg-purple-500 text-white font-medium py-2.5 rounded-lg transition-colors text-sm"
          >
            Go to dashboard
          </button>
        </div>
      </div>
    )
  }

  // ── Invite confirmation card ──────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg bg-purple-900/40 border border-purple-800/40 flex items-center justify-center shrink-0">
            <Users size={16} className="text-purple-400" />
          </div>
          <div>
            <h2 className="text-white font-semibold leading-tight">You've been invited</h2>
            <p className="text-gray-400 text-xs mt-0.5">Review before joining</p>
          </div>
        </div>

        <div className="bg-gray-800/60 rounded-lg px-4 py-3 mb-5 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Team</span>
            <span className="text-white font-medium">{invite.team_name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Role</span>
            <span className="text-white capitalize">{invite.role}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Invited by</span>
            <span className="text-white">{invite.invited_by_email}</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleDecline}
            className="flex-1 flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 font-medium py-2.5 rounded-lg transition-colors text-sm"
          >
            <X size={14} />
            Decline
          </button>
          <button
            onClick={handleAccept}
            className="flex-1 flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 text-white font-medium py-2.5 rounded-lg transition-colors text-sm"
          >
            <Check size={14} />
            Accept & join
          </button>
        </div>
      </div>
    </div>
  )
}

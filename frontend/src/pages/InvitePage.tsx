import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Layers, Users, X, Check, Lock, User } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'

interface PendingInvite {
  id: string
  team_id: string
  team_name: string
  invited_by_email: string
  role: string
}

const ROLE_NAMES: Record<string, string> = {
  '00000000-0000-0000-0000-000000000001': 'owner',
  '00000000-0000-0000-0000-000000000002': 'admin',
  '00000000-0000-0000-0000-000000000003': 'member',
}
const resolveRole = (r: string) => ROLE_NAMES[r] ?? r

type Step = 'loading' | 'invite-card' | 'profile' | 'accepting' | 'declining'

export default function InvitePage() {
  const { session, needsPassword, needsName, setNeedsPassword, setNeedsName, setNeedsSkills, setLinkType } = useAuthStore()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const teamIdParam = searchParams.get('team_id')
  // If team_id is in the URL the user is already logged in (came from notification bell)
  const isEstablishedUser = !needsPassword && !needsName
  const fetchedRef = useRef(false)

  const [step, setStep] = useState<Step>('loading')
  const [invite, setInvite] = useState<PendingInvite | null>(null)

  // Profile form state
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [profileError, setProfileError] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)

  const passwordsMatch = password === confirm
  const passwordValid = password.length >= 8 && passwordsMatch
  const nameValid = name.trim().length >= 4
  const profileValid = (!needsName || nameValid) && (!needsPassword || passwordValid)

  // Once session is ready, fetch pending invite details
  useEffect(() => {
    if (!session || fetchedRef.current) return
    fetchedRef.current = true

    const params: Record<string, string> = { email: session.user.email! }
    if (teamIdParam) params.team_id = teamIdParam

    api
      .get<{ invite: PendingInvite | null }>('/teams/pending-invite', { params })
      .then((r) => setInvite(r.data.invite ?? null))
      .catch(() => setInvite(null))
      .finally(() => setStep('invite-card'))
  }, [session])

  const handleAccept = () => {
    if (!session || !invite) return
    // If the user needs to set a name or password, collect that first.
    // The profile step will call accept-invites once credentials are saved.
    if (needsPassword || needsName) {
      setStep('profile')
    } else {
      doAccept()
    }
  }

  const doAccept = async () => {
    if (!session || !invite) return
    setStep('accepting')
    setLinkType(null)
    try {
      await api.post('/teams/accept-invites', {
        user_id: session.user.id,
        email: session.user.email,
      })
    } finally {
      navigate('/', { replace: true })
    }
  }

  const handleProfileContinue = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profileValid) return
    setProfileError('')
    setProfileSaving(true)
    try {
      const updateData: Record<string, unknown> = {}
      if (needsName && name.trim()) updateData.full_name = name.trim()
      if (needsPassword) updateData.password_set = true
      const update: Parameters<typeof supabase.auth.updateUser>[0] = { data: updateData }
      if (needsPassword) update.password = password
      const { error } = await supabase.auth.updateUser(update)
      if (error) { setProfileError(error.message); return }
      setNeedsPassword(false)
      setNeedsName(false)
      setNeedsSkills(true)
      // Credentials saved — now complete the accept
      await doAccept()
    } finally {
      setProfileSaving(false)
    }
  }

  const handleDecline = async () => {
    if (!invite) {
      if (isEstablishedUser) { navigate('/', { replace: true }); return }
      await supabase.auth.signOut()
      navigate('/login', { replace: true })
      return
    }
    setStep('declining')
    try {
      await api.post(`/teams/invites/${invite.id}/decline`)
    } catch {
      // Non-blocking
    }
    if (isEstablishedUser) {
      navigate('/', { replace: true })
    } else {
      await supabase.auth.signOut()
      navigate('/login', { replace: true })
    }
  }

  // ── Spinner ───────────────────────────────────────────────────────────────
  if (step === 'loading' || !session) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-5">
          <Layers size={36} className="text-purple-400 animate-pulse" />
          <p className="text-white font-semibold">Loading your invite…</p>
        </div>
      </div>
    )
  }

  if (step === 'accepting' || step === 'declining') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-5">
          <Layers size={36} className="text-purple-400 animate-pulse" />
          <p className="text-white font-semibold">
            {step === 'accepting' ? 'Joining the team…' : 'Declining invite…'}
          </p>
        </div>
      </div>
    )
  }

  // ── Step 2: Profile (name + password) — shown only after Accept is clicked ─
  if (step === 'profile') {
    const both = needsPassword && needsName
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-xl p-6 shadow-2xl">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-9 h-9 rounded-lg bg-purple-900/40 border border-purple-800/40 flex items-center justify-center shrink-0">
              {needsPassword ? <Lock size={16} className="text-purple-400" /> : <User size={16} className="text-purple-400" />}
            </div>
            <div>
              <h2 className="text-white font-semibold leading-tight">
                {both ? 'Complete your profile' : needsPassword ? 'Set your password' : "What's your name?"}
              </h2>
              <p className="text-gray-400 text-xs mt-0.5">
                {both
                  ? 'One last step before joining the team.'
                  : needsPassword
                  ? 'Set a password so you can sign in normally next time.'
                  : "We'll use this in your team profile."}
              </p>
            </div>
          </div>

          <form onSubmit={handleProfileContinue} className="space-y-4">
            {needsName && (
              <div>
                <label className="block text-sm text-gray-400 mb-1">Full name</label>
                <input
                  type="text"
                  required
                  autoFocus={!needsPassword}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Smith"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600"
                />
                {name.trim().length > 0 && name.trim().length < 4 && (
                  <p className="text-red-400 text-xs mt-1">Name must be at least 4 characters</p>
                )}
              </div>
            )}
            {needsPassword && (
              <>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Password</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoFocus={!needsName}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Confirm password</label>
                  <input
                    type="password"
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Repeat your password"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600"
                  />
                  {confirm.length > 0 && !passwordsMatch && (
                    <p className="text-red-400 text-xs mt-1">Passwords don't match</p>
                  )}
                </div>
              </>
            )}
            {profileError && <p className="text-red-400 text-sm">{profileError}</p>}
            <button
              type="submit"
              disabled={!profileValid || profileSaving}
              className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors"
            >
              {profileSaving ? 'Saving…' : 'Continue →'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ── Step 1: Invite confirmation card ───────────────────────────────────────
  // ── No pending invite ─────────────────────────────────────────────────────
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
            <span className="text-white capitalize">{resolveRole(invite.role)}</span>
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



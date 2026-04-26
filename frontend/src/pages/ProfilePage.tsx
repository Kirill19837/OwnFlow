import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { User, Lock, Trash2, ChevronLeft, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'
import { useTeamStore } from '../store/teamStore'
import { useCompanyStore } from '../store/companyStore'
import toast from 'react-hot-toast'

export default function ProfilePage() {
  const navigate = useNavigate()
  const { session, setSession, signOut } = useAuthStore()
  const { setTeams, setActiveTeam } = useTeamStore()
  const { setCompany } = useCompanyStore()
  const { company } = useCompanyStore()

  const currentName: string = session?.user?.user_metadata?.full_name ?? ''
  const currentEmail: string = session?.user?.email ?? ''
  const isCompanyOwner = !!(company && company.owner_id === session?.user?.id)

  // ── Name edit ──────────────────────────────────────────────────────────────
  const [name, setName] = useState(currentName)
  const [nameSaved, setNameSaved] = useState(false)
  const [nameLoading, setNameLoading] = useState(false)
  const [nameError, setNameError] = useState('')

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || trimmed === currentName) return
    setNameError('')
    setNameLoading(true)
    try {
      const { error } = await supabase.auth.updateUser({ data: { full_name: trimmed } })
      if (error) throw error
      const { data } = await supabase.auth.getSession()
      if (data.session) setSession(data.session)
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 2000)
      toast.success('Name updated')
    } catch (err: unknown) {
      setNameError((err as Error).message ?? 'Failed to update name')
    } finally {
      setNameLoading(false)
    }
  }

  // ── Password change ────────────────────────────────────────────────────────
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError] = useState('')
  const [pwSaved, setPwSaved] = useState(false)
  const passwordsMatch = password === confirm
  const passwordValid = password.length >= 8 && passwordsMatch

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!passwordValid) return
    setPwError('')
    setPwLoading(true)
    try {
      const { error } = await supabase.auth.updateUser({
        password,
        data: { password_set: true },
      })
      if (error) throw error
      setPassword('')
      setConfirm('')
      setPwSaved(true)
      setTimeout(() => setPwSaved(false), 2000)
      toast.success('Password updated')
    } catch (err: unknown) {
      setPwError((err as Error).message ?? 'Failed to change password')
    } finally {
      setPwLoading(false)
    }
  }

  // ── Delete account ─────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false)

  const deleteAccount = useMutation({
    mutationFn: () => api.delete(`/auth/account`),
    onSuccess: async () => {
      await supabase.auth.signOut()
      signOut()
      setTeams([])
      setActiveTeam(null)
      setCompany(null)
      toast.success('Account deleted')
      navigate('/login')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (err as Error).message
        ?? 'Failed to delete account'
      toast.error(msg)
      setConfirmDelete(false)
    },
  })

  return (
    <div className="max-w-xl mx-auto w-full px-6 py-10">
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-1 text-gray-400 hover:text-white text-sm mb-6 transition-colors"
      >
        <ChevronLeft size={16} /> Back
      </button>

      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-purple-900/40 border border-purple-800/40 flex items-center justify-center">
          <User size={18} className="text-purple-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">Profile</h1>
          <p className="text-gray-500 text-sm">{currentEmail}</p>
        </div>
      </div>

      <div className="space-y-6">
        {/* Name */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-white mb-4 flex items-center gap-2">
            <User size={15} className="text-purple-400" /> Display name
          </h2>
          <form onSubmit={handleSaveName} className="space-y-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600"
            />
            {nameError && <p className="text-red-400 text-xs">{nameError}</p>}
            <button
              type="submit"
              disabled={!name.trim() || name.trim() === currentName || nameLoading}
              className="flex items-center gap-1.5 px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
            >
              {nameSaved ? <><Check size={14} /> Saved</> : nameLoading ? 'Saving…' : 'Save name'}
            </button>
          </form>
        </section>

        {/* Password */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-white mb-4 flex items-center gap-2">
            <Lock size={15} className="text-purple-400" /> Change password
          </h2>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">New password</label>
              <input
                type="password"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat new password"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-600"
              />
              {confirm.length > 0 && !passwordsMatch && (
                <p className="text-red-400 text-xs mt-1">Passwords don't match</p>
              )}
            </div>
            {pwError && <p className="text-red-400 text-xs">{pwError}</p>}
            <button
              type="submit"
              disabled={!passwordValid || pwLoading}
              className="flex items-center gap-1.5 px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
            >
              {pwSaved ? <><Check size={14} /> Saved</> : pwLoading ? 'Saving…' : 'Update password'}
            </button>
          </form>
        </section>

        {/* Delete account */}
        <section className="bg-gray-900 border border-red-900/50 rounded-xl p-5">
          <h2 className="font-semibold text-red-400 mb-1 flex items-center gap-2">
            <Trash2 size={15} /> Delete account
          </h2>
          {isCompanyOwner ? (
            <p className="text-gray-500 text-sm">
              You are the owner of <span className="text-white font-medium">{company?.name}</span>. Delete the company first before deleting your account.
            </p>
          ) : (
            <>
              <p className="text-gray-500 text-sm mb-4">
                Permanently remove your account and all associated data. This cannot be undone.
              </p>
              {!confirmDelete ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-2 px-4 py-2 text-sm text-red-400 border border-red-800 rounded-lg hover:bg-red-900/30 transition-colors"
                >
                  <Trash2 size={14} /> Delete my account
                </button>
              ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  <p className="text-sm text-red-300">Are you sure? This is permanent.</p>
                  <button
                    onClick={() => deleteAccount.mutate()}
                    disabled={deleteAccount.isPending}
                    className="px-3 py-1.5 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {deleteAccount.isPending ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

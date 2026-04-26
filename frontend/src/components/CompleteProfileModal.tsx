import { useState } from 'react'
import { User, Lock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../store/authStore'
import toast from 'react-hot-toast'

export default function CompleteProfileModal() {
  const { needsPassword, needsName, setNeedsPassword, setNeedsName, setSession } = useAuthStore()

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const passwordsMatch = password === confirm
  const passwordValid = password.length >= 8 && passwordsMatch
  const nameValid = name.trim().length > 0
  const valid = (!needsName || nameValid) && (!needsPassword || passwordValid)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError('')
    setLoading(true)
    try {
      const update: Parameters<typeof supabase.auth.updateUser>[0] = {}
      if (needsPassword) update.password = password
      if (needsName) update.data = { full_name: name.trim() }

      const { error: updateError } = await supabase.auth.updateUser(update)
      if (updateError) throw updateError

      // Refresh session so header/store reflect the new name immediately
      const { data: sessionData } = await supabase.auth.getSession()
      if (sessionData.session) setSession(sessionData.session)

      if (needsPassword) setNeedsPassword(false)
      if (needsName) setNeedsName(false)

      const messages = []
      if (needsPassword) messages.push('password set')
      if (needsName) messages.push(`welcome, ${name.trim()}!`)
      toast.success(messages.join(' — ') || 'Profile updated')
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to save — please try again')
    } finally {
      setLoading(false)
    }
  }

  const both = needsPassword && needsName
  const title = both
    ? 'Complete your profile'
    : needsPassword
    ? 'Set your password'
    : "What’s your name?"
  const subtitle = both
    ? 'You signed in via a link — set a password and tell us your name to get started.'
    : needsPassword
    ? 'You signed in via a link — set a password so you can sign in normally next time.'
    : 'We’ll use this to personalise your experience and team activity.'

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg bg-purple-900/40 border border-purple-800/40 flex items-center justify-center shrink-0">
            {needsPassword ? <Lock size={16} className="text-purple-400" /> : <User size={16} className="text-purple-400" />}
          </div>
          <div>
            <h2 className="text-white font-semibold leading-tight">{title}</h2>
            <p className="text-gray-400 text-xs mt-0.5">{subtitle}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
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

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={!valid || loading}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors"
          >
            {loading ? 'Saving…' : 'Save & continue'}
          </button>
        </form>
      </div>
    </div>
  )
}

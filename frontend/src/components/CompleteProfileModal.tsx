import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { User, Lock } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { supabase } from '../lib/supabase'

export default function CompleteProfileModal() {
  const { needsPassword, needsName, linkType, setPendingProfile, setNeedsPassword, setNeedsName, setNeedsSkills } = useAuthStore()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const passwordsMatch = password === confirm
  const passwordValid = password.length >= 8 && passwordsMatch
  const nameValid = name.trim().length >= 4
  const valid = (!needsName || nameValid) && (!needsPassword || passwordValid)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError('')

    // Magic-link / set_password flow: user already has a company.
    // Save password + name immediately — do NOT navigate to /company/new.
    if (linkType === 'set_password') {
      setSaving(true)
      try {
        const updateData: Record<string, unknown> = { password_set: true }
        if (needsName && name.trim()) updateData.full_name = name.trim()
        const update: Parameters<typeof supabase.auth.updateUser>[0] = { data: updateData }
        if (needsPassword) update.password = password
        const { error: err } = await supabase.auth.updateUser(update)
        if (err) { setError(err.message); return }
        // Show skills selection next
        setNeedsSkills(true)
        setNeedsPassword(false)
        setNeedsName(false)
        // Modal unmounts — user stays on dashboard
      } finally {
        setSaving(false)
      }
      return
    }

    // Organic new-user flow: store name+password without saving — the atomic
    // save happens in NewCompanyPage when the user completes company setup.
    setPendingProfile({
      name: needsName ? name.trim() : '',
      password: needsPassword ? password : '',
    })
    navigate('/company/new')
  }

  const both = needsPassword && needsName
  const title = both
    ? 'Complete your profile'
    : needsPassword
    ? 'Set your password'
    : "What's your name?"
  const subtitle = both
    ? 'Set a password and your name — we\'ll save everything once you finish setup.'
    : needsPassword
    ? 'Set a password so you can sign in normally next time.'
    : "We'll use this to personalise your experience and team activity."

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

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={!valid || saving}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors"
          >
            {saving ? 'Saving…' : 'Continue →'}
          </button>
        </form>
      </div>
    </div>
  )
}
